// ─── Part 1: Week Detection Tools ─────────────────────────────

import type { WeeklySnapshot } from "../domain/types";
import {
  startSnapshot,
  pauseSnapshot,
  resumeSnapshot,
  completeSnapshot,
} from "./snapshot";
import type { PreparedTopic, TopicPreparationSnapshot } from "./topic-preparation";
import { prepareTopics } from "./topic-preparation";
import type { AiProvider } from "../ai/provider";
import type { PluginCognitiveRepository } from "../storage/repository";
import type { MarkdownFileSystem } from "../storage/markdown";
import {
  atomicWriteMarkdown,
  renderDialogueArchiveMarkdown,
  renderWeeklyReviewMarkdown,
  renderEndorsedMarkdown,
  renderConfirmedObservationsMarkdown,
  renderAiHypothesesMarkdown,
  renderToVerifyMarkdown,
} from "../storage/markdown";
import type { PluginSettings } from "../storage/plugin-state";

/**
 * Compute the ISO 8601 week identifier for a given date.
 * Week starts on Monday. Week 1 is the week containing the first Thursday of the year.
 * Returns format like "2026-W31".
 *
 * This is a manual implementation that does NOT rely on Intl week calendars
 * (which have inconsistent browser support).
 */
export function getWeekId(date: Date, _timezone?: string): string {
  const d = new Date(date.getTime());

  const dayOfWeek = d.getDay(); // 0=Sun
  const isoDayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek; // 1=Mon ... 7=Sun

  // Find the Thursday of the current week (ISO day 4)
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - isoDayOfWeek + 4);

  const year = thursday.getFullYear();

  // ISO week formula: weekNum = floor((dayOfYear - isoDayOfWeek + 10) / 7)
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  const dayOfYear =
    Math.floor((d.getTime() - startOfYear.getTime()) / 86400000) + 1;
  let weekNum = Math.floor((dayOfYear - isoDayOfWeek + 10) / 7);

  // Handle edge cases
  if (weekNum < 1) {
    // Belongs to last week of previous year
    const lastDayOfPrevYear = new Date(d.getFullYear() - 1, 11, 31);
    return getWeekId(lastDayOfPrevYear);
  }
  if (weekNum > 52) {
    // Might belong to week 1 of next year.
    // The ISO week year is determined by the Thursday of that week.
    if (thursday.getFullYear() > d.getFullYear()) {
      return `${thursday.getFullYear()}-W01`;
    }
    // Otherwise it's a valid week 53 of the current year
    if (weekNum === 53) {
      // Verify it's actually week 53 (years have 53 weeks when Jan 1 is Thursday,
      // or in leap years when Jan 1 is Wednesday)
      // We already know Thursday is in the same year, so week 53 is valid.
    }
  }

  const weekStr = weekNum < 10 ? `0${weekNum}` : `${weekNum}`;
  return `${year}-W${weekStr}`;
}

/**
 * Check whether a new week has started since the snapshot was frozen.
 * Returns true if there is no snapshot (never frozen) or if the current week
 * differs from the week when the snapshot was frozen.
 */
export function isNewWeek(
  snapshot: WeeklySnapshot | null,
  now: Date,
  timezone?: string
): boolean {
  if (snapshot === null) return true;
  const snapshotWeek = getWeekId(new Date(snapshot.frozen_at), timezone);
  const currentWeek = getWeekId(now, timezone);
  return snapshotWeek !== currentWeek;
}

/**
 * Get the start of the current ISO week (Monday 00:00:00) in local time.
 */
export function getWeekStart(now: Date, _timezone?: string): Date {
  const d = new Date(now);
  const dayOfWeek = d.getDay(); // 0=Sun
  const isoDayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek; // 1=Mon ... 7=Sun
  const daysSinceMonday = isoDayOfWeek - 1;
  d.setDate(d.getDate() - daysSinceMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Part 2: Pipeline State ────────────────────────────────────

export type PipelinePhase =
  | "idle"
  | "frozen"            // snapshot frozen, waiting to start
  | "topics_prepared"   // topics assigned, waiting for user priority confirmation
  | "in_dialogue"       // dialogue in progress
  | "archiving"         // generating archives
  | "completed";        // weekly review complete

export interface WeeklyPipelineState {
  readonly phase: PipelinePhase;
  readonly snapshotId: string;
  readonly topicQueue: readonly string[];        // all topic IDs (ordered)
  readonly completedTopicIds: readonly string[]; // topics with completed discussion
  readonly currentTopicIndex: number;             // -1 means not started
  readonly priorityCount: number;                 // number of priority topics (max 3)
  readonly startedAt: string;                     // ISO timestamp
  readonly completedAt: string | null;
  readonly pausedFromPhase: PipelinePhase | null; // non-null when paused
}

// ─── Part 3: Orchestration Functions ───────────────────────────

function cloneState(
  state: WeeklyPipelineState,
  updates: Partial<WeeklyPipelineState>
): WeeklyPipelineState {
  const next = { ...state, ...updates };
  return Object.freeze(next) as WeeklyPipelineState;
}

/**
 * Initialize the pipeline state from a frozen snapshot and prepared topics.
 * Phase: frozen → topics_prepared.
 * The snapshot remains frozen; it will be started when the dialogue begins.
 */
export function beginWeeklyReview(input: {
  readonly snapshot: WeeklySnapshot;
  readonly preparedTopics: readonly PreparedTopic[];
  readonly maxPriorityTopics: number;
  readonly now: Date;
}): WeeklyPipelineState {
  if (input.snapshot.status !== "frozen") {
    throw new Error(
      `Cannot begin weekly review: snapshot status is "${input.snapshot.status}", expected "frozen"`
    );
  }

  const topicIds = input.preparedTopics.map((t) => t.note_id);
  const priorityCount = Math.min(input.maxPriorityTopics, topicIds.length);

  const state: WeeklyPipelineState = {
    phase: "topics_prepared",
    snapshotId: input.snapshot.snapshot_id,
    topicQueue: Object.freeze([...topicIds]) as readonly string[],
    completedTopicIds: Object.freeze([]) as readonly string[],
    currentTopicIndex: -1,
    priorityCount,
    startedAt: input.now.toISOString(),
    completedAt: null,
    pausedFromPhase: null,
  };

  return Object.freeze(state) as WeeklyPipelineState;
}

/**
 * Transition from topics_prepared → in_dialogue.
 * Note: the caller is responsible for calling startSnapshot on the snapshot
 * before or alongside this transition.
 */
export function startDialoguePhase(
  state: WeeklyPipelineState
): WeeklyPipelineState {
  if (state.phase !== "topics_prepared") {
    throw new Error(
      `Cannot start dialogue: current phase is "${state.phase}", expected "topics_prepared"`
    );
  }

  return cloneState(state, {
    phase: "in_dialogue",
    currentTopicIndex: 0,
  });
}

/**
 * Advance to the next topic after the current one is completed.
 * If all topics are done → archiving.
 */
export function advanceTopic(
  state: WeeklyPipelineState,
  completedTopicId: string
): WeeklyPipelineState {
  if (state.phase !== "in_dialogue") {
    throw new Error(
      `Cannot advance topic: current phase is "${state.phase}", expected "in_dialogue"`
    );
  }

  if (!state.topicQueue.includes(completedTopicId)) {
    throw new Error(
      `Cannot advance topic: "${completedTopicId}" is not in the topic queue`
    );
  }

  if (state.completedTopicIds.includes(completedTopicId)) {
    throw new Error(
      `Cannot advance topic: "${completedTopicId}" is already completed`
    );
  }

  const completedTopicIds = Object.freeze([
    ...state.completedTopicIds,
    completedTopicId,
  ]) as readonly string[];

  const allDone = completedTopicIds.length >= state.topicQueue.length;

  return cloneState(state, {
    phase: allDone ? "archiving" : "in_dialogue",
    completedTopicIds,
    currentTopicIndex: allDone
      ? state.currentTopicIndex
      : state.currentTopicIndex + 1,
  });
}

/**
 * Complete the weekly review.
 * in_dialogue/archiving → completed.
 * Idempotent: if already completed, returns the same state.
 */
export function completeWeeklyReview(
  state: WeeklyPipelineState,
  now: Date
): WeeklyPipelineState {
  if (state.phase === "completed") {
    return state; // idempotent
  }

  if (state.phase !== "in_dialogue" && state.phase !== "archiving") {
    throw new Error(
      `Cannot complete weekly review: current phase is "${state.phase}", expected "in_dialogue" or "archiving"`
    );
  }

  return cloneState(state, {
    phase: "completed",
    completedAt: now.toISOString(),
  });
}

/**
 * Pause the weekly review, preserving current progress.
 * Records the current phase so it can be restored on resume.
 * Cannot pause if already completed, archiving, or already paused.
 */
export function pauseWeeklyReview(
  state: WeeklyPipelineState
): WeeklyPipelineState {
  if (state.phase === "completed") {
    throw new Error("Cannot pause: weekly review is already completed");
  }
  if (state.phase === "archiving") {
    throw new Error("Cannot pause: archiving is in progress");
  }
  if (state.pausedFromPhase !== null) {
    throw new Error("Weekly review is already paused");
  }

  return cloneState(state, {
    pausedFromPhase: state.phase,
  });
}

/**
 * Resume a paused weekly review.
 * Restores the phase that was active before pausing.
 */
export function resumeWeeklyReview(
  state: WeeklyPipelineState
): WeeklyPipelineState {
  if (state.pausedFromPhase === null) {
    throw new Error("Weekly review is not paused");
  }

  return cloneState(state, {
    phase: state.pausedFromPhase,
    pausedFromPhase: null,
  });
}

// ─── Part 4: Topic Priority Scoring ────────────────────────────

export interface TopicPriorityScores {
  readonly topic_id: string;
  readonly urgency: number;           // 0-5
  readonly current_concern: number;   // 0-5
  readonly repetition: number;        // 0-5
  readonly expected_impact: number;   // 0-5
  readonly goal_relevance: number;    // 0-5
  readonly information_value: number; // 0-5
}

export const TOPIC_PRIORITY_WEIGHTS = Object.freeze({
  urgency: 0.25,
  current_concern: 0.20,
  repetition: 0.15,
  expected_impact: 0.20,
  goal_relevance: 0.10,
  information_value: 0.10,
});

/**
 * Compute the weighted total score for a topic.
 * All dimensions are 0-5, weights sum to 1.0, so max score = 5.0.
 */
export function scoreTopic(scores: TopicPriorityScores): number {
  return (
    scores.urgency * TOPIC_PRIORITY_WEIGHTS.urgency +
    scores.current_concern * TOPIC_PRIORITY_WEIGHTS.current_concern +
    scores.repetition * TOPIC_PRIORITY_WEIGHTS.repetition +
    scores.expected_impact * TOPIC_PRIORITY_WEIGHTS.expected_impact +
    scores.goal_relevance * TOPIC_PRIORITY_WEIGHTS.goal_relevance +
    scores.information_value * TOPIC_PRIORITY_WEIGHTS.information_value
  );
}

/**
 * Rank topics by weighted score, descending.
 * Ties are broken by original input order (stable sort).
 */
export function rankTopics(
  topics: readonly TopicPriorityScores[]
): readonly TopicPriorityScores[] {
  const indexed = topics.map((t, i) => ({ topic: t, originalIndex: i }));
  indexed.sort((a, b) => {
    const scoreA = scoreTopic(a.topic);
    const scoreB = scoreTopic(b.topic);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.originalIndex - b.originalIndex;
  });
  return Object.freeze(
    indexed.map((item) => item.topic)
  ) as readonly TopicPriorityScores[];
}

/**
 * Partition ranked topics into priority (first N) and backlog (rest).
 */
export function partitionTopics(
  ranked: readonly TopicPriorityScores[],
  maxPriority: number
): {
  readonly priority: readonly TopicPriorityScores[];
  readonly backlog: readonly TopicPriorityScores[];
} {
  const priority = Object.freeze(
    ranked.slice(0, maxPriority)
  ) as readonly TopicPriorityScores[];
  const backlog = Object.freeze(
    ranked.slice(maxPriority)
  ) as readonly TopicPriorityScores[];
  return { priority, backlog };
}

// ─── Part 5: WeeklyOrchestrator ────────────────────────────────

export interface WeeklyOrchestratorDependencies {
  readonly repository: PluginCognitiveRepository;
  readonly aiProvider: AiProvider;
  readonly markdownFs: MarkdownFileSystem;
  readonly settings: PluginSettings;
  readonly speechNormalizer: (text: string) => string;
  readonly clock: () => Date;
  /** Read a note body by its ID. Used to build the TopicPreparationSnapshot. */
  readonly readNoteBody: (noteId: string) => Promise<string>;
}

export class WeeklyOrchestrator {
  private pipelineState: WeeklyPipelineState | null = null;
  private activeSnapshot: WeeklySnapshot | null = null;
  private preparedTopics: readonly PreparedTopic[] = [];
  private readonly deps: WeeklyOrchestratorDependencies;

  constructor(deps: WeeklyOrchestratorDependencies) {
    this.deps = deps;
  }

  getPipelineState(): WeeklyPipelineState | null {
    return this.pipelineState;
  }

  /** Expose prepared topics so the composition root can build DialogueTopics. */
  getPreparedTopics(): readonly PreparedTopic[] {
    return this.preparedTopics;
  }

  /**
   * Start a new weekly review.
   * Flow:
   * 1. Validate snapshot is frozen
   * 2. Call AI prepareTopics on the snapshot's notes
   * 3. Rank + partition topics by priority
   * 4. Initialize pipeline state (topics_prepared)
   *
   * The snapshot stays frozen until dialogue actually begins.
   */
  async startReview(snapshot: WeeklySnapshot): Promise<WeeklyPipelineState> {
    // 1. Validate snapshot is frozen
    if (snapshot.status !== "frozen") {
      throw new Error(
        `Cannot start review: snapshot status is "${snapshot.status}", expected "frozen"`
      );
    }

    // 2. Build TopicPreparationSnapshot from snapshot notes
    const notes: Array<{ id: string; path: string; body: string }> = [];
    for (const noteId of snapshot.note_ids) {
      const body = await this.deps.readNoteBody(noteId);
      notes.push({ id: noteId, path: noteId, body });
    }

    const topicSnapshot: TopicPreparationSnapshot = {
      snapshot_id: snapshot.snapshot_id,
      note_ids: snapshot.note_ids,
      notes,
    };

    // 3. Call AI prepareTopics
    const modelClaims = this.deps.repository.getHistorical();
    this.preparedTopics = [];
    const prepared = await prepareTopics(
      topicSnapshot,
      modelClaims,
      this.deps.aiProvider,
      { characterBudget: this.deps.settings.topicCharBudget }
    );
    this.preparedTopics = prepared.topics;

    // 4. Build TopicPriorityScores from prepared topics
    // Default to neutral scores; AI doesn't return priority scores yet.
    // Future: AI may return structured scores for better ranking.
    const topicScores: TopicPriorityScores[] = prepared.topics.map((topic) => ({
      topic_id: topic.note_id,
      urgency: 3,
      current_concern: 3,
      repetition: 3,
      expected_impact: 3,
      goal_relevance: 3,
      information_value: 3,
    }));

    // 5. Rank and partition
    const ranked = rankTopics(topicScores);
    const partitioned = partitionTopics(
      ranked,
      this.deps.settings.maxPriorityTopics
    );

    // 6. Reorder prepared topics: priority first, then backlog
    const orderedIds = new Set([
      ...partitioned.priority.map((s) => s.topic_id),
      ...partitioned.backlog.map((s) => s.topic_id),
    ]);
    const orderedPrepared = prepared.topics.filter((t) =>
      orderedIds.has(t.note_id)
    );

    // 7. Initialize pipeline state (snapshot stays frozen)
    this.activeSnapshot = snapshot;
    this.pipelineState = beginWeeklyReview({
      snapshot,
      preparedTopics: orderedPrepared,
      maxPriorityTopics: this.deps.settings.maxPriorityTopics,
      now: this.deps.clock(),
    });

    return this.pipelineState;
  }

  /**
   * Continue an existing review. Resumes if paused.
   * Also resumes the snapshot if it was paused.
   */
  async continueReview(): Promise<WeeklyPipelineState> {
    if (this.pipelineState === null) {
      throw new Error("No active pipeline to continue");
    }

    if (this.pipelineState.pausedFromPhase !== null) {
      // Resume snapshot
      if (this.activeSnapshot !== null && this.activeSnapshot.status === "paused") {
        this.activeSnapshot = resumeSnapshot(this.activeSnapshot);
      }
      this.pipelineState = resumeWeeklyReview(this.pipelineState);
    }

    return this.pipelineState;
  }

  /**
   * Transition from topics_prepared to in_dialogue.
   * Starts the snapshot (frozen → active).
   */
  async startDialogue(): Promise<WeeklyPipelineState> {
    if (this.pipelineState === null) {
      throw new Error("No active pipeline");
    }

    if (this.pipelineState.phase !== "topics_prepared") {
      throw new Error(
        `Cannot start dialogue: pipeline phase is "${this.pipelineState.phase}"`
      );
    }

    if (this.activeSnapshot === null) {
      throw new Error("No active snapshot");
    }

    // Start the snapshot (frozen → active)
    this.activeSnapshot = startSnapshot(this.activeSnapshot);

    // Transition pipeline
    this.pipelineState = startDialoguePhase(this.pipelineState);
    return this.pipelineState;
  }

  /**
   * Pause the weekly review. Pauses both the pipeline and the snapshot.
   */
  async pauseReview(): Promise<WeeklyPipelineState> {
    if (this.pipelineState === null) {
      throw new Error("No active pipeline to pause");
    }

    // Pause pipeline (validates state)
    this.pipelineState = pauseWeeklyReview(this.pipelineState);

    // Pause snapshot if active
    if (this.activeSnapshot !== null && this.activeSnapshot.status === "active") {
      this.activeSnapshot = pauseSnapshot(this.activeSnapshot);
    }

    return this.pipelineState;
  }

  /**
   * Complete the current topic and advance to the next.
   */
  async completeCurrentTopic(topicId: string): Promise<WeeklyPipelineState> {
    if (this.pipelineState === null) {
      throw new Error("No active pipeline");
    }

    if (this.pipelineState.phase !== "in_dialogue") {
      throw new Error(
        `Cannot complete topic: current phase is "${this.pipelineState.phase}"`
      );
    }

    this.pipelineState = advanceTopic(this.pipelineState, topicId);
    return this.pipelineState;
  }

  /**
   * Finish the entire weekly review.
   * Flow:
   * 1. Validate pipeline state
   * 2. Generate dialogue archive + weekly review + cognitive model view markdowns
   * 3. Atomic write all files
   * 4. Complete the snapshot (active → completed)
   * 5. Mark pipeline as completed
   */
  async finishReview(): Promise<WeeklyPipelineState> {
    if (this.pipelineState === null) {
      throw new Error("No active pipeline to finish");
    }

    const state = this.pipelineState;

    // 1. Validate pipeline is in_dialogue or archiving
    if (state.phase !== "in_dialogue" && state.phase !== "archiving") {
      throw new Error(
        `Cannot finish review: current phase is "${state.phase}", expected "in_dialogue" or "archiving"`
      );
    }

    const now = this.deps.clock();
    const systemDir = this.deps.settings.systemOutputDir;
    const weekId = getWeekId(now);

    // 2. Generate dialogue archive markdown
    const sessionId = `session:${state.snapshotId}`;
    const safeSessionId = sessionId.replace(/[:/\\?*"<>|]/g, "-");
    const dateLabel = now.toISOString().split("T")[0]!;
    const archiveContent = renderDialogueArchiveMarkdown(
      [],
      sessionId,
      dateLabel
    );

    // 3. Generate weekly review markdown
    const weeklyReviewContent = renderWeeklyReviewMarkdown(
      weekId,
      state.topicQueue.length,
      "本周目标进展总结",
      "本周验证反馈总结",
      []
    );

    // 4. Generate cognitive model view markdowns
    const endorsedContent = renderEndorsedMarkdown(
      this.deps.repository.getEndorsed()
    );
    const observationsContent = renderConfirmedObservationsMarkdown(
      this.deps.repository.getConfirmedObservations()
    );
    const hypothesesContent = renderAiHypothesesMarkdown(
      this.deps.repository.getAiHypotheses()
    );
    const toVerifyContent = renderToVerifyMarkdown(
      this.deps.repository.getToVerify()
    );

    // 5. Atomic write all files
    const opId = `wr-${weekId}`;
    const writeOps: Array<{ path: string; content: string; fileIndex: number }> = [
      {
        path: `${systemDir}/每周回顾/${weekId}.md`,
        content: weeklyReviewContent,
        fileIndex: 0,
      },
      {
        path: `${systemDir}/对话归档/${dateLabel}_${safeSessionId}.md`,
        content: archiveContent,
        fileIndex: 1,
      },
      {
        path: `${systemDir}/当前认知/当前明确认可.md`,
        content: endorsedContent,
        fileIndex: 2,
      },
      {
        path: `${systemDir}/当前认知/已确认观察.md`,
        content: observationsContent,
        fileIndex: 3,
      },
      {
        path: `${systemDir}/当前认知/AI工作假设.md`,
        content: hypothesesContent,
        fileIndex: 4,
      },
      {
        path: `${systemDir}/当前认知/待验证想法.md`,
        content: toVerifyContent,
        fileIndex: 5,
      },
    ];

    for (const { path, content, fileIndex } of writeOps) {
      await atomicWriteMarkdown(
        this.deps.markdownFs,
        path,
        content,
        `${opId}-f${fileIndex}`
      );
    }

    // 6. Complete the snapshot (active → completed)
    if (this.activeSnapshot !== null) {
      this.activeSnapshot = completeSnapshot(this.activeSnapshot);
    }

    // 7. Update pipeline state to completed
    this.pipelineState = completeWeeklyReview(state, now);
    return this.pipelineState;
  }
}
