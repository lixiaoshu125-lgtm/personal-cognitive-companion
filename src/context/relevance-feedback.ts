/**
 * User relevance feedback for cognitive context.
 *
 * Allows users to record feedback on whether a retrieved context item
 * (claim, event, or vault snippet) was relevant, misunderstood, etc.
 *
 * Feedback is stored separately from the Conversation module — it does not
 * modify Conversation schema. Callers can persist feedback through their
 * own storage layer.
 */

import type { Conversation } from "../conversation/model";

// ─── Types ──────────────────────────────────────────────────

export type FeedbackType =
  | "not_relevant"
  | "misunderstood"
  | "opinion_changed"
  | "relevant";

export interface RelevanceFeedback {
  readonly conversation_id: string;
  readonly turn_id: number;
  readonly source_type: "claim" | "event" | "vault_snippet";
  readonly source_id: string;
  readonly feedback: FeedbackType;
  readonly timestamp: string;
}

// ─── Feedback Store ─────────────────────────────────────────

/**
 * Minimal feedback storage interface.
 * Implementations can use memory (tests), file system, or Obsidian data API.
 */
export interface FeedbackStore {
  /** Record a single feedback entry. */
  add(feedback: RelevanceFeedback): void;

  /** Get all feedback for a given conversation. */
  getByConversation(conversationId: string): readonly RelevanceFeedback[];

  /** Get feedback for a specific source within a conversation. */
  getBySource(
    conversationId: string,
    sourceType: RelevanceFeedback["source_type"],
    sourceId: string,
  ): readonly RelevanceFeedback[];
}

// ─── In-Memory Implementation ───────────────────────────────

export class InMemoryFeedbackStore implements FeedbackStore {
  private readonly entries: RelevanceFeedback[] = [];

  add(feedback: RelevanceFeedback): void {
    this.entries.push(feedback);
  }

  getByConversation(conversationId: string): readonly RelevanceFeedback[] {
    return this.entries.filter((e) => e.conversation_id === conversationId);
  }

  getBySource(
    conversationId: string,
    sourceType: RelevanceFeedback["source_type"],
    sourceId: string,
  ): readonly RelevanceFeedback[] {
    return this.entries.filter(
      (e) =>
        e.conversation_id === conversationId &&
        e.source_type === sourceType &&
        e.source_id === sourceId,
    );
  }

  /** Exposed for testing: total count. */
  get size(): number {
    return this.entries.length;
  }

  /** Exposed for testing: clear all entries. */
  clear(): void {
    this.entries.length = 0;
  }
}

// ─── Pure Function ──────────────────────────────────────────

/**
 * Record a relevance feedback entry.
 *
 * @param store  — the feedback store to append to
 * @param conversation — the conversation the feedback relates to
 * @param feedback — partial feedback (turn_id, source_type, source_id, feedback)
 * @returns the complete RelevanceFeedback record
 *
 * This is a pure function: it does not modify the Conversation object.
 * The feedback is stored independently and can be linked via conversation_id.
 */
export function recordFeedback(
  store: FeedbackStore,
  conversation: Conversation,
  feedback: Omit<RelevanceFeedback, "conversation_id" | "timestamp">,
): RelevanceFeedback {
  const entry: RelevanceFeedback = {
    conversation_id: conversation.id,
    turn_id: feedback.turn_id,
    source_type: feedback.source_type,
    source_id: feedback.source_id,
    feedback: feedback.feedback,
    timestamp: new Date().toISOString(),
  };

  store.add(entry);
  return entry;
}
