import type { Conversation, ConversationStatus } from "./model";
import type { PluginState } from "../storage/plugin-state";

// ─── Error ─────────────────────────────────────────────────

export class ConversationSaveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationSaveConflictError";
  }
}

// ─── Filter ────────────────────────────────────────────────

export interface ConversationListFilter {
  readonly status?: ConversationStatus;
}

// ─── Store Interface ──────────────────────────────────────

export interface ConversationStore {
  /** Save (upsert) a conversation with revision conflict detection. */
  save(conversation: Conversation): void;

  /** Load a single conversation by id, or null if not found. */
  load(id: string): Conversation | null;

  /** List conversations, optionally filtered by status. */
  list(filter?: ConversationListFilter): Conversation[];

  /** Delete a conversation by id. Idempotent — no error if absent. */
  delete(id: string): void;
}

// ─── In-Memory Implementation ─────────────────────────────

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  // ── save ──────────────────────────────────────────────

  save(conversation: Conversation): void {
    const existing = this.conversations.get(conversation.id);

    if (existing === undefined) {
      // First save: revision must be 0
      if (conversation.revision !== 0) {
        throw new ConversationSaveConflictError(
          `Cannot save new conversation with non-zero revision: ${conversation.revision}`,
        );
      }
      this.conversations.set(conversation.id, conversation);
      return;
    }

    // Existing record: check revision
    if (conversation.revision === existing.revision) {
      // Same revision: must be identical content (idempotent)
      if (JSON.stringify(existing) === JSON.stringify(conversation)) {
        return; // Idempotent — no-op
      }
      throw new ConversationSaveConflictError(
        `Revision conflict: same revision ${conversation.revision} with different content`,
      );
    }

    // Update: incoming revision must be greater than existing.
    // KI-T11-01 fix: Multiple model operations (appendTurn, requestSummaryConfirmation,
    // completeConversation) can occur between store.save() calls in the composition→engine
    // flow. Enforcement changed from == existing+1 to > existing to accommodate this.
    // Still catches regressions (incoming <= existing) and duplicate saves (incoming == existing).
    if (conversation.revision <= existing.revision) {
      throw new ConversationSaveConflictError(
        `Revision conflict: expected revision > ${existing.revision}, got ${conversation.revision}`,
      );
    }

    this.conversations.set(conversation.id, conversation);
  }

  // ── load ──────────────────────────────────────────────

  load(id: string): Conversation | null {
    return this.conversations.get(id) ?? null;
  }

  // ── list ──────────────────────────────────────────────

  list(filter?: ConversationListFilter): Conversation[] {
    const all = [...this.conversations.values()];
    if (filter?.status !== undefined) {
      return all.filter((c) => c.status === filter.status);
    }
    return all;
  }

  // ── delete ────────────────────────────────────────────

  delete(id: string): void {
    this.conversations.delete(id);
  }

  // ── test helpers ──────────────────────────────────────

  /** Exposed for testing: total count across all statuses. */
  get size(): number {
    return this.conversations.size;
  }

  /** Exposed for testing: clear every conversation. */
  clear(): void {
    this.conversations.clear();
  }
}

// ─── PluginData-backed Implementation ────────────────────────

/**
 * Persists conversations through the unified PluginState.
 *
 * Reads are synchronous (from in-memory PluginState).
 * Writes update PluginState synchronously and trigger an async
 * flush to data.json (fire-and-forget — last write wins).
 *
 * This means after an Obsidian restart, all conversations saved
 * through this store are restored from data.json via loadPluginState.
 */
export class PluginDataConversationStore implements ConversationStore {
  private readonly getPluginState: () => PluginState;
  private readonly savePluginState: (state: PluginState) => Promise<void>;

  constructor(
    getPluginState: () => PluginState,
    savePluginState: (state: PluginState) => Promise<void>,
  ) {
    this.getPluginState = getPluginState;
    this.savePluginState = savePluginState;
  }

  // ── save ──────────────────────────────────────────────

  save(conversation: Conversation): void {
    const current = this.getPluginState();
    const existing = current.conversations[conversation.id];

    if (existing === undefined) {
      if (conversation.revision !== 0) {
        throw new ConversationSaveConflictError(
          `Cannot save new conversation with non-zero revision: ${conversation.revision}`,
        );
      }
      this.persistConversations(current, conversation.id, conversation);
      return;
    }

    if (conversation.revision === existing.revision) {
      if (JSON.stringify(existing) === JSON.stringify(conversation)) {
        return; // Idempotent
      }
      throw new ConversationSaveConflictError(
        `Revision conflict: same revision ${conversation.revision} with different content`,
      );
    }

    if (conversation.revision <= existing.revision) {
      throw new ConversationSaveConflictError(
        `Revision conflict: expected revision > ${existing.revision}, got ${conversation.revision}`,
      );
    }

    this.persistConversations(current, conversation.id, conversation);
  }

  // ── load ──────────────────────────────────────────────

  load(id: string): Conversation | null {
    const state = this.getPluginState();
    return state.conversations[id] ?? null;
  }

  // ── list ──────────────────────────────────────────────

  list(filter?: import("./store").ConversationListFilter): Conversation[] {
    const all = Object.values(this.getPluginState().conversations);
    if (filter?.status !== undefined) {
      return all.filter((c) => c.status === filter.status);
    }
    return all;
  }

  // ── delete ────────────────────────────────────────────

  delete(id: string): void {
    const current = this.getPluginState();
    const updated = { ...current.conversations };
    delete updated[id];
    const newState: PluginState = { ...current, conversations: updated };
    // Fire-and-forget: don't block on persistence
    this.savePluginState(newState);
  }

  // ── internal ──────────────────────────────────────────

  private persistConversations(
    current: PluginState,
    id: string,
    conversation: Conversation,
  ): void {
    const updated = { ...current.conversations, [id]: conversation };
    const newState: PluginState = { ...current, conversations: updated };
    // Fire-and-forget async persistence — last write wins
    this.savePluginState(newState);
  }
}
