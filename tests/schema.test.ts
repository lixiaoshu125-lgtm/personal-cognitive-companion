import { describe, expect, expectTypeOf, it } from "vitest";
import type { WeeklySnapshot } from "../src/domain/types";
import {
  claimSchema,
  dialogueSessionSchema,
  goalStateSchema,
  validationExperimentListSchema,
  weeklySnapshotSchema
} from "../src/domain/schema";

const validClaim = {
  schema_version: "1.1",
  claim_id: "claim-001",
  canonical_text: "A synthetic claim for contract testing.",
  claim_type: "current_viewpoint",
  epistemic_status: "user_confirmed",
  user_stance: "endorsed",
  objective_truth_status: "supported",
  formed_at: "2017—2026（由年度材料综合形成）",
  time_scope: "过去七年至当前",
  applicable_contexts: ["synthetic-context"],
  scope_limits: "只用于合成契约测试",
  source_note_ids: [],
  source_topic_ids: [],
  source_dialogue_refs: ["dialogue-synthetic-001"],
  support_evidence_ids: [],
  counterexample_candidate_ids: [],
  missing_context: "早期背景需要用户对话确认",
  version: 1,
  created_at: "2026-07-01",
  updated_at: "2026-07-01"
};

describe("domain schemas", () => {
  it("accepts a complete v1.1 claim", () => {
    expect(claimSchema.parse(validClaim)).toEqual(validClaim);
  });

  it("rejects epistemic states outside the audited v1.1 set", () => {
    const parsed = claimSchema.safeParse({ ...validClaim, epistemic_status: "probably_true" });
    expect(parsed.success).toBe(false);
  });

  it.each([
    ["user_confirmed", "unconfirmed"],
    ["ai_inferred", "endorsed"],
    ["to_verify", "endorsed"],
    ["rejected", "endorsed"],
    ["superseded", "endorsed"]
  ])("rejects the invalid epistemic/user stance pair %s/%s", (epistemicStatus, userStance) => {
    expect(claimSchema.safeParse({
      ...validClaim,
      epistemic_status: epistemicStatus,
      user_stance: userStance
    }).success).toBe(false);
  });

  it("requires frozen snapshot identity and source immutability fields", () => {
    const parsed = weeklySnapshotSchema.safeParse({
      snapshot_id: "snapshot-001",
      created_at: "2026-07-26T00:00:00.000Z",
      frozen_at: "2026-07-26T00:00:00.000Z",
      source_revision: "sha256:synthetic",
      note_ids: ["note-001"],
      cursor: 0,
      status: "paused"
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.isFrozen(parsed.data)).toBe(true);
      expect(Object.isFrozen(parsed.data.note_ids)).toBe(true);
    }
    expect(weeklySnapshotSchema.safeParse({
      snapshot_id: "snapshot-001",
      created_at: "2026-07-26T00:00:00.000Z",
      note_ids: ["note-001"],
      cursor: 0,
      status: "paused"
    }).success).toBe(false);
  });

  it("enforces one visible question through dialogue lifecycle states", () => {
    const base = {
      session_id: "session-001",
      snapshot_id: "snapshot-001",
      status: "active",
      active_question: "What matters most here?",
      current_topic_index: 0,
      created_at: "2026-07-26T00:00:00.000Z",
      updated_at: "2026-07-26T00:00:00.000Z"
    };
    expect(dialogueSessionSchema.safeParse(base).success).toBe(true);
    expect(dialogueSessionSchema.safeParse({ ...base, active_question: null }).success).toBe(false);
    expect(dialogueSessionSchema.safeParse({ ...base, status: "paused" }).success).toBe(true);
    expect(dialogueSessionSchema.safeParse({ ...base, status: "completed", active_question: null }).success).toBe(true);
    expect(dialogueSessionSchema.safeParse({ ...base, status: "completed" }).success).toBe(false);
    expect(dialogueSessionSchema.safeParse({ ...base, pending_questions: ["A second visible question"] }).success).toBe(false);
  });

  it("limits active long-term goals while retaining completed history and lower-priority ideas", () => {
    const goal = (id: string, status = "active", horizon = "long_term") => ({
      goal_id: id,
      text: `Synthetic goal ${id}`,
      horizon,
      status
    });
    expect(goalStateSchema.safeParse({
      long_term_goals: [goal("1"), goal("2"), goal("3"), goal("old-1", "completed"), goal("old-2", "completed")],
      lower_priority_candidates: [goal("later", "candidate")],
      super_long_term_candidates: [goal("distant", "candidate", "super_long_term")],
      weekly_result: null
    }).success).toBe(true);
    expect(goalStateSchema.safeParse({
      long_term_goals: [goal("1"), goal("2"), goal("3"), goal("4")],
      lower_priority_candidates: [],
      super_long_term_candidates: [],
      weekly_result: null
    }).success).toBe(false);
  });

  it("does not allow active goals to bypass the limit as lower-priority candidates", () => {
    const activeGoal = (id: string) => ({
      goal_id: id,
      text: `Synthetic active goal ${id}`,
      horizon: "long_term",
      status: "active"
    });
    expect(goalStateSchema.safeParse({
      long_term_goals: [activeGoal("1"), activeGoal("2"), activeGoal("3")],
      lower_priority_candidates: [activeGoal("hidden-fourth")],
      super_long_term_candidates: [],
      weekly_result: null
    }).success).toBe(false);
  });

  it("enforces goal bucket status semantics and globally unique goal ids", () => {
    const goal = (id: string, status: string, horizon = "long_term") => ({
      goal_id: id, text: `Goal ${id}`, horizon, status
    });
    const base = {
      long_term_goals: [goal("active", "active"), goal("done", "completed"), goal("paused", "paused")],
      lower_priority_candidates: [goal("later", "candidate")],
      super_long_term_candidates: [goal("distant", "candidate", "super_long_term")],
      weekly_result: goal("week", "active", "weekly")
    };

    expect(goalStateSchema.safeParse(base).success).toBe(true);
    expect(goalStateSchema.safeParse({ ...base, long_term_goals: [goal("candidate", "candidate")] }).success).toBe(false);
    expect(goalStateSchema.safeParse({ ...base, lower_priority_candidates: [goal("later", "paused")] }).success).toBe(false);
    expect(goalStateSchema.safeParse({ ...base, super_long_term_candidates: [goal("distant", "completed", "super_long_term")] }).success).toBe(false);
    expect(goalStateSchema.safeParse({ ...base, weekly_result: goal("week", "completed", "weekly") }).success).toBe(false);
    expect(goalStateSchema.safeParse({ ...base, weekly_result: goal("active", "active", "weekly") }).success).toBe(false);
    expect(goalStateSchema.safeParse({ ...base, super_long_term_candidates: [goal("later", "candidate", "super_long_term")] }).success).toBe(false);
  });

  it("derives validation duration from start and deadline", () => {
    const experiment = {
      experiment_id: "duration",
      hypothesis_claim_id: "claim-duration",
      action: "Synthetic duration check",
      status: "active",
      started_at: "2026-07-26T00:00:00.000Z",
      deadline_at: "2026-07-26T00:29:59.000Z",
      expected_minutes: 60
    };
    expect(validationExperimentListSchema.safeParse([experiment]).success).toBe(false);
    expect(validationExperimentListSchema.safeParse([{ ...experiment, deadline_at: "2026-07-25T23:00:00.000Z" }]).success).toBe(false);
    expect(validationExperimentListSchema.safeParse([{ ...experiment, deadline_at: "2026-08-02T00:00:01.000Z" }]).success).toBe(false);
    expect(validationExperimentListSchema.safeParse([{ ...experiment, deadline_at: "2026-08-02T00:00:00.000Z" }]).success).toBe(true);
  });

  it("exposes snapshot note ids as a deeply readonly collection", () => {
    expectTypeOf<WeeklySnapshot["note_ids"]>().toEqualTypeOf<readonly string[]>();
  });

  it("limits active validation experiments to five", () => {
    const experiment = (id: string) => ({
      experiment_id: id,
      hypothesis_claim_id: `claim-${id}`,
      action: `Synthetic action ${id}`,
      status: "active",
      started_at: "2026-07-26T00:00:00.000Z",
      deadline_at: "2026-07-26T01:00:00.000Z",
      expected_minutes: 60
    });
    expect(validationExperimentListSchema.safeParse(Array.from({ length: 5 }, (_, index) => experiment(String(index)))).success).toBe(true);
    expect(validationExperimentListSchema.safeParse(Array.from({ length: 6 }, (_, index) => experiment(String(index)))).success).toBe(false);
  });
});
