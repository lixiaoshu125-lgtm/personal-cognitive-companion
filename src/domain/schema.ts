import { z } from "zod";

const identifierSchema = z.string().trim().min(1);
const timestampSchema = z.iso.datetime({ offset: true });
const dateOrTimestampSchema = z.union([z.iso.date(), timestampSchema]);

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? ReadonlyArray<DeepReadonly<Item>>
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const epistemicStatusSchema = z.enum([
  "user_confirmed",
  "ai_inferred",
  "to_verify",
  "rejected",
  "superseded"
]);

export const claimSchema = z.strictObject({
  schema_version: z.literal("1.1"),
  claim_id: identifierSchema,
  canonical_text: z.string().trim().min(1),
  claim_type: z.enum([
    "observation",
    "current_viewpoint",
    "historical_viewpoint",
    "pattern_hypothesis",
    "causal_hypothesis",
    "open_question"
  ]),
  epistemic_status: epistemicStatusSchema,
  user_stance: z.enum(["endorsed", "rejected", "superseded", "unconfirmed"]),
  objective_truth_status: z.enum(["unknown", "supported", "contested", "rejected", "superseded"]),
  formed_at: z.string(),
  time_scope: z.string().trim().min(1),
  applicable_contexts: z.array(z.string()),
  scope_limits: z.string(),
  source_note_ids: z.array(identifierSchema),
  source_topic_ids: z.array(identifierSchema),
  source_dialogue_refs: z.array(identifierSchema),
  support_evidence_ids: z.array(identifierSchema),
  counterexample_candidate_ids: z.array(identifierSchema),
  missing_context: z.string(),
  version: z.number().int().positive(),
  created_at: dateOrTimestampSchema,
  updated_at: dateOrTimestampSchema
}).superRefine((claim, context) => {
  const requiredStance = {
    user_confirmed: "endorsed",
    ai_inferred: "unconfirmed",
    to_verify: "unconfirmed",
    rejected: "rejected",
    superseded: "superseded"
  } as const;
  if (claim.user_stance !== requiredStance[claim.epistemic_status]) {
    context.addIssue({
      code: "custom",
      path: ["user_stance"],
      message: `The ${claim.epistemic_status} status requires the ${requiredStance[claim.epistemic_status]} stance`
    });
  }
});

export const evidenceLinkSchema = z.strictObject({
  evidence_id: identifierSchema,
  claim_id: identifierSchema,
  source_type: z.enum([
    "note",
    "topic",
    "user_dialogue",
    "annual_summary",
    "counterexample_candidate",
    "scope_limit",
    "alternative_explanation"
  ]),
  source_ids: z.array(identifierSchema).min(1),
  evidence_role: z.enum(["support", "counterexample_candidate", "scope_limit", "alternative_explanation"]),
  verification_status: z.enum(["verified", "requires_user_dialogue", "unverified"]),
  description: z.string(),
  confidence: z.enum(["low", "medium", "high"])
});

export const weeklySnapshotSchema = z.strictObject({
  snapshot_id: identifierSchema,
  created_at: timestampSchema,
  frozen_at: timestampSchema,
  source_revision: identifierSchema,
  note_ids: z.array(identifierSchema),
  cursor: z.number().int().nonnegative(),
  status: z.enum(["frozen", "active", "paused", "completed"])
}).transform(deepFreeze);

export const dialogueSessionSchema = z.strictObject({
  session_id: identifierSchema,
  snapshot_id: identifierSchema,
  status: z.enum(["active", "paused", "awaiting_zero_confirmation", "completed"]),
  active_question: z.string().trim().min(1).nullable(),
  current_topic_index: z.number().int().nonnegative(),
  created_at: timestampSchema,
  updated_at: timestampSchema
}).superRefine((session, context) => {
  if ((session.status === "active" || session.status === "awaiting_zero_confirmation") && session.active_question === null) {
    context.addIssue({ code: "custom", path: ["active_question"], message: "This session state requires exactly one active question" });
  }
  if (session.status === "completed" && session.active_question !== null) {
    context.addIssue({ code: "custom", path: ["active_question"], message: "A completed session cannot retain an active question" });
  }
});

export const goalSchema = z.strictObject({
  goal_id: identifierSchema,
  text: z.string().trim().min(1),
  horizon: z.enum(["weekly", "long_term", "super_long_term"]),
  status: z.enum(["active", "candidate", "completed", "paused"])
});

export const goalStateSchema = z.strictObject({
  long_term_goals: z.array(goalSchema),
  lower_priority_candidates: z.array(goalSchema),
  super_long_term_candidates: z.array(goalSchema),
  weekly_result: goalSchema.nullable()
}).superRefine((state, context) => {
  if (state.long_term_goals.some((goal) => goal.horizon !== "long_term")) {
    context.addIssue({ code: "custom", path: ["long_term_goals"], message: "Long-term goals must use the long_term horizon" });
  }
  if (state.super_long_term_candidates.some((goal) => goal.horizon !== "super_long_term")) {
    context.addIssue({ code: "custom", path: ["super_long_term_candidates"], message: "Super-long-term candidates must use the super_long_term horizon" });
  }
  if (state.lower_priority_candidates.some((goal) => goal.horizon !== "long_term")) {
    context.addIssue({ code: "custom", path: ["lower_priority_candidates"], message: "Lower-priority candidates must use the long_term horizon" });
  }
  if (state.lower_priority_candidates.some((goal) => goal.status === "active")) {
    context.addIssue({ code: "custom", path: ["lower_priority_candidates"], message: "Lower-priority candidates cannot be active goals" });
  }
  if (state.long_term_goals.some((goal) => !(["active", "completed", "paused"] as const).includes(
    goal.status as "active" | "completed" | "paused"
  ))) {
    context.addIssue({ code: "custom", path: ["long_term_goals"], message: "Long-term goals may be active, completed, or paused" });
  }
  if (state.lower_priority_candidates.some((goal) => goal.status !== "candidate")) {
    context.addIssue({ code: "custom", path: ["lower_priority_candidates"], message: "Lower-priority goals must remain candidates" });
  }
  if (state.super_long_term_candidates.some((goal) => goal.status !== "candidate")) {
    context.addIssue({ code: "custom", path: ["super_long_term_candidates"], message: "Super-long-term goals must remain candidates" });
  }
  if (state.long_term_goals.filter((goal) => goal.status === "active").length > 3) {
    context.addIssue({ code: "custom", path: ["long_term_goals"], message: "At most three long-term goals may be active" });
  }
  if (state.weekly_result !== null && state.weekly_result.horizon !== "weekly") {
    context.addIssue({ code: "custom", path: ["weekly_result"], message: "The weekly result must use the weekly horizon" });
  }
  if (state.weekly_result !== null && state.weekly_result.status !== "active") {
    context.addIssue({ code: "custom", path: ["weekly_result"], message: "The weekly result must be active" });
  }
  const allGoalIds = [
    ...state.long_term_goals,
    ...state.lower_priority_candidates,
    ...state.super_long_term_candidates,
    ...(state.weekly_result === null ? [] : [state.weekly_result])
  ].map((goal) => goal.goal_id);
  if (new Set(allGoalIds).size !== allGoalIds.length) {
    context.addIssue({ code: "custom", message: "Duplicate goal id across goal state buckets" });
  }
});

export const validationExperimentSchema = z.strictObject({
  experiment_id: identifierSchema,
  hypothesis_claim_id: identifierSchema,
  action: z.string().trim().min(1),
  status: z.enum(["active", "backlog", "completed", "cancelled"]),
  started_at: timestampSchema,
  deadline_at: timestampSchema,
  expected_minutes: z.number().int().min(30).max(7 * 24 * 60)
}).superRefine((experiment, context) => {
  const durationMilliseconds = Date.parse(experiment.deadline_at) - Date.parse(experiment.started_at);
  const minimumMilliseconds = 30 * 60 * 1000;
  const maximumMilliseconds = 7 * 24 * 60 * 60 * 1000;
  if (durationMilliseconds < minimumMilliseconds || durationMilliseconds > maximumMilliseconds) {
    context.addIssue({
      code: "custom",
      path: ["deadline_at"],
      message: "Validation deadline must be between 30 minutes and 7 days after its start"
    });
  }
});

export const validationExperimentListSchema = z.array(validationExperimentSchema).superRefine((experiments, context) => {
  if (experiments.filter((experiment) => experiment.status === "active").length > 5) {
    context.addIssue({ code: "custom", message: "At most five validation experiments may be active" });
  }
});
