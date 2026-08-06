/**
 * Weekly Preparation Store — Task 08
 *
 * Persistence layer for WeeklyPreparationState.
 * Stores through the unified PluginState (NOT by directly manipulating
 * data.json), ensuring the Zod schema always sees valid state shape.
 */

import type { WeeklyPreparationState, PreparedTopic } from "./preparation-service";
import type { PluginState } from "../storage/plugin-state";

// ═══════════════════════════════════════════════════════════════
// Store interface
// ═══════════════════════════════════════════════════════════════

export interface WeeklyPreparationStore {
  /** Save complete state atomically. */
  save(state: WeeklyPreparationState): Promise<void>;

  /** Load state, or null if never saved. */
  load(): Promise<WeeklyPreparationState | null>;

  /** Atomically update a single topic within the state. */
  updateTopic(
    topicId: string,
    update: Partial<PreparedTopic>,
  ): Promise<PreparedTopic>;
}

// ═══════════════════════════════════════════════════════════════
// In-memory implementation (for testing)
// ═══════════════════════════════════════════════════════════════

export class InMemoryPreparationStore implements WeeklyPreparationStore {
  private state: WeeklyPreparationState | null = null;
  private saveShouldFail = false;

  async save(state: WeeklyPreparationState): Promise<void> {
    if (this.saveShouldFail) {
      throw new Error("Save failed (simulated)");
    }
    this.state = structuredClone(state) as WeeklyPreparationState;
  }

  async load(): Promise<WeeklyPreparationState | null> {
    if (this.state === null) return null;
    return structuredClone(this.state) as WeeklyPreparationState;
  }

  async updateTopic(
    topicId: string,
    update: Partial<PreparedTopic>,
  ): Promise<PreparedTopic> {
    if (this.state === null) {
      throw new Error(`Cannot update topic: no state loaded. Topic: ${topicId}`);
    }

    const index = this.state.topics.findIndex((t) => t.topic_id === topicId);
    if (index === -1) {
      throw new Error(`Topic not found: ${topicId}`);
    }

    const existing = this.state.topics[index]!;
    const updated: PreparedTopic = {
      ...existing,
      ...update,
      // Ensure these are preserved from existing if not in update
      topic_id: existing.topic_id,
    } as PreparedTopic;

    const newTopics = [...this.state.topics];
    newTopics[index] = updated;

    this.state = {
      ...this.state,
      topics: newTopics,
    };

    return updated;
  }

  // ── Test helpers ────────────────────────────────────────────

  setSaveShouldFail(shouldFail: boolean): void {
    this.saveShouldFail = shouldFail;
  }

  /** Directly set state for testing (bypasses save). */
  setState(state: WeeklyPreparationState): void {
    this.state = structuredClone(state) as WeeklyPreparationState;
  }

  /** Clear all stored state. */
  clear(): void {
    this.state = null;
    this.saveShouldFail = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Plugin data persistence implementation
// ═══════════════════════════════════════════════════════════════

/**
 * A store implementation that persists WeeklyPreparationState through
 * the unified PluginState object.
 *
 * Unlike the previous implementation, this does NOT directly read/write
 * data.json. Instead, it works through PluginState getter/setter callbacks,
 * ensuring all state passes through the Zod schema validation on load.
 */
export class PluginDataPreparationStore implements WeeklyPreparationStore {
  constructor(
    private readonly getPluginState: () => PluginState,
    private readonly savePluginState: (state: PluginState) => Promise<void>,
  ) {}

  async save(state: WeeklyPreparationState): Promise<void> {
    const current = this.getPluginState();
    const updated: PluginState = { ...current, weeklyPreparation: state };
    await this.savePluginState(updated);
  }

  async load(): Promise<WeeklyPreparationState | null> {
    return this.getPluginState().weeklyPreparation ?? null;
  }

  async updateTopic(
    topicId: string,
    update: Partial<PreparedTopic>,
  ): Promise<PreparedTopic> {
    const current = this.getPluginState();
    const wpState = current.weeklyPreparation;
    if (wpState === null) {
      throw new Error(`Cannot update topic: no state loaded. Topic: ${topicId}`);
    }

    const index = wpState.topics.findIndex((t) => t.topic_id === topicId);
    if (index === -1) {
      throw new Error(`Topic not found: ${topicId}`);
    }

    const existing = wpState.topics[index]!;
    const updatedTopic: PreparedTopic = {
      ...existing,
      ...update,
      topic_id: existing.topic_id,
    } as PreparedTopic;

    const newTopics = [...wpState.topics];
    newTopics[index] = updatedTopic;

    const newWpState: WeeklyPreparationState = {
      ...wpState,
      topics: newTopics,
    };

    const updated: PluginState = { ...current, weeklyPreparation: newWpState };
    await this.savePluginState(updated);
    return updatedTopic;
  }
}
