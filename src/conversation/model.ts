import type { z } from "zod";
import type {
  conversationSchema,
  conversationSeedSchema,
  conversationTurnSchema,
  conversationTurnRoleSchema,
  conversationStatusSchema,
  conversationEndReasonSchema,
} from "./schema";

// ─── Re-exports (typed) ───────────────────────────────────

export type Conversation = Readonly<z.infer<typeof conversationSchema>>;
export type ConversationSeed = Readonly<z.infer<typeof conversationSeedSchema>>;
export type ConversationTurn = Readonly<z.infer<typeof conversationTurnSchema>>;
export type ConversationTurnRole = z.infer<typeof conversationTurnRoleSchema>;
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export type ConversationEndReason = z.infer<typeof conversationEndReasonSchema>;

// ─── Immutability ─────────────────────────────────────────

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

// ─── Clock ───────────────────────────────────────────────

export interface Clock {
  now(): Date;
}

// ─── Lifecycle States ────────────────────────────────────

const VALID_TRANSITIONS: Record<ConversationStatus, readonly ConversationStatus[]> = {
  active: ["paused", "awaiting_summary_confirmation", "completed"],
  paused: ["active"],
  awaiting_summary_confirmation: ["active", "completed"],
  completed: ["active"],  // allow re-discuss
};

/**
 * Pure predicate: returns true when `from → to` is a legal lifecycle transition.
 */
export function isValidTransition(
  from: ConversationStatus,
  to: ConversationStatus,
): boolean {
  return (VALID_TRANSITIONS[from] as readonly string[]).includes(to);
}

// ─── Factory ──────────────────────────────────────────────

/**
 * Create a new active Conversation from any of the three seed variants.
 * Revision starts at 0. No WeeklyReviewRun, snapshotId, or topic cursor required.
 */
export function createConversation(
  seed: ConversationSeed,
  clock: Clock,
): Conversation {
  const now = clock.now().toISOString();
  return deepFreeze({
    id: `conv:${Math.random().toString(36).slice(2, 10)}`,
    seed,
    status: "active" as const,
    revision: 0,
    turns: [],
    created_at: now,
    updated_at: now,
  }) as unknown as Conversation;
}

// ─── Turn Append ─────────────────────────────────────────

/**
 * Append a turn to an active conversation.
 * Throws if the conversation is completed (must reopen first).
 */
export function appendTurn(
  conversation: Conversation,
  role: ConversationTurnRole,
  text: string,
  clock: Clock,
): Conversation {
  if (conversation.status === "completed") {
    throw new Error("Cannot append turn to a completed conversation. Use reopenConversation first.");
  }
  const turn: ConversationTurn = deepFreeze({
    role,
    text,
    timestamp: clock.now().toISOString(),
  }) as unknown as ConversationTurn;
  return deepFreeze({
    ...conversation,
    revision: conversation.revision + 1,
    turns: [...conversation.turns, turn],
    updated_at: clock.now().toISOString(),
  }) as unknown as Conversation;
}

// ─── Lifecycle Transitions ────────────────────────────────

function assertTransition(from: ConversationStatus, to: ConversationStatus): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`Invalid conversation transition: ${from} → ${to}`);
  }
}

function nextRevision(
  conversation: Conversation,
  overrides: Partial<Conversation>,
  clock: Clock,
): Conversation {
  return deepFreeze({
    ...conversation,
    ...overrides,
    revision: conversation.revision + 1,
    updated_at: clock.now().toISOString(),
  }) as unknown as Conversation;
}

/**
 * Pause an active conversation. It can be resumed later.
 */
export function pauseConversation(
  conversation: Conversation,
  clock: Clock,
): Conversation {
  assertTransition(conversation.status, "paused");
  return nextRevision(conversation, { status: "paused" }, clock);
}

/**
 * Resume a paused conversation back to active.
 */
export function resumeConversation(
  conversation: Conversation,
  clock: Clock,
): Conversation {
  assertTransition(conversation.status, "active");
  return nextRevision(conversation, { status: "active" }, clock);
}

/**
 * Transition an active conversation into summary-confirmation mode.
 * The candidate summary text is stored as an assistant turn so the
 * conversation content is preserved in the minimal model.
 */
export function requestSummaryConfirmation(
  conversation: Conversation,
  candidate: string,
  clock: Clock,
): Conversation {
  assertTransition(conversation.status, "awaiting_summary_confirmation");
  // Store the candidate summary as an assistant turn for traceability
  const withTurn = appendTurn(conversation, "assistant", candidate, clock);
  return deepFreeze({
    ...withTurn,
    status: "awaiting_summary_confirmation" as const,
    revision: withTurn.revision, // already incremented by appendTurn
    updated_at: clock.now().toISOString(),
  }) as unknown as Conversation;
}

/**
 * Complete a conversation.
 *
 * - awaiting_summary_confirmation → completed (confirmed_results)
 * - active → completed (no_formal_result)
 */
export function completeConversation(
  conversation: Conversation,
  endReason: ConversationEndReason,
  clock: Clock,
): Conversation {
  assertTransition(conversation.status, "completed");

  // Validate end_reason matches the transition source
  if (
    conversation.status === "awaiting_summary_confirmation" &&
    endReason !== "confirmed_results"
  ) {
    throw new Error(
      "Conversation awaiting summary confirmation must end with confirmed_results",
    );
  }
  if (
    conversation.status === "active" &&
    endReason !== "no_formal_result"
  ) {
    throw new Error(
      "Active conversation must end with no_formal_result",
    );
  }

  return nextRevision(
    conversation,
    { status: "completed", end_reason: endReason },
    clock,
  );
}

/**
 * Reopen a completed conversation for re-discussion.
 * Clears the end_reason — the old conclusion no longer applies.
 */
export function reopenConversation(
  conversation: Conversation,
  clock: Clock,
): Conversation {
  assertTransition(conversation.status, "active");
  return nextRevision(
    conversation,
    { status: "active", end_reason: undefined },
    clock,
  );
}
