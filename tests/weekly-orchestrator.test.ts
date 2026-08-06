import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  getWeekId,
  isNewWeek,
  getWeekStart,
  beginWeeklyReview,
  startDialoguePhase,
  advanceTopic,
  completeWeeklyReview,
  pauseWeeklyReview,
  resumeWeeklyReview,
  scoreTopic,
  rankTopics,
  partitionTopics,
  TOPIC_PRIORITY_WEIGHTS,
  WeeklyOrchestrator,
  type PipelinePhase,
  type WeeklyPipelineState,
  type TopicPriorityScores,
  type WeeklyOrchestratorDependencies,
} from "../src/weekly/orchestrator";
import {
  createSnapshot,
  startSnapshot,
  pauseSnapshot,
  resumeSnapshot,
  completeSnapshot,
} from "../src/weekly/snapshot";
import type { WeeklySnapshot, Claim } from "../src/domain/types";
import type { NoteRef } from "../src/vault/scanner";
import type { AiProvider, AiCompletionRequest } from "../src/ai/provider";
import type { PreparedTopics } from "../src/weekly/topic-preparation";
import { PluginCognitiveRepository } from "../src/storage/repository";
import type { MarkdownFileSystem } from "../src/storage/markdown";
import {
  createDefaultPluginState,
  type PluginSettings,
} from "../src/storage/plugin-state";
import type { IdGenerator } from "../src/dialogue/finalize";

// ─── Helpers ─────────────────────────────────────────────────

const note = (id: string, contentHash: string): NoteRef => ({
  id: `sha256:${id.padEnd(64, "0")}`,
  path: `notes/${id}.md`,
  content_hash: `sha256:${contentHash.padEnd(64, "0")}`,
});

function makeSnapshot(
  status: WeeklySnapshot["status"],
  frozenAt: Date = new Date("2026-07-27T08:00:00.000Z")
): WeeklySnapshot {
  const s = createSnapshot(
    [note("a", "1"), note("b", "2"), note("c", "3")],
    null,
    frozenAt
  );

  if (status === "frozen") return s;
  if (status === "active") return startSnapshot(s);
  if (status === "paused") return pauseSnapshot(startSnapshot(s));
  if (status === "completed") return completeSnapshot(startSnapshot(s));
  throw new Error(`Unknown status: ${status}`);
}

function makePipelineState(
  overrides: Partial<WeeklyPipelineState> = {}
): WeeklyPipelineState {
  const base: WeeklyPipelineState = {
    phase: "topics_prepared",
    snapshotId: "snap-1",
    topicQueue: Object.freeze(["topic-a", "topic-b", "topic-c"]),
    completedTopicIds: Object.freeze([]),
    currentTopicIndex: -1,
    priorityCount: 3,
    startedAt: "2026-07-27T08:00:00.000Z",
    completedAt: null,
    pausedFromPhase: null,
  };
  return Object.freeze({ ...base, ...overrides }) as WeeklyPipelineState;
}

function makeTopicScores(
  overrides: Partial<TopicPriorityScores> & { topic_id: string }
): TopicPriorityScores {
  return {
    urgency: 3,
    current_concern: 3,
    repetition: 3,
    expected_impact: 3,
    goal_relevance: 3,
    information_value: 3,
    ...overrides,
  };
}

// ─── Fake AI Provider ────────────────────────────────────────

/** AI output format matching prepareTopics' outputSchema */
interface FakeAiTopicsOutput {
  readonly topics: readonly {
    readonly note_id: string;
    readonly primary_theme: string;
    readonly secondary_links: readonly string[];
  }[];
}

class FakeAiProvider implements AiProvider {
  private nextOutput: FakeAiTopicsOutput | null = null;

  setNextTopics(output: FakeAiTopicsOutput): void {
    this.nextOutput = output;
  }

  async complete<Output>(
    _request: AiCompletionRequest<Output>,
    _signal?: AbortSignal
  ): Promise<Output> {
    if (this.nextOutput === null) {
      throw new Error("FakeAiProvider: no preset topics");
    }
    return this.nextOutput as unknown as Output;
  }
}

// ─── In-Memory Markdown FS ───────────────────────────────────

class MemoryMarkdownFs implements MarkdownFileSystem {
  files = new Map<string, string>();

  async writeFile(relativePath: string, content: string): Promise<number> {
    this.files.set(relativePath, content);
    return new TextEncoder().encode(content).length;
  }

  async readFile(relativePath: string): Promise<string> {
    const content = this.files.get(relativePath);
    if (content === undefined) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return content;
  }

  async fileExists(relativePath: string): Promise<boolean> {
    return this.files.has(relativePath);
  }

  async copyFile(sourcePath: string, targetPath: string): Promise<void> {
    const content = this.files.get(sourcePath);
    if (content === undefined) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }
    this.files.set(targetPath, content);
  }

  async deleteFile(relativePath: string): Promise<void> {
    this.files.delete(relativePath);
  }

  async listFiles(dirPath: string): Promise<string[]> {
    const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
    const result: string[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        result.push(key);
      }
    }
    return result.sort();
  }
}

// ─── Minimal Repository ──────────────────────────────────────

function fakeRepository(): PluginCognitiveRepository {
  let stored: unknown = null;
  const defaultState = createDefaultPluginState();
  // Serialize to get a plain object
  const serialized = JSON.parse(JSON.stringify(defaultState));

  return new PluginCognitiveRepository({
    loadState: () => {
      if (stored === null) return serialized as ReturnType<typeof createDefaultPluginState>;
      return stored as ReturnType<typeof createDefaultPluginState>;
    },
    saveState: async (state) => {
      stored = state;
    },
    idGenerator: {
      create(scope: string): string {
        return `test:${scope}:${Math.random().toString(36).slice(2, 10)}`;
      },
    },
  });
}

// ─── Build Orchestrator Dependencies ─────────────────────────

function buildDeps(overrides: Partial<WeeklyOrchestratorDependencies> = {}): WeeklyOrchestratorDependencies {
  const settings: PluginSettings = createDefaultPluginState().settings;
  const repo = fakeRepository();
  const aiProvider = new FakeAiProvider();
  const markdownFs = new MemoryMarkdownFs();
  const noteBodies = new Map<string, string>();

  return {
    repository: repo,
    aiProvider,
    markdownFs,
    settings,
    speechNormalizer: (text: string) => text,
    clock: () => new Date("2026-07-27T08:00:00.000Z"),
    readNoteBody: async (noteId: string) => {
      return noteBodies.get(noteId) ?? `Body of ${noteId}`;
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// Part 1: Week Detection
// ═══════════════════════════════════════════════════════════════

describe("getWeekId", () => {
  it("returns correct ISO week for a normal date (2026-07-27 = Monday)", () => {
    // July 27, 2026 is a Monday
    const d = new Date("2026-07-27T08:00:00.000Z");
    // In UTC this is Monday. ISO week calculation depends on local interpretation.
    // We construct a date with local components for reliable testing.
    const local = new Date(2026, 6, 27, 8, 0, 0); // July 27, 2026 (month is 0-indexed)
    const weekId = getWeekId(local);
    // July 27, 2026 — should be around week 31
    expect(weekId).toMatch(/^2026-W\d{2}$/);
    const weekNum = parseInt(weekId.split("-W")[1]!, 10);
    expect(weekNum).toBeGreaterThanOrEqual(30);
    expect(weekNum).toBeLessThanOrEqual(32);
  });

  it("returns W01 for January 1 when it's part of week 1", () => {
    // Jan 1, 2026 is a Thursday → week 1
    const d = new Date(2026, 0, 1, 12, 0, 0);
    const weekId = getWeekId(d);
    expect(weekId).toBe("2026-W01");
  });

  it("handles year boundary: Dec 31 in week 53 of the year", () => {
    // Dec 31, 2026 is a Thursday → ISO week 53 of 2026
    // (Week 1 of 2027 starts Jan 4, since Jan 1 2027 is Friday)
    const d = new Date(2026, 11, 31, 12, 0, 0);
    const weekId = getWeekId(d);
    expect(weekId).toBe("2026-W53");
  });

  it("handles early January that belongs to previous year's last week", () => {
    // Jan 1, 2027 is a Friday → might belong to week 53 of 2026
    const d = new Date(2027, 0, 1, 12, 0, 0);
    const weekId = getWeekId(d);
    // Jan 1 2027 is Friday, ISO day 5. Thursday is Jan 1 2027 → still 2027
    // dayOfYear=1, isoDayOfWeek=5, (1-5+10)/7 = 6/7 = 0 → week 0 → belongs to 2026
    // Last day of 2026: Dec 31 is Thursday → week 53
    expect(weekId).toBe("2026-W53");
  });

  it("is consistent for all days of the same week", () => {
    // Monday July 27 to Sunday Aug 2, 2026
    const weekIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(2026, 6, 27 + i, 12, 0, 0);
      weekIds.push(getWeekId(d));
    }
    const unique = new Set(weekIds);
    expect(unique.size).toBe(1);
  });

  it("transitions to next week on Monday", () => {
    const sunday = new Date(2026, 7, 2, 23, 59, 59); // Sunday
    const monday = new Date(2026, 7, 3, 0, 0, 1);   // Monday
    expect(getWeekId(sunday)).not.toBe(getWeekId(monday));
  });
});

describe("isNewWeek", () => {
  it("returns true when snapshot is null (never frozen)", () => {
    expect(isNewWeek(null, new Date("2026-07-27T08:00:00.000Z"))).toBe(true);
  });

  it("returns false when snapshot is from the same ISO week", () => {
    const frozenAt = new Date(2026, 6, 27, 8, 0, 0);  // Monday
    const snapshot = makeSnapshot("frozen", frozenAt);
    const now = new Date(2026, 6, 29, 12, 0, 0);      // Wednesday same week
    expect(isNewWeek(snapshot, now)).toBe(false);
  });

  it("returns true when current week differs from snapshot week", () => {
    const frozenAt = new Date(2026, 6, 27, 8, 0, 0);  // Monday
    const snapshot = makeSnapshot("frozen", frozenAt);
    const now = new Date(2026, 7, 3, 8, 0, 0);        // Next Monday
    expect(isNewWeek(snapshot, now)).toBe(true);
  });

  it("handles cross-year week transition", () => {
    // Dec 28, 2026 is a Monday (W53)
    const frozenAt = new Date(2026, 11, 28, 8, 0, 0);
    const snapshot = makeSnapshot("frozen", frozenAt);
    // Jan 4, 2027 is a Monday (W01 of 2027)
    const now = new Date(2027, 0, 4, 8, 0, 0);
    expect(isNewWeek(snapshot, now)).toBe(true);
  });
});

describe("getWeekStart", () => {
  it("returns Monday 00:00:00 for any day of the week", () => {
    // Tuesday July 28, 2026 at 15:30:45
    const d = new Date(2026, 6, 28, 15, 30, 45, 123);
    const start = getWeekStart(d);

    // Should be Monday July 27, 2026 00:00:00.000
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6); // July
    expect(start.getDate()).toBe(27);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
  });

  it("returns same day 00:00:00 when already Monday", () => {
    const d = new Date(2026, 6, 27, 8, 0, 0); // Monday
    const start = getWeekStart(d);
    expect(start.getDate()).toBe(27);
    expect(start.getHours()).toBe(0);
  });

  it("returns previous Monday when on Sunday", () => {
    const d = new Date(2026, 7, 2, 12, 0, 0); // Sunday Aug 2
    const start = getWeekStart(d);
    expect(start.getDate()).toBe(27); // Monday July 27
    expect(start.getMonth()).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 2: Pipeline State — beginWeeklyReview
// ═══════════════════════════════════════════════════════════════

describe("beginWeeklyReview", () => {
  it("initializes pipeline in topics_prepared phase with a frozen snapshot", () => {
    const snapshot = makeSnapshot("frozen");
    const preparedTopics = [
      {
        note_id: snapshot.note_ids[0]!,
        primary_theme: "Theme A",
        secondary_links: [],
        representative_excerpts: ["excerpt a"],
      },
      {
        note_id: snapshot.note_ids[1]!,
        primary_theme: "Theme B",
        secondary_links: [],
        representative_excerpts: ["excerpt b"],
      },
      {
        note_id: snapshot.note_ids[2]!,
        primary_theme: "Theme C",
        secondary_links: [],
        representative_excerpts: ["excerpt c"],
      },
    ];

    const state = beginWeeklyReview({
      snapshot,
      preparedTopics,
      maxPriorityTopics: 3,
      now: new Date("2026-07-27T08:00:00.000Z"),
    });

    expect(state.phase).toBe("topics_prepared");
    expect(state.snapshotId).toBe(snapshot.snapshot_id);
    expect(state.topicQueue).toHaveLength(3);
    expect(state.completedTopicIds).toHaveLength(0);
    expect(state.currentTopicIndex).toBe(-1);
    expect(state.priorityCount).toBe(3);
    expect(state.startedAt).toBe("2026-07-27T08:00:00.000Z");
    expect(state.completedAt).toBeNull();
    expect(state.pausedFromPhase).toBeNull();
  });

  it("caps priorityCount at maxPriorityTopics", () => {
    const snapshot = makeSnapshot("frozen");
    const preparedTopics = snapshot.note_ids.map((id) => ({
      note_id: id,
      primary_theme: "Theme",
      secondary_links: [],
      representative_excerpts: [],
    }));

    const state = beginWeeklyReview({
      snapshot,
      preparedTopics,
      maxPriorityTopics: 1,
      now: new Date(),
    });

    expect(state.priorityCount).toBe(1);
  });

  it("throws when snapshot is not frozen", () => {
    const activeSnapshot = makeSnapshot("active");
    expect(() =>
      beginWeeklyReview({
        snapshot: activeSnapshot,
        preparedTopics: [],
        maxPriorityTopics: 3,
        now: new Date(),
      })
    ).toThrow("frozen");
  });

  it("throws when snapshot is paused", () => {
    const pausedSnapshot = makeSnapshot("paused");
    expect(() =>
      beginWeeklyReview({
        snapshot: pausedSnapshot,
        preparedTopics: [],
        maxPriorityTopics: 3,
        now: new Date(),
      })
    ).toThrow("frozen");
  });

  it("returns frozen immutable state", () => {
    const snapshot = makeSnapshot("frozen");
    const state = beginWeeklyReview({
      snapshot,
      preparedTopics: [],
      maxPriorityTopics: 3,
      now: new Date(),
    });

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.topicQueue)).toBe(true);
    expect(Object.isFrozen(state.completedTopicIds)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 3: Pipeline State Transitions
// ═══════════════════════════════════════════════════════════════

describe("startDialoguePhase", () => {
  it("transitions from topics_prepared to in_dialogue", () => {
    const state = makePipelineState({ phase: "topics_prepared", currentTopicIndex: -1 });
    const next = startDialoguePhase(state);

    expect(next.phase).toBe("in_dialogue");
    expect(next.currentTopicIndex).toBe(0);
  });

  it("throws when not in topics_prepared", () => {
    expect(() => startDialoguePhase(makePipelineState({ phase: "in_dialogue" }))).toThrow(
      "topics_prepared"
    );
    expect(() => startDialoguePhase(makePipelineState({ phase: "completed" }))).toThrow(
      "topics_prepared"
    );
    expect(() => startDialoguePhase(makePipelineState({ phase: "idle" }))).toThrow(
      "topics_prepared"
    );
  });
});

describe("advanceTopic", () => {
  it("advances to the next topic", () => {
    const state = makePipelineState({
      phase: "in_dialogue",
      currentTopicIndex: 0,
      completedTopicIds: Object.freeze([]),
    });

    const next = advanceTopic(state, "topic-a");
    expect(next.phase).toBe("in_dialogue");
    expect(next.currentTopicIndex).toBe(1);
    expect(next.completedTopicIds).toEqual(["topic-a"]);
  });

  it("transitions to archiving when the last topic is completed", () => {
    const state = makePipelineState({
      phase: "in_dialogue",
      currentTopicIndex: 2,
      completedTopicIds: Object.freeze(["topic-a", "topic-b"]),
      topicQueue: Object.freeze(["topic-a", "topic-b", "topic-c"]),
    });

    const next = advanceTopic(state, "topic-c");
    expect(next.phase).toBe("archiving");
    expect(next.completedTopicIds).toEqual(["topic-a", "topic-b", "topic-c"]);
  });

  it("throws when not in_dialogue", () => {
    const state = makePipelineState({ phase: "topics_prepared" });
    expect(() => advanceTopic(state, "topic-a")).toThrow("in_dialogue");
  });

  it("throws when topic is not in queue", () => {
    const state = makePipelineState({ phase: "in_dialogue" });
    expect(() => advanceTopic(state, "nonexistent")).toThrow("topic queue");
  });

  it("throws when topic is already completed", () => {
    const state = makePipelineState({
      phase: "in_dialogue",
      completedTopicIds: Object.freeze(["topic-a"]),
    });
    expect(() => advanceTopic(state, "topic-a")).toThrow("already completed");
  });
});

describe("completeWeeklyReview", () => {
  it("transitions from in_dialogue to completed", () => {
    const state = makePipelineState({ phase: "in_dialogue" });
    const now = new Date("2026-07-27T10:00:00.000Z");
    const next = completeWeeklyReview(state, now);

    expect(next.phase).toBe("completed");
    expect(next.completedAt).toBe("2026-07-27T10:00:00.000Z");
  });

  it("transitions from archiving to completed", () => {
    const state = makePipelineState({ phase: "archiving" });
    const next = completeWeeklyReview(state, new Date());

    expect(next.phase).toBe("completed");
    expect(next.completedAt).not.toBeNull();
  });

  it("is idempotent when already completed", () => {
    const state = makePipelineState({
      phase: "completed",
      completedAt: "2026-07-27T09:00:00.000Z",
    });
    const next = completeWeeklyReview(state, new Date("2026-07-27T10:00:00.000Z"));

    // Should return the same completedAt, not update it
    expect(next.phase).toBe("completed");
    expect(next.completedAt).toBe("2026-07-27T09:00:00.000Z");
  });

  it("throws when not in_dialogue or archiving", () => {
    expect(() =>
      completeWeeklyReview(makePipelineState({ phase: "topics_prepared" }), new Date())
    ).toThrow("topics_prepared");
    expect(() =>
      completeWeeklyReview(makePipelineState({ phase: "idle" }), new Date())
    ).toThrow("idle");
  });
});

describe("pauseWeeklyReview", () => {
  it("records the current phase as pausedFromPhase", () => {
    const state = makePipelineState({ phase: "in_dialogue" });
    const next = pauseWeeklyReview(state);

    expect(next.pausedFromPhase).toBe("in_dialogue");
    // Phase stays the same but pausedFromPhase is set
  });

  it("can pause from topics_prepared", () => {
    const state = makePipelineState({ phase: "topics_prepared" });
    const next = pauseWeeklyReview(state);
    expect(next.pausedFromPhase).toBe("topics_prepared");
  });

  it("throws when already paused", () => {
    const state = makePipelineState({
      phase: "in_dialogue",
      pausedFromPhase: "topics_prepared",
    });
    expect(() => pauseWeeklyReview(state)).toThrow("already paused");
  });

  it("throws when completed", () => {
    expect(() =>
      pauseWeeklyReview(makePipelineState({ phase: "completed" }))
    ).toThrow("completed");
  });

  it("throws when archiving", () => {
    expect(() =>
      pauseWeeklyReview(makePipelineState({ phase: "archiving" }))
    ).toThrow("archiving");
  });
});

describe("resumeWeeklyReview", () => {
  it("restores the phase from pausedFromPhase", () => {
    const state = makePipelineState({
      phase: "in_dialogue",
      pausedFromPhase: "topics_prepared",
    });
    const next = resumeWeeklyReview(state);

    expect(next.phase).toBe("topics_prepared");
    expect(next.pausedFromPhase).toBeNull();
  });

  it("throws when not paused", () => {
    const state = makePipelineState({ phase: "in_dialogue", pausedFromPhase: null });
    expect(() => resumeWeeklyReview(state)).toThrow("not paused");
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 4: Topic Priority Scoring
// ═══════════════════════════════════════════════════════════════

describe("TOPIC_PRIORITY_WEIGHTS", () => {
  it("weights sum to exactly 1.0", () => {
    const sum =
      TOPIC_PRIORITY_WEIGHTS.urgency +
      TOPIC_PRIORITY_WEIGHTS.current_concern +
      TOPIC_PRIORITY_WEIGHTS.repetition +
      TOPIC_PRIORITY_WEIGHTS.expected_impact +
      TOPIC_PRIORITY_WEIGHTS.goal_relevance +
      TOPIC_PRIORITY_WEIGHTS.information_value;

    // Use toBeCloseTo for floating point
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("is frozen/immutable", () => {
    expect(Object.isFrozen(TOPIC_PRIORITY_WEIGHTS)).toBe(true);
  });
});

describe("scoreTopic", () => {
  it("returns 5.0 for all-max scores", () => {
    const scores = makeTopicScores({
      topic_id: "t1",
      urgency: 5,
      current_concern: 5,
      repetition: 5,
      expected_impact: 5,
      goal_relevance: 5,
      information_value: 5,
    });
    expect(scoreTopic(scores)).toBeCloseTo(5.0, 10);
  });

  it("returns 0.0 for all-zero scores", () => {
    const scores = makeTopicScores({
      topic_id: "t1",
      urgency: 0,
      current_concern: 0,
      repetition: 0,
      expected_impact: 0,
      goal_relevance: 0,
      information_value: 0,
    });
    expect(scoreTopic(scores)).toBe(0.0);
  });

  it("computes correct weighted score for mixed values", () => {
    const scores: TopicPriorityScores = {
      topic_id: "t1",
      urgency: 4,
      current_concern: 2,
      repetition: 5,
      expected_impact: 1,
      goal_relevance: 3,
      information_value: 0,
    };
    const expected =
      4 * 0.25 + 2 * 0.20 + 5 * 0.15 + 1 * 0.20 + 3 * 0.10 + 0 * 0.10;
    expect(scoreTopic(scores)).toBeCloseTo(expected, 10);
  });

  it("urgency has the highest weight (0.25)", () => {
    const base = makeTopicScores({ topic_id: "t1" });
    expect(TOPIC_PRIORITY_WEIGHTS.urgency).toBe(0.25);
    // Verify it's the maximum weight
    const weights = Object.values(TOPIC_PRIORITY_WEIGHTS);
    expect(Math.max(...weights)).toBe(0.25);
  });
});

describe("rankTopics", () => {
  it("ranks by score descending", () => {
    const topics: TopicPriorityScores[] = [
      makeTopicScores({ topic_id: "low", urgency: 1, current_concern: 1, repetition: 1, expected_impact: 1, goal_relevance: 1, information_value: 1 }),
      makeTopicScores({ topic_id: "high", urgency: 5, current_concern: 5, repetition: 5, expected_impact: 5, goal_relevance: 5, information_value: 5 }),
      makeTopicScores({ topic_id: "mid", urgency: 3, current_concern: 3, repetition: 3, expected_impact: 3, goal_relevance: 3, information_value: 3 }),
    ];

    const ranked = rankTopics(topics);
    expect(ranked[0]!.topic_id).toBe("high");
    expect(ranked[1]!.topic_id).toBe("mid");
    expect(ranked[2]!.topic_id).toBe("low");
  });

  it("preserves original order for equal scores (stable sort)", () => {
    const topics: TopicPriorityScores[] = [
      makeTopicScores({ topic_id: "first", urgency: 3 }),
      makeTopicScores({ topic_id: "second", urgency: 3 }),
      makeTopicScores({ topic_id: "third", urgency: 3 }),
    ];

    const ranked = rankTopics(topics);
    expect(ranked[0]!.topic_id).toBe("first");
    expect(ranked[1]!.topic_id).toBe("second");
    expect(ranked[2]!.topic_id).toBe("third");
  });

  it("handles empty list", () => {
    const ranked = rankTopics([]);
    expect(ranked).toHaveLength(0);
  });

  it("returns frozen result", () => {
    const topics = [makeTopicScores({ topic_id: "t1" })];
    const ranked = rankTopics(topics);
    expect(Object.isFrozen(ranked)).toBe(true);
  });
});

describe("partitionTopics", () => {
  it("partitions into priority and backlog", () => {
    const topics: TopicPriorityScores[] = [
      makeTopicScores({ topic_id: "a", urgency: 5 }),
      makeTopicScores({ topic_id: "b", urgency: 4 }),
      makeTopicScores({ topic_id: "c", urgency: 3 }),
      makeTopicScores({ topic_id: "d", urgency: 2 }),
    ];

    const { priority, backlog } = partitionTopics(topics, 2);

    expect(priority).toHaveLength(2);
    expect(priority[0]!.topic_id).toBe("a");
    expect(priority[1]!.topic_id).toBe("b");
    expect(backlog).toHaveLength(2);
    expect(backlog[0]!.topic_id).toBe("c");
    expect(backlog[1]!.topic_id).toBe("d");
  });

  it("handles fewer topics than maxPriority", () => {
    const topics = [makeTopicScores({ topic_id: "a" })];
    const { priority, backlog } = partitionTopics(topics, 3);

    expect(priority).toHaveLength(1);
    expect(backlog).toHaveLength(0);
  });

  it("handles empty list", () => {
    const { priority, backlog } = partitionTopics([], 3);
    expect(priority).toHaveLength(0);
    expect(backlog).toHaveLength(0);
  });

  it("returns frozen arrays", () => {
    const topics = [makeTopicScores({ topic_id: "a" })];
    const { priority, backlog } = partitionTopics(topics, 1);
    expect(Object.isFrozen(priority)).toBe(true);
    expect(Object.isFrozen(backlog)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 5: WeeklyOrchestrator
// ═══════════════════════════════════════════════════════════════

describe("WeeklyOrchestrator", () => {
  describe("constructor and getPipelineState", () => {
    it("starts with null pipeline state", () => {
      const orch = new WeeklyOrchestrator(buildDeps());
      expect(orch.getPipelineState()).toBeNull();
    });
  });

  describe("startReview", () => {
    it("initializes pipeline after topic preparation (with mock AI)", async () => {
      const deps = buildDeps();
      const fakeAi = deps.aiProvider as FakeAiProvider;

      // Preset AI response
      const snapshot = makeSnapshot("frozen");
      fakeAi.setNextTopics({
        topics: snapshot.note_ids.map((id, i) => ({
          note_id: id,
          primary_theme: `Theme ${String.fromCharCode(65 + i)}`,
          secondary_links: [],
        })),
      });

      const orch = new WeeklyOrchestrator(deps);
      const state = await orch.startReview(snapshot);

      expect(state.phase).toBe("topics_prepared");
      expect(state.topicQueue).toHaveLength(3);
      expect(state.priorityCount).toBe(3);
    });

    it("throws when snapshot is not frozen", async () => {
      const orch = new WeeklyOrchestrator(buildDeps());
      const activeSnapshot = makeSnapshot("active");

      await expect(orch.startReview(activeSnapshot)).rejects.toThrow("frozen");
    });

    it("throws when snapshot is paused", async () => {
      const orch = new WeeklyOrchestrator(buildDeps());
      const pausedSnapshot = makeSnapshot("paused");

      await expect(orch.startReview(pausedSnapshot)).rejects.toThrow("frozen");
    });
  });

  describe("startDialogue", () => {
    it("transitions from topics_prepared to in_dialogue and starts snapshot", async () => {
      const deps = buildDeps();
      const fakeAi = deps.aiProvider as FakeAiProvider;
      const snapshot = makeSnapshot("frozen");

      fakeAi.setNextTopics({
        topics: snapshot.note_ids.map((id, i) => ({
          note_id: id,
          primary_theme: `Theme ${i}`,
          secondary_links: [],
        })),
      });

      const orch = new WeeklyOrchestrator(deps);
      await orch.startReview(snapshot);
      const state = await orch.startDialogue();

      expect(state.phase).toBe("in_dialogue");
      expect(state.currentTopicIndex).toBe(0);
    });

    it("throws when pipeline is not in topics_prepared", async () => {
      const orch = new WeeklyOrchestrator(buildDeps());
      await expect(orch.startDialogue()).rejects.toThrow("No active pipeline");
    });
  });

  describe("completeCurrentTopic", () => {
    it("advances through topics one by one", async () => {
      const deps = buildDeps();
      const fakeAi = deps.aiProvider as FakeAiProvider;
      const snapshot = makeSnapshot("frozen");

      fakeAi.setNextTopics({
        topics: snapshot.note_ids.map((id, i) => ({
          note_id: id,
          primary_theme: `Theme ${i}`,
          secondary_links: [],
        })),
      });

      const orch = new WeeklyOrchestrator(deps);
      await orch.startReview(snapshot);
      await orch.startDialogue();

      // Get the topic IDs from the pipeline
      const state1 = orch.getPipelineState()!;
      const topicA = state1.topicQueue[0]!;

      let state = await orch.completeCurrentTopic(topicA);
      expect(state.completedTopicIds).toContain(topicA);
      expect(state.currentTopicIndex).toBe(1);

      const topicB = state.topicQueue[1]!;
      state = await orch.completeCurrentTopic(topicB);
      expect(state.completedTopicIds).toContain(topicB);
      expect(state.currentTopicIndex).toBe(2);
    });

    it("transitions to archiving after last topic", async () => {
      const deps = buildDeps();
      const fakeAi = deps.aiProvider as FakeAiProvider;
      const snapshot = makeSnapshot("frozen");

      fakeAi.setNextTopics({
        topics: snapshot.note_ids.map((id, i) => ({
          note_id: id,
          primary_theme: `Theme ${i}`,
          secondary_links: [],
        })),
      });

      const orch = new WeeklyOrchestrator(deps);
      await orch.startReview(snapshot);
      await orch.startDialogue();

      const pipelineState = orch.getPipelineState()!;
      for (const topicId of pipelineState.topicQueue) {
        await orch.completeCurrentTopic(topicId);
      }

      expect(orch.getPipelineState()!.phase).toBe("archiving");
    });

    it("throws when not in_dialogue", async () => {
      const orch = new WeeklyOrchestrator(buildDeps());
      await expect(orch.completeCurrentTopic("any")).rejects.toThrow("No active pipeline");
    });
  });

  describe("pauseReview and continueReview", () => {
    it("pauses and resumes the review", async () => {
      const deps = buildDeps();
      const fakeAi = deps.aiProvider as FakeAiProvider;
      const snapshot = makeSnapshot("frozen");

      fakeAi.setNextTopics({
        topics: snapshot.note_ids.map((id, i) => ({
          note_id: id,
          primary_theme: `Theme ${i}`,
          secondary_links: [],
        })),
      });

      const orch = new WeeklyOrchestrator(deps);
      await orch.startReview(snapshot);
      await orch.startDialogue();

      // Pause
      const paused = await orch.pauseReview();
      expect(paused.pausedFromPhase).toBe("in_dialogue");

      // Resume via continueReview
      const resumed = await orch.continueReview();
      expect(resumed.phase).toBe("in_dialogue");
      expect(resumed.pausedFromPhase).toBeNull();
    });
  });

  describe("finishReview", () => {
    it("completes the review and writes markdown files", async () => {
      const deps = buildDeps();
      const fakeAi = deps.aiProvider as FakeAiProvider;
      const snapshot = makeSnapshot("frozen");
      const markdownFs = deps.markdownFs as MemoryMarkdownFs;

      fakeAi.setNextTopics({
        topics: snapshot.note_ids.map((id, i) => ({
          note_id: id,
          primary_theme: `Theme ${i}`,
          secondary_links: [],
        })),
      });

      const orch = new WeeklyOrchestrator(deps);
      await orch.startReview(snapshot);
      await orch.startDialogue();

      const state = await orch.finishReview();
      expect(state.phase).toBe("completed");
      expect(state.completedAt).not.toBeNull();

      // Verify markdown files were written
      const files = markdownFs.files;
      const filePaths = [...files.keys()];
      expect(filePaths.some((p) => p.includes("每周回顾"))).toBe(true);
      expect(filePaths.some((p) => p.includes("对话归档"))).toBe(true);
      expect(filePaths.some((p) => p.includes("当前明确认可"))).toBe(true);
      expect(filePaths.some((p) => p.includes("已确认观察"))).toBe(true);
      expect(filePaths.some((p) => p.includes("AI工作假设"))).toBe(true);
      expect(filePaths.some((p) => p.includes("待验证想法"))).toBe(true);
    });

    it("throws when pipeline is not in_dialogue or archiving", async () => {
      const orch = new WeeklyOrchestrator(buildDeps());
      await expect(orch.finishReview()).rejects.toThrow("No active pipeline");
    });
  });

  describe("full pipeline: 3 topics one by one then finish", () => {
    it("processes all topics and completes successfully", async () => {
      const deps = buildDeps();
      const fakeAi = deps.aiProvider as FakeAiProvider;
      const snapshot = makeSnapshot("frozen");

      fakeAi.setNextTopics({
        topics: snapshot.note_ids.map((id, i) => ({
          note_id: id,
          primary_theme: `Theme ${i}`,
          secondary_links: [],
        })),
      });

      const orch = new WeeklyOrchestrator(deps);

      // Start review
      let state = await orch.startReview(snapshot);
      expect(state.phase).toBe("topics_prepared");
      expect(state.topicQueue).toHaveLength(3);

      // Start dialogue
      state = await orch.startDialogue();
      expect(state.phase).toBe("in_dialogue");

      // Complete topic 1
      state = await orch.completeCurrentTopic(state.topicQueue[state.currentTopicIndex]!);
      expect(state.currentTopicIndex).toBe(1);

      // Complete topic 2
      state = await orch.completeCurrentTopic(state.topicQueue[state.currentTopicIndex]!);
      expect(state.currentTopicIndex).toBe(2);

      // Complete topic 3 (last one → archiving)
      state = await orch.completeCurrentTopic(state.topicQueue[state.currentTopicIndex]!);
      expect(state.phase).toBe("archiving");

      // Finish
      state = await orch.finishReview();
      expect(state.phase).toBe("completed");
      expect(state.completedAt).not.toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Snapshot lifecycle (completeSnapshot from snapshot.ts)
// ═══════════════════════════════════════════════════════════════

describe("completeSnapshot (snapshot.ts)", () => {
  it("transitions active → completed", () => {
    const active = makeSnapshot("active");
    const completed = completeSnapshot(active);
    expect(completed.status).toBe("completed");
  });

  it("is idempotent for already completed snapshots", () => {
    const completed = makeSnapshot("completed");
    const again = completeSnapshot(completed);
    expect(again).toBe(completed); // same reference (idempotent)
  });

  it("throws for frozen snapshots", () => {
    const frozen = makeSnapshot("frozen");
    expect(() => completeSnapshot(frozen)).toThrow("frozen");
  });

  it("throws for paused snapshots", () => {
    const paused = makeSnapshot("paused");
    expect(() => completeSnapshot(paused)).toThrow("paused");
  });
});
