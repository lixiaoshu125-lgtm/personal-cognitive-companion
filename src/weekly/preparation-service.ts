/**
 * WeeklyPreparationService — Task 08
 *
 * Replaces the old WeeklyOrchestrator's dialogue state machine with a
 * manual topic preparation and backlog management service.
 *
 * Key constraints:
 *  - No pipeline phases, no currentTopicIndex, no WeeklyPipelineState.
 *  - No Conversation internal state mutations.
 *  - No enforced topic queue order.
 *  - AI is only called when the user explicitly triggers preparation.
 *  - Topic state is tracked per topic, not per note.
 */

import type { AiProvider } from "../ai/provider";
import type { VaultAdapter } from "../vault/adapter";
import type { NoteRef } from "../vault/scanner";
import { scanVault } from "../vault/scanner";
import {
  buildTopicPreparationPrompt,
  preparedTopicsSchema,
  type NoteSummary,
  type PreparedTopicsAiOutput,
} from "./topic-ai";
import type { WeeklyPreparationStore } from "./preparation-store";
import { getWeekId } from "./orchestrator";
import { fetchNewsHeadlines } from "../news/fetcher";

// ═══════════════════════════════════════════════════════════════
// TopicStatus
// ═══════════════════════════════════════════════════════════════

export type TopicStatus =
  | "pending"       // not yet discussed
  | "in_progress"   // has an unfinished Conversation
  | "discussed"     // related Conversation ended (with or without formal claims)
  | "snoozed"       // user explicitly said "later"
  | "dismissed";    // user explicitly said "not worth discussing further"

// ═══════════════════════════════════════════════════════════════
// PreparedTopic — AI-generated candidate topic
// ═══════════════════════════════════════════════════════════════

export interface PreparedTopic {
  readonly topic_id: string;
  readonly source_note_id: string | null;  // null = cross-note topic
  readonly title: string;
  readonly description: string;
  readonly representative_excerpts: readonly string[];
  readonly relevance_score: number;        // 0–1
  /** Whether this topic was derived from news headlines. */
  readonly is_news_related: boolean;
  readonly status: TopicStatus;
  readonly created_week_id: string;
  readonly created_at: string;             // ISO timestamp
  readonly last_status_change: string;     // ISO timestamp
  readonly conversation_id?: string;       // only when in_progress/discussed
}

// ═══════════════════════════════════════════════════════════════
// WeeklyPreparationState — persisted state
// ═══════════════════════════════════════════════════════════════

export interface WeeklyPreparationState {
  readonly schema_version: number;          // initial 1
  readonly current_week_id: string;
  readonly topics: readonly PreparedTopic[];
  readonly last_scan_week_id?: string;
  readonly scan_note_count?: number;
}

// ═══════════════════════════════════════════════════════════════
// Public result types
// ═══════════════════════════════════════════════════════════════

export interface NewWeekStatus {
  readonly isNewWeek: boolean;
  readonly currentWeekId: string;
  readonly message?: string;
}

export interface WeeklyPreparationResult {
  readonly weekId: string;
  readonly newTopics: PreparedTopic[];
  readonly mergedTopics: PreparedTopic[];
  readonly totalCandidateCount: number;
  readonly newNoteCount: number;
  readonly message: string;
}

export type WeeklyPreparationProgress =
  | {
      readonly phase: "scanning" | "summarizing";
      readonly current: number;
      readonly total: number;
      readonly noteTitle: string;
    }
  | {
      readonly phase: "generating_topics";
      readonly noteCount: number;
    };

export type WeeklyPreparationProgressListener = (
  progress: WeeklyPreparationProgress,
) => void;

// ═══════════════════════════════════════════════════════════════
// Service interface
// ═══════════════════════════════════════════════════════════════

export interface WeeklyPreparationService {
  // ── Week reminder ──
  checkNewWeek(): NewWeekStatus;

  // ── Topic scan & preparation ──
  prepareWeeklyTopics(
    onProgress?: WeeklyPreparationProgressListener,
  ): Promise<WeeklyPreparationResult>;

  // ── Topic queries ──
  listTopics(filter?: { status?: TopicStatus[] }): Promise<PreparedTopic[]>;
  getWeeklyCandidates(weekId?: string): Promise<PreparedTopic[]>;
  getBacklogTopics(): Promise<PreparedTopic[]>;

  // ── Topic status transitions ──
  markTopicInProgress(topicId: string, conversationId: string): Promise<void>;
  markTopicDiscussed(topicId: string): Promise<void>;
  snoozeTopic(topicId: string): Promise<void>;
  dismissTopic(topicId: string): Promise<void>;
  resetTopicForRediscuss(topicId: string): Promise<void>;

  // ── Persistence ──
  getState(): WeeklyPreparationState;
  restore(state: WeeklyPreparationState): void;
}

// ═══════════════════════════════════════════════════════════════
// Dependencies
// ═══════════════════════════════════════════════════════════════

export interface WeeklyPreparationDeps {
  readonly vaultAdapter: VaultAdapter;
  readonly aiProvider: AiProvider;
  readonly store: WeeklyPreparationStore;
  readonly excludedDirs: readonly string[];
  readonly maxTopics: number;
  readonly clock: () => Date;
  /** NewsAPI key (empty = skip news fetch). */
  readonly newsApiKey: string;
  /** Comma-separated news source domains. */
  readonly newsApiSources: string;
}

// ═══════════════════════════════════════════════════════════════
// Deep-freeze helper
// ═══════════════════════════════════════════════════════════════

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? ReadonlyArray<DeepReadonly<Item>>
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

// ═══════════════════════════════════════════════════════════════
// ID generation
// ═══════════════════════════════════════════════════════════════

let topicIdSeq = 0;

function generateTopicId(weekId: string): string {
  const seq = (topicIdSeq++).toString(36);
  const rand = Math.floor(Math.random() * 46656).toString(36);
  return `topic:${weekId}:${seq}:${rand}`;
}

/** Exposed for tests that need deterministic IDs. */
export function resetTopicIdSequence(): void {
  topicIdSeq = 0;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Compute a dedup key from note_id + title.
 * Same note + same title → same topic (idempotent).
 */
function dedupKey(noteId: string | null, title: string): string {
  return `${noteId ?? "__cross_note__"}\0${title}`;
}

/**
 * Extract up to `maxChars` code points from the start of a note body
 * to serve as a summary excerpt for AI prompt building.
 */
function extractExcerpt(body: string, maxChars: number): string {
  const codePoints = Array.from(body);
  if (codePoints.length <= maxChars) return body;
  return codePoints.slice(0, maxChars).join("");
}

/**
 * Build a NoteSummary array from scanned NoteRefs and a body reader.
 */
async function buildNoteSummaries(
  notes: readonly NoteRef[],
  readBody: (path: string) => Promise<string>,
  onProgress?: WeeklyPreparationProgressListener,
): Promise<NoteSummary[]> {
  const results: NoteSummary[] = [];
  for (const [index, note] of notes.entries()) {
    const title = note.path.split("/").pop() ?? note.path;
    onProgress?.({
      phase: "summarizing",
      current: index + 1,
      total: notes.length,
      noteTitle: title,
    });
    const body = await readBody(note.path);
    results.push({
      noteId: note.id,
      path: note.path,
      title,
      excerpt: extractExcerpt(body, 300),
    });
  }
  return results;
}

/**
 * Check if a topic is a duplicate of an existing one.
 */
function isDuplicate(newTopic: { source_note_id: string | null; title: string }, existing: PreparedTopic): boolean {
  return dedupKey(newTopic.source_note_id, newTopic.title) === dedupKey(existing.source_note_id, existing.title);
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

export async function createWeeklyPreparationService(
  deps: WeeklyPreparationDeps,
): Promise<WeeklyPreparationService> {
  const { vaultAdapter, aiProvider, store, excludedDirs, maxTopics, clock } = deps;

  // ── Internal state (loaded from store on creation) ──────────

  let state: WeeklyPreparationState;

  // Load existing state from store at construction time
  const loaded = await store.load();
  if (loaded !== null) {
    state = loaded;
  } else {
    const now = clock();
    state = deepFreeze({
      schema_version: 1,
      current_week_id: getWeekId(now),
      topics: [],
    }) as unknown as WeeklyPreparationState;
  }

  // ── Persist helper ──────────────────────────────────────────

  async function persist(): Promise<void> {
    await store.save(state);
  }

  // ── checkNewWeek ────────────────────────────────────────────

  function checkNewWeek(): NewWeekStatus {
    const now = clock();
    const currentWeekId = getWeekId(now);
    const isNewWeek = currentWeekId !== state.current_week_id;

    if (isNewWeek) {
      return {
        isNewWeek,
        currentWeekId,
        message: `新的一周开始了（${currentWeekId}），可以准备本周回顾主题。`,
      };
    }
    return {
      isNewWeek,
      currentWeekId,
    };
  }

  // ── prepareWeeklyTopics ─────────────────────────────────────

  async function prepareWeeklyTopics(
    onProgress?: WeeklyPreparationProgressListener,
  ): Promise<WeeklyPreparationResult> {
    const now = clock();
    const weekId = getWeekId(now);

    // 1. Scan vault for notes
    const notes = await scanVault(
      vaultAdapter,
      [...excludedDirs],
      ({ current, total, path }) => {
        onProgress?.({
          phase: "scanning",
          current,
          total,
          noteTitle: path.split("/").pop() ?? path,
        });
      },
    );
    const noteSummaries = await buildNoteSummaries(
      notes,
      (path) => vaultAdapter.readText(path),
      onProgress,
    );

    // 2. Build backlog: pending + snoozed topics from previous weeks
    const backlogTopics = state.topics.filter(
      (t) =>
        (t.status === "pending" || t.status === "snoozed") &&
        t.created_week_id !== weekId,
    );

    // 3. Fetch news headlines (non-blocking — empty array on failure)
    const headlines = await fetchNewsHeadlines({
      apiKey: deps.newsApiKey,
      sources: deps.newsApiSources || undefined,
      maxItems: 10,
    });

    // 4. Call AI to generate/merge/sort topics
    const request = buildTopicPreparationPrompt({
      newNotes: noteSummaries,
      backlogTopics,
      newsHeadlines: headlines,
      maxTopics,
    });

    onProgress?.({ phase: "generating_topics", noteCount: notes.length });

    let aiOutput: PreparedTopicsAiOutput;
    try {
      aiOutput = await aiProvider.complete(request);
    } catch {
      throw new Error("AI topic preparation failed");
    }

    const parsed = preparedTopicsSchema.safeParse(aiOutput);
    if (!parsed.success) {
      throw new Error(
        `Invalid AI topic output: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }

    // 5. Convert AI output to PreparedTopics
    const nowIso = now.toISOString();
    const newTopics: PreparedTopic[] = [];
    const seenDedupKeys = new Set<string>();

    for (const aiTopic of parsed.data.topics) {
      const key = dedupKey(aiTopic.source_note_id ?? null, aiTopic.title);

      // Skip if already seen in this batch
      if (seenDedupKeys.has(key)) continue;
      seenDedupKeys.add(key);

      // Skip if duplicate of existing topic (same note + same title)
      const isExistingDup = state.topics.some((t) =>
        dedupKey(t.source_note_id, t.title) === key &&
        t.status !== "dismissed",
      );
      if (isExistingDup) continue;

      const topic: PreparedTopic = deepFreeze({
        topic_id: aiTopic.topic_id,
        source_note_id: aiTopic.source_note_id ?? null,
        title: aiTopic.title,
        description: aiTopic.description,
        representative_excerpts: Object.freeze([...aiTopic.representative_excerpts]),
        relevance_score: aiTopic.relevance_score,
        is_news_related: aiTopic.is_news_related ?? false,
        status: "pending" as TopicStatus,
        created_week_id: weekId,
        created_at: nowIso,
        last_status_change: nowIso,
      }) as unknown as PreparedTopic;

      newTopics.push(topic);
    }

    // 6. Merge: backlog (not dismissed) + new topics
    const mergedTopics: PreparedTopic[] = [
      ...backlogTopics,
      ...newTopics,
    ].sort((a, b) => b.relevance_score - a.relevance_score);

    // 7. Update state
    const updatedTopics = [
      ...state.topics.filter((t) => t.created_week_id !== weekId || t.status !== "pending"),
      ...newTopics,
    ];

    state = deepFreeze({
      ...state,
      current_week_id: weekId,
      topics: Object.freeze(updatedTopics),
      last_scan_week_id: weekId,
      scan_note_count: notes.length,
    }) as unknown as WeeklyPreparationState;

    await persist();

    return {
      weekId,
      newTopics,
      mergedTopics,
      totalCandidateCount: mergedTopics.length,
      newNoteCount: notes.length,
      message: `本周扫描了 ${notes.length} 篇笔记，生成了 ${newTopics.length} 个新主题，共 ${mergedTopics.length} 个候选主题（含 backlog）。`,
    };
  }

  // ── listTopics ──────────────────────────────────────────────

  async function listTopics(
    filter?: { status?: TopicStatus[] },
  ): Promise<PreparedTopic[]> {
    if (!filter?.status || filter.status.length === 0) {
      return [...state.topics];
    }
    const statusSet = new Set(filter.status);
    return state.topics.filter((t) => statusSet.has(t.status));
  }

  // ── getWeeklyCandidates ─────────────────────────────────────

  async function getWeeklyCandidates(
    weekId?: string,
  ): Promise<PreparedTopic[]> {
    const targetWeekId = weekId ?? getWeekId(clock());
    // pending + snoozed (dismissed/discussed/in_progress excluded by the status check)
    return state.topics.filter(
      (t) => t.status === "pending" || t.status === "snoozed",
    );
  }

  // ── getBacklogTopics ────────────────────────────────────────

  async function getBacklogTopics(): Promise<PreparedTopic[]> {
    const currentWeekId = getWeekId(clock());
    return state.topics.filter(
      (t) =>
        (t.status === "pending" || t.status === "snoozed") &&
        t.created_week_id !== currentWeekId,
    );
  }

  // ── Topic status transitions ────────────────────────────────

  async function updateTopicStatus(
    topicId: string,
    newStatus: TopicStatus,
    extra?: { conversation_id?: string },
  ): Promise<void> {
    const index = state.topics.findIndex((t) => t.topic_id === topicId);
    if (index === -1) {
      throw new Error(`Topic not found: ${topicId}`);
    }

    const existing = state.topics[index]!;
    const nowIso = clock().toISOString();

    const updated: PreparedTopic = deepFreeze({
      ...existing,
      status: newStatus,
      last_status_change: nowIso,
      conversation_id: extra?.conversation_id ?? existing.conversation_id,
    }) as unknown as PreparedTopic;

    const newTopics = [...state.topics];
    newTopics[index] = updated;

    state = deepFreeze({
      ...state,
      topics: Object.freeze(newTopics),
    }) as unknown as WeeklyPreparationState;

    await persist();
  }

  async function markTopicInProgress(
    topicId: string,
    conversationId: string,
  ): Promise<void> {
    const topic = state.topics.find((t) => t.topic_id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    if (topic.status !== "pending" && topic.status !== "snoozed") {
      throw new Error(
        `Cannot mark topic as in_progress: current status is "${topic.status}"`,
      );
    }
    await updateTopicStatus(topicId, "in_progress", { conversation_id: conversationId });
  }

  async function markTopicDiscussed(topicId: string): Promise<void> {
    const topic = state.topics.find((t) => t.topic_id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    // Allow transition from in_progress or directly from pending/snoozed
    // (Conversation may have been created externally)
    await updateTopicStatus(topicId, "discussed");
  }

  async function snoozeTopic(topicId: string): Promise<void> {
    const topic = state.topics.find((t) => t.topic_id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    if (topic.status === "dismissed" || topic.status === "discussed") {
      throw new Error(
        `Cannot snooze topic: current status is "${topic.status}"`,
      );
    }
    await updateTopicStatus(topicId, "snoozed");
  }

  async function dismissTopic(topicId: string): Promise<void> {
    const topic = state.topics.find((t) => t.topic_id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    await updateTopicStatus(topicId, "dismissed");
  }

  /**
   * Reset a discussed topic back to pending for re-discussion.
   * Only works on topics with status "discussed".
   */
  async function resetTopicForRediscuss(topicId: string): Promise<void> {
    const topic = state.topics.find((t) => t.topic_id === topicId);
    if (!topic) throw new Error(`Topic not found: ${topicId}`);
    if (topic.status !== "discussed") {
      throw new Error(
        `Cannot reset topic for re-discussion: current status is "${topic.status}". Only discussed topics can be reset.`,
      );
    }
    const nowIso = clock().toISOString();
    const updated: PreparedTopic = deepFreeze({
      ...topic,
      status: "pending" as TopicStatus,
      last_status_change: nowIso,
      // Clear the old conversation_id so a new conversation is created
      conversation_id: undefined,
    }) as unknown as PreparedTopic;

    const index = state.topics.findIndex((t) => t.topic_id === topicId);
    const newTopics = [...state.topics];
    newTopics[index] = updated;

    state = deepFreeze({
      ...state,
      topics: Object.freeze(newTopics),
    }) as unknown as WeeklyPreparationState;

    await persist();
  }

  // ── Persistence ─────────────────────────────────────────────

  function getState(): WeeklyPreparationState {
    return state;
  }

  function restore(restoredState: WeeklyPreparationState): void {
    state = deepFreeze(structuredClone(restoredState)) as unknown as WeeklyPreparationState;
  }

  // ═══════════════════════════════════════════════════════════════
  // Assembly
  // ═══════════════════════════════════════════════════════════════

  return {
    checkNewWeek,
    prepareWeeklyTopics,
    listTopics,
    getWeeklyCandidates,
    getBacklogTopics,
    markTopicInProgress,
    markTopicDiscussed,
    snoozeTopic,
    dismissTopic,
    resetTopicForRediscuss,
    getState,
    restore,
  };
}
