/**
 * Conversation-First Composition — Task 07 / Phase 7
 *
 * Orchestration layer that wires ConversationStore, ConversationEngine,
 * CognitiveContextService into a single ConversationComposition.
 *
 * Key constraints:
 *  - Three entry points construct different ConversationSeed variants,
 *    then call the SAME createConversation → store.save().
 *  - UI reads from store; writes through this composition.
 *  - Zero WeeklyReviewRun, WeeklyOrchestrator, WeeklyPipelineState imports.
 */

import type { Conversation, ConversationSeed, ConversationStatus } from "./model";
import {
  createConversation,
  pauseConversation,
  resumeConversation,
  completeConversation,
  reopenConversation,
  appendTurn,
} from "./model";
import type { Clock } from "./model";
import type { ConversationStore } from "./store";
import type {
  ConversationTurnResult,
  ConfirmationResult,
} from "./engine";
import type {
  CognitiveContext,
  CognitiveContextRequest,
  ActiveGoalSummary,
  PendingFeedbackSummary,
} from "../context/cognitive-context";
import type { AiProvider } from "../ai/provider";
import type { MarkdownFileSystem } from "../storage/markdown";
import { generateWikiPage } from "../wiki/generator";
import { classifyConversationError } from "./error-classifier";

// ═══════════════════════════════════════════════════════════════════
// Optional service interfaces (goals/validations removed in note-driven PCC)
// ═══════════════════════════════════════════════════════════════════

export interface GoalIntegrationService {
  getActiveGoalsForContext(): Promise<ActiveGoalSummary[]>;
}

export interface ValidationIntegrationService {
  getPendingFeedbackForContext(): Promise<PendingFeedbackSummary[]>;
}

// ═══════════════════════════════════════════════════════════════════
// Engine-like interface (structural — satisfied by ConversationEngine)
// ═══════════════════════════════════════════════════════════════════

export interface ConversationEngineLike {
  sendMessage(
    conversation: Conversation,
    userText: string,
    context: CognitiveContext,
  ): Promise<ConversationTurnResult>;
  concludeConversation(
    conversation: Conversation,
    context: CognitiveContext,
  ): Promise<ConversationTurnResult>;
  handleConfirmationResponse(
    conversation: Conversation,
    userText: string,
    context: CognitiveContext,
  ): Promise<ConfirmationResult>;
  endWithoutConclusion(conversation: Conversation): Promise<Conversation>;
}

// ═══════════════════════════════════════════════════════════════════
// Context Service interface
// ═══════════════════════════════════════════════════════════════════

export interface CognitiveContextServiceLike {
  buildContext(request: CognitiveContextRequest): Promise<CognitiveContext>;
}

// ═══════════════════════════════════════════════════════════════════
// Public Types
// ═══════════════════════════════════════════════════════════════════

export interface ConversationComposition {
  // ── Conversation CRUD ──
  createConversation(seed: ConversationSeed): Promise<Conversation>;
  listConversations(): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  pauseConversation(id: string): Promise<Conversation>;
  resumeConversation(id: string): Promise<Conversation>;
  reopenConversation(id: string): Promise<Conversation>;
  endWithoutConclusion(id: string): Promise<Conversation>;

  // ── Dialogue Operations ──
  sendMessage(conversationId: string, userText: string): Promise<ConversationTurnResult>;
  concludeConversation(conversationId: string): Promise<ConversationTurnResult>;
  handleConfirmation(conversationId: string, userText: string): Promise<ConfirmationResult>;
  retryAfterFailure(conversationId: string): Promise<ConversationTurnResult>;

  // ── Context ──
  buildContext(conversationId: string): Promise<CognitiveContext>;

  // ── Dashboard ──
  getDashboardData(): Promise<ConversationDashboardData>;
}

export interface ConversationDashboardData {
  conversations: ConversationSummary[];
  goals: ActiveGoalSummary[];
  validations: PendingFeedbackSummary[];
  vaultReady: boolean;
}

export interface ConversationSummary {
  id: string;
  seedType: "free_question" | "current_note" | "weekly_topic";
  title: string;
  status: string;
  turnCount: number;
  updatedAt: string;
  hasPendingConfirmation: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Derive a human-readable title from a ConversationSeed.
 * Never exposes full question text as title — truncates safely.
 */
function deriveTitle(seed: ConversationSeed): string {
  switch (seed.kind) {
    case "free_question": {
      const q = seed.question;
      return q.length > 40 ? q.slice(0, 37) + "..." : q;
    }
    case "current_note":
      return `笔记: ${seed.note_path.split("/").pop() ?? seed.note_path}`;
    case "weekly_topic":
      return `主题: ${seed.topic_title}`;
  }
}

/**
 * Convert a Conversation to a ConversationSummary for the dashboard.
 */
function toSummary(conv: Conversation): ConversationSummary {
  return {
    id: conv.id,
    seedType: conv.seed.kind,
    title: deriveTitle(conv.seed),
    status: conv.status,
    turnCount: conv.turns.length,
    updatedAt: conv.updated_at,
    hasPendingConfirmation: conv.status === "awaiting_summary_confirmation",
  };
}

// ═══════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════

export interface ConversationCompositionDeps {
  store: ConversationStore;
  engine: ConversationEngineLike;
  contextService: CognitiveContextServiceLike;
  goalIntegration?: GoalIntegrationService;
  validationIntegration?: ValidationIntegrationService;
  aiProvider: AiProvider;
  clock: () => Date;
  /** Markdown filesystem for writing Wiki pages. */
  markdownFs: MarkdownFileSystem;
  /** Output directory for Wiki pages (e.g. "_Wiki"). */
  wikiOutputDir: string;
  /** Called after a Wiki page is generated, so the dashboard can refresh its cache.
   *  Passes the new page summary for direct cache insertion (avoids filesystem scan). */
  onWikiGenerated?: (newPage?: { path: string; title: string; created: string }) => void | Promise<void>;
}

export function createConversationComposition(
  deps: ConversationCompositionDeps,
): ConversationComposition {
  const { store, engine, contextService, goalIntegration, validationIntegration, clock: clockFn, markdownFs, wikiOutputDir, onWikiGenerated } = deps;
  const goals = goalIntegration ?? { getActiveGoalsForContext: async () => [] };
  const validations = validationIntegration ?? { getPendingFeedbackForContext: async () => [] };
  const clock: Clock = { now: clockFn };

  // ═══════════════════════════════════════════════════════════════
  // Conversation CRUD
  // ═══════════════════════════════════════════════════════════════

  async function doCreateConversation(seed: ConversationSeed): Promise<Conversation> {
    const conv = createConversation(seed, clock);
    store.save(conv);
    return conv;
  }

  async function doListConversations(): Promise<Conversation[]> {
    const all = store.list();
    // Sort by updated_at descending (most recent first)
    return [...all].sort(
      (a, b) => b.updated_at.localeCompare(a.updated_at),
    );
  }

  async function doGetConversation(id: string): Promise<Conversation | null> {
    return store.load(id);
  }

  async function doPauseConversation(id: string): Promise<Conversation> {
    const conv = store.load(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    const paused = pauseConversation(conv, clock);
    store.save(paused);
    return paused;
  }

  async function doResumeConversation(id: string): Promise<Conversation> {
    const conv = store.load(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    const resumed = resumeConversation(conv, clock);
    store.save(resumed);
    return resumed;
  }

  async function doReopenConversation(id: string): Promise<Conversation> {
    const conv = store.load(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    const reopened = reopenConversation(conv, clock);
    store.save(reopened);
    return reopened;
  }

  async function doEndWithoutConclusion(id: string): Promise<Conversation> {
    const conv = store.load(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    const ended = await engine.endWithoutConclusion(conv);
    store.save(ended);
    return ended;
  }

  // ═══════════════════════════════════════════════════════════════
  // Dialogue Operations
  // ═══════════════════════════════════════════════════════════════

  // Dedup cache: conversationId → turnIndex → ConversationTurnResult
  const dedupCache = new Map<string, ConversationTurnResult>();

  async function doSendMessage(
    conversationId: string,
    userText: string,
  ): Promise<ConversationTurnResult> {
    const conv = store.load(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    // ── Dedup check: same (conversationId, userText, turnIndex) ──
    const dedupKey = `${conversationId}:${conv.turns.length}:${userText}`;
    const cached = dedupCache.get(dedupKey);
    if (cached) {
      return cached;
    }

    // ── Persist user message FIRST (before AI call) ──
    const withUserTurn = appendTurn(conv, "user", userText, clock);
    try {
      store.save(withUserTurn);
    } catch (err) {
      const classified = classifyConversationError(err);
      throw new Error(`Failed to persist user message: ${classified.message}`);
    }

    // Build context
    let context: CognitiveContext;
    try {
      context = await contextService.buildContext({
        conversation: withUserTurn,
        query: userText,
      });
    } catch (err) {
      // Context build failure is non-fatal for message persistence;
      // user turn is already saved. Fall back to empty context.
      context = {
        vaultSnippets: [],
        wikiSnippets: [],
        exclusions: [],
        truncated: false,
        metadata: {
          vault_notes_scanned: 0,
          vault_notes_matched: 0,
          vault_notes_excluded: 0,
          wiki_pages_scanned: 0,
          wiki_pages_matched: 0,
          snippet_chars_used: 0,
          budget_exceeded: false,
        },
      };
    }

    // Enrich with goals and validations (non-critical — failures → empty)
    const [goals, validations] = await Promise.all([
      goals.getActiveGoalsForContext().catch(() => []),
      validations.getPendingFeedbackForContext().catch(() => []),
    ]);

    const enrichedContext: CognitiveContext = {
      ...context,
      activeGoals: goals,
      pendingValidations: validations,
    };

    // Call engine — if AI fails, user turn is already persisted
    let result: ConversationTurnResult;
    try {
      result = await engine.sendMessage(withUserTurn, userText, enrichedContext);
    } catch (err) {
      // AI failure: user turn is already saved in store.
      // Classify and re-throw with safe message.
      const classified = classifyConversationError(err);
      throw new Error(`AI call failed (${classified.category}): ${classified.message}. User message saved — you can retry.`);
    }

    // Persist updated conversation (with AI turn)
    try {
      store.save(result.conversation);
    } catch (err) {
      const classified = classifyConversationError(err);
      throw new Error(`Failed to persist AI response: ${classified.message}`);
    }

    // Cache for dedup
    dedupCache.set(dedupKey, result);

    return result;
  }

  async function doRetryAfterFailure(
    conversationId: string,
  ): Promise<ConversationTurnResult> {
    const conv = store.load(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    if (conv.status !== "active") {
      throw new Error(`Cannot retry: conversation is ${conv.status}, expected active`);
    }

    // Find the last user turn that hasn't received an AI response
    const lastTurn = conv.turns[conv.turns.length - 1];
    if (!lastTurn || lastTurn.role !== "user") {
      throw new Error("Cannot retry: last turn is not a user message");
    }

    const userText = lastTurn.text;

    // Build context for the retry
    let context: CognitiveContext;
    try {
      context = await contextService.buildContext({
        conversation: conv,
        query: userText,
      });
    } catch {
      context = {
        vaultSnippets: [],
        wikiSnippets: [],
        exclusions: [],
        truncated: false,
        metadata: {
          vault_notes_scanned: 0,
          vault_notes_matched: 0,
          vault_notes_excluded: 0,
          wiki_pages_scanned: 0,
          wiki_pages_matched: 0,
          snippet_chars_used: 0,
          budget_exceeded: false,
        },
      };
    }

    const [goals, validations] = await Promise.all([
      goals.getActiveGoalsForContext().catch(() => []),
      validations.getPendingFeedbackForContext().catch(() => []),
    ]);

    const enrichedContext: CognitiveContext = {
      ...context,
      activeGoals: goals,
      pendingValidations: validations,
    };

    // Call engine with the pre-existing user turn
    const result = await engine.sendMessage(conv, userText, enrichedContext);

    // Persist
    store.save(result.conversation);

    return result;
  }

  async function doHandleConfirmation(
    conversationId: string,
    userText: string,
  ): Promise<ConfirmationResult> {
    const conv = store.load(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    // Build context
    const context = await contextService.buildContext({
      conversation: conv,
      query: userText,
    });

    // Call engine to classify intent and handle
    const result = await engine.handleConfirmationResponse(conv, userText, context);

    store.save(result.conversation);

    // ── Wiki generation ──────────────────────────────────────
    // When the user confirms a conclusion, auto-generate a Wiki page.
    if (result.wikiConclution && result.action === "confirmed") {
      try {
        // Rebuild context using the FULL conversation text as query —
        // the confirmation-time context was built from a short "好的确认"
        // message which yields poor keyword matching. Using the full
        // conversation history finds genuinely related notes.
        const allTurnText = conv.turns
          .map((t) => t.text)
          .join("\n");
        const wikiContext = await contextService.buildContext({
          conversation: conv,
          query: allTurnText.slice(-2000), // last 2000 chars of conversation
        });

        // Merge: use wiki-context vault snippets + original context snippets
        const seen = new Set(context.vaultSnippets.map((s) => s.note_path));
        const mergedSnippets = [
          ...context.vaultSnippets,
          ...wikiContext.vaultSnippets.filter((s) => !seen.has(s.note_path)),
        ];

        const wikiTitle = deriveTitle(conv.seed);
        const wikiPath = `${wikiOutputDir}/${wikiTitle.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-")}.md`;

        await generateWikiPage(
          {
            title: wikiTitle,
            conclusion: result.wikiConclution,
            relatedNotes: mergedSnippets.map((s) => ({
              notePath: s.note_path,
              annotation: s.snippet.slice(0, 80),
            })),
            outputDir: wikiOutputDir,
          },
          markdownFs,
          clockFn,
        );

        // Notify composition layer to refresh its wiki cache
        if (onWikiGenerated) {
          try {
            await onWikiGenerated({
              path: wikiPath,
              title: wikiTitle,
              created: clockFn().toISOString().split("T")[0]!,
            });
          } catch { /* non-critical */ }
        }
      } catch (err) {
        // Wiki generation failure is non-fatal — conversation is already saved.
        console.error(
          "Composition: Wiki generation failed for conversation",
          conversationId,
          err,
        );
      }
    }

    return result;
  }

  async function doConcludeConversation(
    conversationId: string,
  ): Promise<ConversationTurnResult> {
    const conv = store.load(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    const context = await contextService.buildContext({ conversation: conv });
    const result = await engine.concludeConversation(conv, context);
    store.save(result.conversation);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // Context
  // ═══════════════════════════════════════════════════════════════

  async function doBuildContext(conversationId: string): Promise<CognitiveContext> {
    const conv = store.load(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    const context = await contextService.buildContext({ conversation: conv });

    const [goals, validations] = await Promise.all([
      goals.getActiveGoalsForContext().catch(() => []),
      validations.getPendingFeedbackForContext().catch(() => []),
    ]);

    return {
      ...context,
      activeGoals: goals,
      pendingValidations: validations,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Dashboard
  // ═══════════════════════════════════════════════════════════════

  async function doGetDashboardData(): Promise<ConversationDashboardData> {
    const conversations = store.list();
    const summaries: ConversationSummary[] = conversations
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(toSummary);

    const [goals, validations] = await Promise.all([
      goals.getActiveGoalsForContext().catch(() => []),
      validations.getPendingFeedbackForContext().catch(() => []),
    ]);

    return {
      conversations: summaries,
      goals,
      validations,
      vaultReady: true, // Always true if we can list conversations
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Assembly
  // ═══════════════════════════════════════════════════════════════

  return {
    createConversation: doCreateConversation,
    listConversations: doListConversations,
    getConversation: doGetConversation,
    pauseConversation: doPauseConversation,
    resumeConversation: doResumeConversation,
    reopenConversation: doReopenConversation,
    endWithoutConclusion: doEndWithoutConclusion,
    sendMessage: doSendMessage,
    concludeConversation: doConcludeConversation,
    handleConfirmation: doHandleConfirmation,
    retryAfterFailure: doRetryAfterFailure,
    buildContext: doBuildContext,
    getDashboardData: doGetDashboardData,
  };
}
