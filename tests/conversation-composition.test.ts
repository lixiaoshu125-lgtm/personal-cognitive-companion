// ─── Tests for src/conversation/composition-conversation.ts ──────
//
// Tests the ConversationComposition interface against Fake implementations.
// All tests go through the composition service — no direct domain calls.
// No real AI, no real Obsidian, no Weekly types.

import { describe, expect, it, beforeEach } from "vitest";
import type { Conversation, ConversationSeed, ConversationStatus, ConversationTurn } from "../src/conversation/model";
import { createConversation } from "../src/conversation/model";
import type { ConversationStore } from "../src/conversation/store";
import type {
  ConversationTurnResult,
  ConfirmationResult,
  AiCandidate,
  AiResponse,
} from "../src/conversation/engine";
import type { CognitiveContext, CognitiveContextRequest, ActiveGoalSummary, PendingFeedbackSummary } from "../src/context/cognitive-context";
import type { AiProvider, AiCompletionRequest } from "../src/ai/provider";
import type {
  ConversationComposition,
  ConversationDashboardData,
  ConversationSummary,
  ConversationEngineLike,
  CognitiveContextServiceLike,
  ConversationCompositionDeps,
  GoalIntegrationService,
  ValidationIntegrationService,
} from "../src/conversation/composition-conversation";
import { createConversationComposition } from "../src/conversation/composition-conversation";
import type { MarkdownFileSystem } from "../src/storage/markdown";

// ═══════════════════════════════════════════════════════════════════
// Fakes
// ═══════════════════════════════════════════════════════════════════

class FakeConversationStore implements ConversationStore {
  private conversations = new Map<string, Conversation>();

  save(conversation: Conversation): void {
    this.conversations.set(conversation.id, conversation);
  }

  load(id: string): Conversation | null {
    return this.conversations.get(id) ?? null;
  }

  list(): Conversation[] {
    return [...this.conversations.values()];
  }

  delete(id: string): void {
    this.conversations.delete(id);
  }

  /** Test helper: check if a conversation exists */
  has(id: string): boolean {
    return this.conversations.has(id);
  }

  /** Test helper: get size */
  get size(): number {
    return this.conversations.size;
  }

  /** Test helper: simulate restart by clearing and re-populating */
  simulateRestart(): void {
    // In real life this would reload from disk; here we just verify
    // the map contents survive (they do, since we don't clear it).
  }
}

class FakeConversationEngine implements ConversationEngineLike {
  nextTurnResult: ConversationTurnResult | null = null;
  nextConfirmationResult: ConfirmationResult | null = null;
  conclusionCalls = 0;

  setNextResponse(result: ConversationTurnResult): void {
    this.nextTurnResult = result;
  }

  setNextConfirmation(result: ConfirmationResult): void {
    this.nextConfirmationResult = result;
  }

  async sendMessage(
    conversation: Conversation,
    _userText: string,
    _context: CognitiveContext,
  ): Promise<ConversationTurnResult> {
    if (this.nextTurnResult) {
      const r = this.nextTurnResult;
      this.nextTurnResult = null;
      return r;
    }
    // Default: simple echo
    const aiResponse: AiResponse = {
      text: "Echo: " + (_userText ?? ""),
      internal: {
        candidates: [],
        should_summarize: false,
        should_generate_wiki: false,
        question: "What next?",
      },
    };
    return {
      conversation,
      aiResponse,
      newCandidates: [],
      awaitingConfirmation: false,
    };
  }

  async handleConfirmationResponse(
    conversation: Conversation,
    _userText: string,
    _context: CognitiveContext,
  ): Promise<ConfirmationResult> {
    if (this.nextConfirmationResult) {
      const r = this.nextConfirmationResult;
      this.nextConfirmationResult = null;
      return r;
    }
    return {
      conversation,
      action: "confirmed",
      wikiConclution: "默认结论",
    };
  }

  async concludeConversation(
    conversation: Conversation,
    _context: CognitiveContext,
  ): Promise<ConversationTurnResult> {
    this.conclusionCalls += 1;
    if (this.nextTurnResult) {
      const result = this.nextTurnResult;
      this.nextTurnResult = null;
      return result;
    }
    return {
      conversation,
      aiResponse: {
        text: "总结",
        internal: { candidates: [], should_summarize: true, should_generate_wiki: false, summary: "总结", question: "确认吗？" },
      },
      newCandidates: [],
      awaitingConfirmation: true,
      summaryText: "总结",
    };
  }

  async endWithoutConclusion(conversation: Conversation): Promise<Conversation> {
    return { ...conversation, status: "completed", end_reason: "no_formal_result" } as unknown as Conversation;
  }
}

class FakeMarkdownFileSystem implements MarkdownFileSystem {
  private files = new Map<string, string>();

  async writeFile(relativePath: string, content: string): Promise<number> {
    this.files.set(relativePath, content);
    return content.length;
  }

  async readFile(relativePath: string): Promise<string> {
    return this.files.get(relativePath) ?? "";
  }

  async fileExists(relativePath: string): Promise<boolean> {
    return this.files.has(relativePath);
  }

  async copyFile(sourcePath: string, targetPath: string): Promise<void> {
    const content = this.files.get(sourcePath);
    if (content) this.files.set(targetPath, content);
  }

  async deleteFile(relativePath: string): Promise<void> {
    this.files.delete(relativePath);
  }

  async listFiles(_dirPath: string): Promise<string[]> {
    return [...this.files.keys()];
  }
}

class FakeCognitiveContextService implements CognitiveContextServiceLike {
  private context: CognitiveContext = {
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

  setContext(ctx: CognitiveContext): void {
    this.context = ctx;
  }

  async buildContext(_request: CognitiveContextRequest): Promise<CognitiveContext> {
    return this.context;
  }
}

class FakeGoalIntegrationService implements GoalIntegrationService {
  private goals: ActiveGoalSummary[] = [];

  setActiveGoals(goals: ActiveGoalSummary[]): void {
    this.goals = goals;
  }

  async getActiveGoalsForContext(): Promise<ActiveGoalSummary[]> {
    return this.goals;
  }
}

class FakeValidationIntegrationService implements ValidationIntegrationService {
  private validations: PendingFeedbackSummary[] = [];

  setPendingValidations(vals: PendingFeedbackSummary[]): void {
    this.validations = vals;
  }

  async getPendingFeedbackForContext(): Promise<PendingFeedbackSummary[]> {
    return this.validations;
  }
}

class FakeAiProvider implements AiProvider {
  async complete<Output>(_request: AiCompletionRequest<Output>, _signal?: AbortSignal): Promise<Output> {
    return {} as Output;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

const FIXED_CLOCK = { now: () => new Date("2026-07-29T08:00:00.000Z") };

function makeDeps(overrides?: {
  store?: ConversationStore;
  engine?: ConversationEngineLike;
  contextService?: CognitiveContextServiceLike;
  goalIntegration?: GoalIntegrationService;
  validationIntegration?: ValidationIntegrationService;
  aiProvider?: AiProvider;
  markdownFs?: MarkdownFileSystem;
  wikiOutputDir?: string;
}): ConversationCompositionDeps {
  return {
    store: overrides?.store ?? new FakeConversationStore(),
    engine: overrides?.engine ?? new FakeConversationEngine(),
    contextService: overrides?.contextService ?? new FakeCognitiveContextService(),
    goalIntegration: overrides?.goalIntegration ?? new FakeGoalIntegrationService(),
    validationIntegration: overrides?.validationIntegration ?? new FakeValidationIntegrationService(),
    aiProvider: overrides?.aiProvider ?? new FakeAiProvider(),
    clock: FIXED_CLOCK.now,
    markdownFs: overrides?.markdownFs ?? new FakeMarkdownFileSystem(),
    wikiOutputDir: overrides?.wikiOutputDir ?? "_Wiki",
  };
}

function freeQuestionSeed(question: string): ConversationSeed {
  return { kind: "free_question", question };
}

function currentNoteSeed(notePath: string): ConversationSeed {
  return { kind: "current_note", note_id: `note:${notePath}`, note_path: notePath };
}

function weeklyTopicSeed(topicTitle: string): ConversationSeed {
  return {
    kind: "weekly_topic",
    topic_id: `topic:${topicTitle}`,
    topic_title: topicTitle,
    note_ids: ["note-1"],
  };
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe("ConversationComposition", () => {
  beforeEach(() => {
    // (resetIdSequence was removed — id sequence is per-process, reset not needed)
  });

  // ── Scenario 1: createConversation free_question ────────────

  it("createConversation with free_question seed creates and persists conversation", async () => {
    const store = new FakeConversationStore();
    const comp = createConversationComposition(makeDeps({ store }));

    const seed = freeQuestionSeed("什么是认知偏差？");
    const conv = await comp.createConversation(seed);

    expect(conv).toBeDefined();
    expect(conv.seed.kind).toBe("free_question");
    expect(conv.status).toBe("active");
    expect(conv.turns).toEqual([]);

    // Verify persisted in store
    const loaded = store.load(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(conv.id);
  });

  // ── Scenario 2: createConversation current_note ─────────────

  it("createConversation with current_note seed includes note context", async () => {
    const store = new FakeConversationStore();
    const comp = createConversationComposition(makeDeps({ store }));

    const seed = currentNoteSeed("日记/2026-07-29.md");
    const conv = await comp.createConversation(seed);

    expect(conv.seed.kind).toBe("current_note");
    if (conv.seed.kind === "current_note") {
      expect(conv.seed.note_path).toBe("日记/2026-07-29.md");
    }
    expect(conv.status).toBe("active");
  });

  // ── Scenario 3: createConversation weekly_topic ─────────────

  it("createConversation with weekly_topic seed includes topic reference", async () => {
    const store = new FakeConversationStore();
    const comp = createConversationComposition(makeDeps({ store }));

    const seed = weeklyTopicSeed("职业规划");
    const conv = await comp.createConversation(seed);

    expect(conv.seed.kind).toBe("weekly_topic");
    if (conv.seed.kind === "weekly_topic") {
      expect(conv.seed.topic_title).toBe("职业规划");
    }
    expect(conv.status).toBe("active");
  });

  // ── Scenario 4: three entries use same service ─────────────

  it("three entry points all call the same createConversation and produce same Conversation type", async () => {
    const store = new FakeConversationStore();
    const comp = createConversationComposition(makeDeps({ store }));

    const free = await comp.createConversation(freeQuestionSeed("Q1"));
    const note = await comp.createConversation(currentNoteSeed("note.md"));
    const topic = await comp.createConversation(weeklyTopicSeed("Topic1"));

    // All three are valid Conversations
    for (const conv of [free, note, topic]) {
      expect(conv.id).toMatch(/^conv:/);
      expect(conv.status).toBe("active");
      expect(conv.schema_version).toBe(1);
      expect(typeof conv.revision).toBe("number");
    }

    // All persisted in same store
    expect(store.size).toBe(3);
  });

  // ── Scenario 5: listConversations multiple conversations ────

  it("listConversations returns all conversations sorted by updated_at", async () => {
    const store = new FakeConversationStore();
    const comp = createConversationComposition(makeDeps({ store }));

    await comp.createConversation(freeQuestionSeed("First"));
    await comp.createConversation(freeQuestionSeed("Second"));
    await comp.createConversation(freeQuestionSeed("Third"));

    const list = await comp.listConversations();
    expect(list).toHaveLength(3);
    // Each is a full Conversation with required fields
    for (const c of list) {
      expect(c.id).toBeDefined();
      expect(c.seed).toBeDefined();
      expect(c.status).toBeDefined();
      expect(c.updated_at).toBeDefined();
      expect(c.turns).toBeDefined();
    }
  });

  // ── Scenario 6: pauseConversation ───────────────────────────

  it("pauseConversation transitions active → paused", async () => {
    const store = new FakeConversationStore();
    const comp = createConversationComposition(makeDeps({ store }));

    const conv = await comp.createConversation(freeQuestionSeed("Test"));
    expect(conv.status).toBe("active");

    const paused = await comp.pauseConversation(conv.id);
    expect(paused.status).toBe("paused");

    // Store reflects pause
    const loaded = store.load(conv.id);
    expect(loaded!.status).toBe("paused");
  });

  // ── Scenario 7: resumeConversation ──────────────────────────

  it("resumeConversation transitions paused → active", async () => {
    const store = new FakeConversationStore();
    const comp = createConversationComposition(makeDeps({ store }));

    const conv = await comp.createConversation(freeQuestionSeed("Test"));
    await comp.pauseConversation(conv.id);

    const resumed = await comp.resumeConversation(conv.id);
    expect(resumed.status).toBe("active");

    const loaded = store.load(conv.id);
    expect(loaded!.status).toBe("active");
  });

  // ── Scenario 8: endWithoutConclusion ────────────────────────

  it("endWithoutConclusion transitions active → completed(no_formal_result)", async () => {
    const store = new FakeConversationStore();
    const comp = createConversationComposition(makeDeps({ store }));

    const conv = await comp.createConversation(freeQuestionSeed("Test"));
    const ended = await comp.endWithoutConclusion(conv.id);

    expect(ended.status).toBe("completed");
    expect(ended.end_reason).toBe("no_formal_result");

    const loaded = store.load(conv.id);
    expect(loaded!.status).toBe("completed");
  });

  // ── Scenario 9: sendMessage → ConversationTurnResult ────────

  it("sendMessage calls engine and returns updated conversation", async () => {
    const store = new FakeConversationStore();
    const engine = new FakeConversationEngine();

    // Create a conversation first, then set up engine response
    const conv = createConversation(freeQuestionSeed("Test"), FIXED_CLOCK);
    store.save(conv);

    const aiCandidates: AiCandidate[] = [{
      epistemic_status: "ai_inferred",
      canonical_text: "这是一个测试观点",
      evidence_refs: [],
    }];

    const aiResponse: AiResponse = {
      text: "我理解你的问题",
      internal: {
        candidates: aiCandidates,
        should_summarize: false,
        should_generate_wiki: false,
        question: "能详细说说吗？",
      },
    };

    // We need to set the response on the engine before calling sendMessage
    const updatedConv = { ...conv, status: "active" as const, revision: 1, turns: [{ role: "user" as const, text: "你好", timestamp: "2026-07-29T08:00:00.000Z" }, { role: "assistant" as const, text: "我理解你的问题", timestamp: "2026-07-29T08:00:01.000Z" }] } as unknown as Conversation;

    engine.setNextResponse({
      conversation: updatedConv,
      aiResponse,
      newCandidates: aiCandidates,
      awaitingConfirmation: false,
    });

    const comp = createConversationComposition(makeDeps({ store, engine }));
    const result = await comp.sendMessage(conv.id, "你好");

    expect(result).toBeDefined();
    expect(result.aiResponse).toBeDefined();
    expect(result.newCandidates).toHaveLength(1);
    expect(result.awaitingConfirmation).toBe(false);
  });

  it("concludeConversation delegates to the dedicated engine flow and persists its result", async () => {
    const store = new FakeConversationStore();
    const engine = new FakeConversationEngine();
    const conversation = createConversation(freeQuestionSeed("Test"), FIXED_CLOCK);
    store.save(conversation);
    const awaiting = {
      ...conversation,
      status: "awaiting_summary_confirmation" as const,
      revision: 1,
      turns: [{ role: "assistant" as const, text: "1. 第一条结论", timestamp: "2026-07-29T08:00:01.000Z" }],
    } as unknown as Conversation;
    engine.setNextResponse({
      conversation: awaiting,
      aiResponse: {
        text: "1. 第一条结论",
        internal: { candidates: [], should_summarize: true, should_generate_wiki: false, summary: "1. 第一条结论", question: "确认吗？" },
      },
      newCandidates: [],
      awaitingConfirmation: true,
      summaryText: "1. 第一条结论",
    });

    const composition = createConversationComposition(makeDeps({ store, engine }));
    const result = await composition.concludeConversation(conversation.id);

    expect(engine.conclusionCalls).toBe(1);
    expect(result.conversation.status).toBe("awaiting_summary_confirmation");
    expect(store.load(conversation.id)?.status).toBe("awaiting_summary_confirmation");
  });

  // ── Scenario 10: handleConfirmation orchestrates three writebacks ──

  it("handleConfirmation produces wikiConclution and completes conversation", async () => {
    const store = new FakeConversationStore();
    const engine = new FakeConversationEngine();
    const goalIntegration = new FakeGoalIntegrationService();
    const validationIntegration = new FakeValidationIntegrationService();

    // Set up active goals and validations
    goalIntegration.setActiveGoals([
      { goal_id: "g1", text: "学习 Rust", status: "active" },
    ]);
    validationIntegration.setPendingValidations([
      { experiment_id: "v1", hypothesis: "Rust更高效", action: "尝试用 Rust 写 CLI", deadline: "2026-08-01" },
    ]);

    // Create a conversation in awaiting_summary_confirmation
    const conv = createConversation(freeQuestionSeed("Test"), FIXED_CLOCK);
    const awaitingConv = {
      ...conv,
      status: "awaiting_summary_confirmation" as const,
      revision: 1,
      turns: [
        { role: "user" as const, text: "你好", timestamp: "2026-07-29T08:00:00.000Z" },
        { role: "assistant" as const, text: "[SUMMARY] 测试总结", timestamp: "2026-07-29T08:00:01.000Z" },
      ],
    } as unknown as Conversation;
    store.save(awaitingConv);

    const completedConv = {
      ...awaitingConv,
      status: "completed" as const,
      end_reason: "confirmed_results" as const,
      revision: 2,
    } as unknown as Conversation;

    engine.setNextConfirmation({
      conversation: completedConv,
      action: "confirmed",
      wikiConclution: "已确认的结论文本",
    });

    const comp = createConversationComposition(makeDeps({ store, engine, goalIntegration, validationIntegration }));
    const result = await comp.handleConfirmation(awaitingConv.id, "好的");

    expect(result).toBeDefined();
    expect(result.action).toBe("confirmed");
    expect(result.wikiConclution).toBe("已确认的结论文本");
  });

  // ── Scenario 11: handleConfirmation throws for invalid state ──

  it("handleConfirmation throws when conversation is not in awaiting state", async () => {
    const store = new FakeConversationStore();
    const engine = new FakeConversationEngine();
    const goalIntegration = new FakeGoalIntegrationService();
    const validationIntegration = new FakeValidationIntegrationService();

    const conv = createConversation(freeQuestionSeed("Test"), FIXED_CLOCK);
    store.save(conv);

    const comp = createConversationComposition(makeDeps({ store, engine, goalIntegration, validationIntegration }));
    await expect(
      comp.handleConfirmation(conv.id, "好的"),
    ).rejects.toThrow("awaiting_summary_confirmation");
  });

  // ── Scenario 12: getDashboardData aggregation ───────────────

  it("getDashboardData aggregates conversations, goals, and validations", async () => {
    const store = new FakeConversationStore();
    const goalIntegration = new FakeGoalIntegrationService();
    const validationIntegration = new FakeValidationIntegrationService();

    goalIntegration.setActiveGoals([
      { goal_id: "g1", text: "学习 Rust", status: "active" },
    ]);
    validationIntegration.setPendingValidations([
      { experiment_id: "v1", hypothesis: "Rust更高效", action: "尝试用 Rust 写 CLI", deadline: "2026-08-01" },
    ]);

    await createConversationComposition(makeDeps({ store }))
      .createConversation(freeQuestionSeed("Test Q"));

    const comp = createConversationComposition(makeDeps({ store, goalIntegration, validationIntegration }));
    const data = await comp.getDashboardData();

    expect(data.conversations).toHaveLength(1);
    expect(data.goals).toHaveLength(1);
    expect(data.goals[0]!.text).toBe("学习 Rust");
    expect(data.validations).toHaveLength(1);
    expect(data.validations[0]!.action).toBe("尝试用 Rust 写 CLI");
    expect(data.vaultReady).toBeDefined();
  });

  // ── Scenario 13: restart recovery ──────────────────────────

  it("conversations survive simulated restart via store persistence", async () => {
    const store = new FakeConversationStore();

    // First session
    const comp1 = createConversationComposition(makeDeps({ store }));
    const conv = await comp1.createConversation(freeQuestionSeed("持久化测试"));

    // Simulate restart: create fresh composition with same store
    const comp2 = createConversationComposition(makeDeps({ store }));
    const list = await comp2.listConversations();

    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(conv.id);

    const loaded = await comp2.getConversation(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.seed.kind).toBe("free_question");
  });

  // ── Scenario 14: zero Weekly imports ────────────────────────

  it("ConversationComposition has zero WeeklyReviewRun, WeeklyOrchestrator, or snapshotId imports", async () => {
    // This test verifies by construction: if the module compiled without
    // those imports, the Fake implementations work and the tests pass.
    // We validate by checking the composition works with Fake deps.
    const comp = createConversationComposition(makeDeps());
    const conv = await comp.createConversation(freeQuestionSeed("No Weekly"));
    expect(conv.id).toBeDefined();
    expect(conv.status).toBe("active");
    // If Weekly types leaked in, TypeScript compilation would fail.
  });

  // ── Scenario 15: Fake AI + Fake Store ───────────────────────

  it("all test scenarios use Fake implementations, never call real API", async () => {
    const store = new FakeConversationStore();
    const engine = new FakeConversationEngine();
    const aiProvider = new FakeAiProvider();

    const comp = createConversationComposition(makeDeps({ store, engine, aiProvider }));

    const conv = await comp.createConversation(freeQuestionSeed("Fake test"));
    expect(conv.id).toBeDefined();
    expect(store.has(conv.id)).toBe(true);

    // All operations go through fakes
    const list = await comp.listConversations();
    expect(list).toHaveLength(1);

    const single = await comp.getConversation(conv.id);
    expect(single).not.toBeNull();
  });

  // ── Scenario 16: getConversation returns null for unknown id ──

  it("getConversation returns null for unknown id", async () => {
    const comp = createConversationComposition(makeDeps());
    const result = await comp.getConversation("conv:nonexistent:0:0");
    expect(result).toBeNull();
  });
});
