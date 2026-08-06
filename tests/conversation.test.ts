import { describe, expect, it, beforeEach } from "vitest";
import {
  createConversation,
  appendTurn,
  pauseConversation,
  resumeConversation,
  requestSummaryConfirmation,
  completeConversation,
  isValidTransition,
  type Conversation,
  type ConversationSeed,
  type ConversationStatus,
  type ConversationEndReason,
  type Clock,
} from "../src/conversation/model";
import {
  InMemoryConversationStore,
  ConversationSaveConflictError,
  type ConversationStore,
} from "../src/conversation/store";
import { conversationSchema, migrateToLatest } from "../src/conversation/schema";

// ─── Test Clock ────────────────────────────────────────────

function clock(iso: string): Clock {
  const d = new Date(iso);
  return { now: () => d };
}

// ─── Seed Builders ─────────────────────────────────────────

function freeQuestionSeed(
  question = "What should I focus on this week?",
): ConversationSeed {
  return { kind: "free_question", question };
}

function currentNoteSeed(
  noteId = "note-abc",
  notePath = "daily/2026-07-29.md",
): ConversationSeed {
  return { kind: "current_note", note_id: noteId, note_path: notePath };
}

function weeklyTopicSeed(
  topicId = "topic-xyz",
  title = "Review Q3 progress",
  noteIds: string[] = ["note-1", "note-2"],
): ConversationSeed {
  return {
    kind: "weekly_topic",
    topic_id: topicId,
    topic_title: title,
    note_ids: noteIds,
  };
}

// ─── Helper ────────────────────────────────────────────────

function freshConversation(seed?: ConversationSeed): Conversation {
  return createConversation(seed ?? freeQuestionSeed(), clock("2026-07-29T08:00:00Z"));
}

// ───────────────────────────────────────────────────────────
// 12 Required Test Scenarios
// ───────────────────────────────────────────────────────────

describe("Conversation domain model", () => {
  beforeEach(() => {
    // (resetIdSequence was removed — id sequence is per-process, reset not needed)
  });

  // ── Scenario 1: Three seed types create unified Conversations ─

  describe("scenario 1: three seed types unified creation", () => {
    it("creates identical structure from free_question seed", () => {
      const conv = createConversation(
        freeQuestionSeed("What is deliberate practice?"),
        clock("2026-07-29T08:00:00Z"),
      );
      expect(conv.id).toMatch(/^conv:/);
      expect(conv.revision).toBe(0);
      expect(conv.seed).toEqual({
        kind: "free_question",
        question: "What is deliberate practice?",
      });
      expect(conv.status).toBe("active");
      expect(conv.turns).toEqual([]);
      expect(conv.schema_version).toBe(1);
      expect(conv.created_at).toBe("2026-07-29T08:00:00.000Z");
    });

    it("creates identical structure from current_note seed", () => {
      const conv = createConversation(
        { kind: "current_note", note_id: "n1", note_path: "p1.md" },
        clock("2026-07-29T09:00:00Z"),
      );
      expect(conv.id).toMatch(/^conv:/);
      expect(conv.revision).toBe(0);
      expect(conv.seed).toEqual({
        kind: "current_note",
        note_id: "n1",
        note_path: "p1.md",
      });
      expect(conv.status).toBe("active");
      expect(conv.turns).toEqual([]);
      expect(conv.schema_version).toBe(1);
    });

    it("creates identical structure from weekly_topic seed", () => {
      const conv = createConversation(
        { kind: "weekly_topic", topic_id: "t1", topic_title: "Review", note_ids: ["n1"] },
        clock("2026-07-29T10:00:00Z"),
      );
      expect(conv.id).toMatch(/^conv:/);
      expect(conv.revision).toBe(0);
      expect(conv.seed).toEqual({
        kind: "weekly_topic",
        topic_id: "t1",
        topic_title: "Review",
        note_ids: ["n1"],
      });
      expect(conv.status).toBe("active");
      expect(conv.turns).toEqual([]);
      expect(conv.schema_version).toBe(1);
    });

    it("all three seeds produce structurally identical Conversation shapes", () => {
      const a = createConversation(freeQuestionSeed(), clock("2026-07-29T08:00:00Z"));
      const b = createConversation(currentNoteSeed(), clock("2026-07-29T08:00:00Z"));
      const c = createConversation(weeklyTopicSeed(), clock("2026-07-29T08:00:00Z"));

      for (const conv of [a, b, c]) {
        expect(conv).toHaveProperty("id");
        expect(conv).toHaveProperty("revision", 0);
        expect(conv).toHaveProperty("seed");
        expect(conv).toHaveProperty("status", "active");
        expect(conv.end_reason).toBeUndefined();
        expect(conv).toHaveProperty("turns");
        expect(conv.turns).toEqual([]);
        expect(conv).toHaveProperty("created_at");
        expect(conv).toHaveProperty("updated_at");
        expect(conv).toHaveProperty("schema_version", 1);
      }
    });
  });

  // ── Scenario 2: Multiple incomplete Conversations coexist ─

  describe("scenario 2: multiple incomplete conversations coexist", () => {
    it("stores 2+ active and paused conversations simultaneously", () => {
      const store = new InMemoryConversationStore();

      const c1 = freshConversation(freeQuestionSeed("Q1"));
      const c2 = freshConversation(currentNoteSeed("n2", "p2.md"));
      const c3 = freshConversation(weeklyTopicSeed("t3", "T3", ["n3"]));

      store.save(c1);
      store.save(c2);
      store.save(c3);

      // Pause one of them
      const c2p = pauseConversation(c2, clock("2026-07-29T08:05:00Z"));
      store.save(c2p);

      expect(store.size).toBe(3);

      const active = store.list({ status: "active" });
      const paused = store.list({ status: "paused" });

      expect(active).toHaveLength(2);
      expect(paused).toHaveLength(1);

      // All three are incomplete
      const all = store.list();
      const incomplete = all.filter((c) => c.status !== "completed");
      expect(incomplete).toHaveLength(3);
    });

    it("creating a new conversation does not affect existing ones", () => {
      const store = new InMemoryConversationStore();

      const c1 = freshConversation(freeQuestionSeed("First question"));
      store.save(c1);
      const c1b = appendTurn(c1, "user", "my answer", clock("2026-07-29T08:01:00Z"));
      store.save(c1b);

      // Create a second conversation — c1 must be untouched
      const c2 = freshConversation(currentNoteSeed());
      store.save(c2);

      const loaded = store.load(c1b.id)!;
      expect(loaded.turns).toHaveLength(1);
      expect(loaded.turns[0]!.text).toBe("my answer");
      expect(loaded.status).toBe("active");
    });
  });

  // ── Scenario 3: active → paused → active roundtrip ─

  describe("scenario 3: active → paused → active roundtrip", () => {
    it("pauses and resumes with correct revision increments", () => {
      const conv = freshConversation();
      expect(conv.revision).toBe(0);
      expect(conv.status).toBe("active");

      const paused = pauseConversation(conv, clock("2026-07-29T08:05:00Z"));
      expect(paused.revision).toBe(1);
      expect(paused.status).toBe("paused");

      const resumed = resumeConversation(paused, clock("2026-07-29T08:10:00Z"));
      expect(resumed.revision).toBe(2);
      expect(resumed.status).toBe("active");

      // Can append turns after resume
      const withTurn = appendTurn(resumed, "user", "continuing...", clock("2026-07-29T08:15:00Z"));
      expect(withTurn.revision).toBe(3);
      expect(withTurn.turns).toHaveLength(1);
    });

    it("cannot resume a conversation that is not paused", () => {
      expect(() => resumeConversation(freshConversation(), clock("2026-07-29T08:05:00Z")))
        .toThrow("Invalid conversation transition");
    });

    it("cannot pause an already paused conversation", () => {
      const paused = pauseConversation(freshConversation(), clock("2026-07-29T08:05:00Z"));
      expect(() => pauseConversation(paused, clock("2026-07-29T08:10:00Z")))
        .toThrow("Invalid conversation transition");
    });
  });

  // ── Scenario 4: active → awaiting_summary_confirmation ─

  describe("scenario 4: active → awaiting_summary_confirmation", () => {
    it("transitions to awaiting_summary_confirmation and stores candidate as turn", () => {
      const conv = freshConversation();
      const candidate = "Your key insight: deliberate practice needs feedback loops.";

      const awaiting = requestSummaryConfirmation(conv, candidate, clock("2026-07-29T08:05:00Z"));

      expect(awaiting.status).toBe("awaiting_summary_confirmation");
      expect(awaiting.revision).toBeGreaterThan(conv.revision);
      // Candidate text stored as assistant turn
      expect(awaiting.turns).toHaveLength(1);
      expect(awaiting.turns[0]!).toMatchObject({
        role: "assistant",
        text: candidate,
      });
    });
  });

  // ── Scenario 5: awaiting_summary_confirmation → active (reject) ─

  describe("scenario 5: awaiting_summary_confirmation → active", () => {
    it("returns to active when user rejects the summary", () => {
      const conv = freshConversation();
      const awaiting = requestSummaryConfirmation(
        conv,
        "Proposed summary...",
        clock("2026-07-29T08:05:00Z"),
      );
      expect(awaiting.status).toBe("awaiting_summary_confirmation");

      const backToActive = resumeConversation(awaiting, clock("2026-07-29T08:10:00Z"));
      expect(backToActive.status).toBe("active");

      // Can continue appending turns
      const continued = appendTurn(backToActive, "user", "Let me add more...", clock("2026-07-29T08:15:00Z"));
      expect(continued.status).toBe("active");
      expect(continued.turns).toHaveLength(2); // assistant summary + new user turn
    });

    it("revision increments correctly across reject → continue", () => {
      const conv = freshConversation(); // rev 0
      const awaiting = requestSummaryConfirmation(conv, "summary", clock("2026-07-29T08:05:00Z")); // rev 1+turn=2
      const backToActive = resumeConversation(awaiting, clock("2026-07-29T08:10:00Z")); // rev 3
      const continued = appendTurn(backToActive, "user", "more", clock("2026-07-29T08:15:00Z")); // rev 4
      expect(continued.revision).toBeGreaterThan(backToActive.revision);
    });
  });

  // ── Scenario 6: awaiting_summary_confirmation → completed (confirmed) ─

  describe("scenario 6: awaiting_summary_confirmation → completed", () => {
    it("completes with confirmed_results when user confirms the summary", () => {
      const conv = freshConversation();
      const awaiting = requestSummaryConfirmation(
        conv,
        "Key insight summary...",
        clock("2026-07-29T08:05:00Z"),
      );

      const completed = completeConversation(
        awaiting,
        "confirmed_results",
        clock("2026-07-29T08:10:00Z"),
      );

      expect(completed.status).toBe("completed");
      expect(completed.end_reason).toBe("confirmed_results");
    });

    it("rejects confirmed_results completion from active status", () => {
      const conv = freshConversation();
      expect(() =>
        completeConversation(conv, "confirmed_results", clock("2026-07-29T08:05:00Z")),
      ).toThrow("must end with no_formal_result");
    });
  });

  // ── Scenario 7: active → completed (no_formal_result) ─

  describe("scenario 7: active → completed (no_formal_result)", () => {
    it("completes an active conversation with no_formal_result", () => {
      const conv = freshConversation();
      const withTurn = appendTurn(conv, "user", "Not sure about this.", clock("2026-07-29T08:01:00Z"));

      const completed = completeConversation(
        withTurn,
        "no_formal_result",
        clock("2026-07-29T08:05:00Z"),
      );

      expect(completed.status).toBe("completed");
      expect(completed.end_reason).toBe("no_formal_result");
      expect(completed.turns).toHaveLength(1);
    });

    it("rejects no_formal_result completion from awaiting_summary_confirmation", () => {
      const conv = freshConversation();
      const awaiting = requestSummaryConfirmation(
        conv,
        "summary...",
        clock("2026-07-29T08:05:00Z"),
      );

      expect(() =>
        completeConversation(awaiting, "no_formal_result", clock("2026-07-29T08:10:00Z")),
      ).toThrow("must end with confirmed_results");
    });

    it("completed conversation has no formal results, only turns", () => {
      const conv = freshConversation();
      const completed = completeConversation(
        conv,
        "no_formal_result",
        clock("2026-07-29T08:05:00Z"),
      );
      expect(completed.status).toBe("completed");
      expect(completed.end_reason).toBe("no_formal_result");
      // Turns can be empty — no formal output required
      expect(completed.turns).toEqual([]);
    });
  });

  // ── Scenario 8: completed status rejects appendTurn ─

  describe("scenario 8: completed rejects appendTurn", () => {
    it("throws when appending turn to completed conversation", () => {
      const conv = freshConversation();
      const completed = completeConversation(
        conv,
        "no_formal_result",
        clock("2026-07-29T08:05:00Z"),
      );

      expect(() =>
        appendTurn(completed, "user", "trying to add more...", clock("2026-07-29T08:10:00Z")),
      ).toThrow("Cannot append turn to a completed conversation");
    });

    it("throws when appending turn to confirmed_results completed conversation", () => {
      const conv = freshConversation();
      const awaiting = requestSummaryConfirmation(
        conv,
        "summary",
        clock("2026-07-29T08:05:00Z"),
      );
      const completed = completeConversation(
        awaiting,
        "confirmed_results",
        clock("2026-07-29T08:10:00Z"),
      );

      expect(() =>
        appendTurn(completed, "user", "more", clock("2026-07-29T08:15:00Z")),
      ).toThrow("Cannot append turn to a completed conversation");
    });
  });

  // ── Scenario 9: Revision conflict detection ─

  describe("scenario 9: revision conflict detection", () => {
    it("rejects save with stale revision", () => {
      const store = new InMemoryConversationStore();
      const conv = freshConversation(); // revision 0
      store.save(conv);

      // Advance to revision 1
      const updated = appendTurn(conv, "user", "hello", clock("2026-07-29T08:01:00Z"));
      store.save(updated); // revision 1

      // Try to save the old revision 0 again
      expect(() => store.save(conv)).toThrow(ConversationSaveConflictError);
    });

    it("accepts save with multi-step revision increment (KI-T11-01 relaxed enforcement)", () => {
      const store = new InMemoryConversationStore();
      const conv = freshConversation(); // revision 0
      store.save(conv);

      // KI-T11-01: store now allows multi-step increments (> existing).
      // Multiple model operations (appendTurn, requestSummaryConfirmation, etc.)
      // can occur between save() calls in the composition→engine flow.
      const jumped = { ...conv, revision: 5, updated_at: "2026-07-29T08:05:00.000Z" } as Conversation;
      expect(() => store.save(jumped)).not.toThrow();
      expect(store.load(conv.id)!.revision).toBe(5);
    });

    it("rejects save with revision regression", () => {
      const store = new InMemoryConversationStore();
      const conv = freshConversation(); // revision 0
      store.save(conv);

      // Advance to revision 2
      const v1 = appendTurn(conv, "user", "hello", clock("2026-07-29T08:01:00Z"));
      store.save(v1); // revision 1
      const v2 = appendTurn(v1, "assistant", "reply", clock("2026-07-29T08:02:00Z"));
      store.save(v2); // revision 2

      // Try to save revision 1 again — regression
      expect(() => store.save(v1)).toThrow(ConversationSaveConflictError);
    });

    it("rejects save of new conversation with non-zero revision", () => {
      const store = new InMemoryConversationStore();
      const bad = {
        ...freshConversation(),
        revision: 3,
      } as unknown as Conversation;

      expect(() => store.save(bad)).toThrow(ConversationSaveConflictError);
    });
  });

  // ── Scenario 10: Same revision idempotent re-save ─

  describe("scenario 10: same revision idempotent re-save", () => {
    it("allows re-saving the exact same conversation without error", () => {
      const store = new InMemoryConversationStore();
      const conv = freshConversation();
      store.save(conv);
      // Same content, same revision → idempotent
      expect(() => store.save(conv)).not.toThrow();
      expect(store.size).toBe(1);
    });

    it("rejects same revision with different content", () => {
      const store = new InMemoryConversationStore();
      const conv = freshConversation();
      store.save(conv);

      // Same revision but different content
      const modified = {
        ...conv,
        seed: freeQuestionSeed("A different question"),
      } as Conversation;

      expect(() => store.save(modified)).toThrow(ConversationSaveConflictError);
    });

    it("idempotent save after multiple operations", () => {
      const store = new InMemoryConversationStore();
      let conv = freshConversation();
      store.save(conv); // revision 0

      conv = appendTurn(conv, "user", "turn 1", clock("2026-07-29T08:01:00Z"));
      store.save(conv); // revision 1

      // Re-save revision 1 with identical content → no error
      expect(() => store.save(conv)).not.toThrow();
    });
  });

  // ── Scenario 11: Store recovery after "restart" ─

  describe("scenario 11: store recovery after restart", () => {
    it("create → save → destroy → new store → load succeeds", () => {
      // Phase 1: Create and save
      const store1 = new InMemoryConversationStore();
      const conv = freshConversation(freeQuestionSeed("Test persistence"));
      const withTurn = appendTurn(conv, "user", "my message", clock("2026-07-29T08:01:00Z"));
      const paused = pauseConversation(withTurn, clock("2026-07-29T08:05:00Z"));
      store1.save(conv);
      store1.save(withTurn);
      store1.save(paused);

      const id = conv.id;

      // Phase 2: Destroy (simulate restart)
      const store2 = new InMemoryConversationStore();
      // In real Obsidian, the new store would restore from data.json.
      // Here we manually seed the new store with the same data.
      store2.save(conv);
      store2.save(withTurn);
      store2.save(paused);
      // store1 is discarded — store2 now owns the data

      // Phase 3: Load from "recovered" store
      const reloaded = store2.load(id);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.id).toBe(id);
      expect(reloaded!.status).toBe("paused");
      expect(reloaded!.turns).toHaveLength(1);
      expect(reloaded!.turns[0]!.text).toBe("my message");

      // Phase 4: Resume from recovered state
      const resumed = resumeConversation(reloaded!, clock("2026-07-29T08:10:00Z"));
      store2.save(resumed);
      expect(resumed.status).toBe("active");

      // Phase 5: Complete
      const completed = completeConversation(
        resumed,
        "no_formal_result",
        clock("2026-07-29T08:15:00Z"),
      );
      store2.save(completed);
      const final = store2.load(id)!;
      expect(final.status).toBe("completed");
      expect(final.end_reason).toBe("no_formal_result");
    });

    it("serializes and deserializes through JSON without data loss", () => {
      const conv = freshConversation(freeQuestionSeed("JSON roundtrip test"));
      const withTurn = appendTurn(conv, "user", "hello", clock("2026-07-29T08:01:00Z"));

      const json = JSON.stringify(withTurn);
      const parsed = JSON.parse(json);

      // Validate against schema
      const result = conversationSchema.safeParse(parsed);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.id).toBe(conv.id);
        expect(result.data.seed).toEqual(conv.seed);
        expect(result.data.turns).toHaveLength(1);
      }
    });

    it("migrateToLatest accepts valid v1 data", () => {
      const conv = freshConversation();
      const json = JSON.parse(JSON.stringify(conv));
      const migrated = migrateToLatest(json);
      expect(migrated.schema_version).toBe(1);
      expect(migrated.id).toBe(conv.id);
    });
  });

  // ── Scenario 12: No Weekly imports in test file ─
  // (Verified by grep — see task report)

  // ── Additional: isValidTransition exhaustive ─────────────

  describe("isValidTransition", () => {
    it.each([
      ["active", "paused", true],
      ["active", "awaiting_summary_confirmation", true],
      ["active", "completed", true],
      ["paused", "active", true],
      ["awaiting_summary_confirmation", "active", true],
      ["awaiting_summary_confirmation", "completed", true],
      // Invalid transitions
      ["completed", "active", false],
      ["completed", "paused", false],
      ["completed", "awaiting_summary_confirmation", false],
      ["completed", "completed", false],
      ["paused", "completed", false],
      ["paused", "paused", false],
      ["paused", "awaiting_summary_confirmation", false],
      ["active", "active", false],
      ["awaiting_summary_confirmation", "paused", false],
      ["awaiting_summary_confirmation", "awaiting_summary_confirmation", false],
    ] as const)("%s → %s = %s", (from, to, expected) => {
      expect(isValidTransition(from as ConversationStatus, to as ConversationStatus)).toBe(expected);
    });
  });

  // ── Additional: Conversation immutability ─────────────────

  describe("immutability", () => {
    it("frozen conversation rejects mutation", () => {
      const conv = freshConversation();
      expect(Object.isFrozen(conv)).toBe(true);
      expect(() => {
        (conv as { status: string }).status = "paused";
      }).toThrow();
    });

    it("frozen conversation turns array rejects mutation", () => {
      const conv = freshConversation();
      const withTurn = appendTurn(conv, "user", "test", clock("2026-07-29T08:01:00Z"));
      expect(Object.isFrozen(withTurn.turns)).toBe(true);
      expect(() => {
        (withTurn.turns as Conversation["turns"] as unknown as string[]).push("hack");
      }).toThrow();
    });
  });

  // ── Additional: Zod schema validation ────────────────────

  describe("Zod schema validation", () => {
    it("validates a well-formed conversation", () => {
      const conv = freshConversation();
      const json = JSON.parse(JSON.stringify(conv));
      expect(conversationSchema.safeParse(json).success).toBe(true);
    });

    it("rejects completed without end_reason", () => {
      const conv = freshConversation();
      const raw = JSON.parse(JSON.stringify(conv)) as Record<string, unknown>;
      raw.status = "completed";
      const result = conversationSchema.safeParse(raw);
      expect(result.success).toBe(false);
    });

    it("rejects end_reason on non-completed conversation", () => {
      const conv = freshConversation();
      const raw = JSON.parse(JSON.stringify(conv)) as Record<string, unknown>;
      raw.end_reason = "no_formal_result";
      const result = conversationSchema.safeParse(raw);
      expect(result.success).toBe(false);
    });

    it("rejects invalid seed kind", () => {
      const conv = freshConversation();
      const raw = JSON.parse(JSON.stringify(conv)) as Record<string, unknown>;
      raw.seed = { kind: "bogus" };
      const result = conversationSchema.safeParse(raw);
      expect(result.success).toBe(false);
    });

    it("rejects negative revision", () => {
      const conv = freshConversation();
      const raw = JSON.parse(JSON.stringify(conv)) as Record<string, unknown>;
      raw.revision = -5;
      const result = conversationSchema.safeParse(raw);
      expect(result.success).toBe(false);
    });

    it("rejects empty id", () => {
      const conv = freshConversation();
      const raw = JSON.parse(JSON.stringify(conv)) as Record<string, unknown>;
      raw.id = "";
      const result = conversationSchema.safeParse(raw);
      expect(result.success).toBe(false);
    });

    it("validates free_question seed with enable_vault_search", () => {
      const conv = createConversation(
        { kind: "free_question", question: "test", enable_vault_search: true },
        clock("2026-07-29T08:00:00Z"),
      );
      const json = JSON.parse(JSON.stringify(conv));
      const result = conversationSchema.safeParse(json);
      expect(result.success).toBe(true);
      if (result.success) {
        const seed = result.data.seed;
        if (seed.kind === "free_question") {
          expect(seed.enable_vault_search).toBe(true);
        }
      }
    });
  });
});
