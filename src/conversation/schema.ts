import { z } from "zod";

// ─── Helpers ─────────────────────────────────────────────────

const identifierSchema = z.string().trim().min(1);

// ─── Conversation Seed ──────────────────────────────────────

const freeQuestionSeedSchema = z.strictObject({
  kind: z.literal("free_question"),
  question: identifierSchema,
  enable_vault_search: z.boolean().optional(),
});

const currentNoteSeedSchema = z.strictObject({
  kind: z.literal("current_note"),
  note_id: identifierSchema,
  note_path: identifierSchema,
});

const weeklyTopicSeedSchema = z.strictObject({
  kind: z.literal("weekly_topic"),
  topic_id: identifierSchema,
  topic_title: identifierSchema,
  note_ids: z.array(identifierSchema),
});

export const conversationSeedSchema = z.union([
  freeQuestionSeedSchema,
  currentNoteSeedSchema,
  weeklyTopicSeedSchema,
]);

// ─── Conversation Turn ──────────────────────────────────────

export const conversationTurnRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
]);

export const conversationTurnSchema = z.strictObject({
  role: conversationTurnRoleSchema,
  text: z.string(),
  timestamp: z.string(),
});

// ─── Status & End Reason ────────────────────────────────────

export const conversationStatusSchema = z.enum([
  "active",
  "paused",
  "awaiting_summary_confirmation",
  "completed",
]);

export const conversationEndReasonSchema = z.enum([
  "confirmed_results",
  "no_formal_result",
]);

// ─── Full Conversation ──────────────────────────────────────

export const conversationSchema = z.strictObject({
  id: identifierSchema,
  revision: z.number().int().nonnegative(),
  seed: conversationSeedSchema,
  status: conversationStatusSchema,
  end_reason: conversationEndReasonSchema.optional(),
  turns: z.array(conversationTurnSchema),
  created_at: z.string(),
  updated_at: z.string(),
  schema_version: z.literal(1),
}).superRefine((conv, ctx) => {
  if (conv.status === "completed" && conv.end_reason === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["end_reason"],
      message: "A completed conversation must have an end_reason",
    });
  }
  if (conv.status !== "completed" && conv.end_reason !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["end_reason"],
      message: "Only a completed conversation may have an end_reason",
    });
  }
});

// ─── Schema Version ─────────────────────────────────────────

export const LATEST_SCHEMA_VERSION = 1;

// ─── Migration Stub ─────────────────────────────────────────
// v1 is the current version; future migrations go here.

export function migrateToLatest(data: unknown): z.infer<typeof conversationSchema> {
  return conversationSchema.parse(data);
}
