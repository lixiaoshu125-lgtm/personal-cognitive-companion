/**
 * Fake/Test implementations for temp-vault E2E journey tests (Task 11).
 *
 * Each Fake component simulates a real service:
 *   - FakeAiProvider         → DeepSeek V4 Pro
 *   - FakeVaultAdapter       → Obsidian Vault API (with frontmatter exclusion)
 *   - FakeArchiveWriter      → VaultArchiveWriter (with fault injection)
 *   - FakeWritebackRepo      → PluginCognitiveRepository (with revision conflict)
 *   - FakeWeeklyPrepStore    → WeeklyPreparationStore
 *
 * Replace with real implementations for:
 *   - FakeAiProvider        → DeepSeekProvider (src/ai/deepseek.ts)
 *   - FakeVaultAdapter      → Obsidian Vault instance (src/vault/adapter.ts)
 *   - FakeArchiveWriter     → VaultArchiveWriter (src/conversation/archive-writer.ts)
 *   - FakeWritebackRepo     → PluginCognitiveRepository (src/storage/repository.ts)
 *   - FakeWeeklyPrepStore   → PluginDataPreparationStore (src/weekly/preparation-store.ts)
 */

import type { AiProvider, AiCompletionRequest } from "../../src/ai/provider";
import { AiProviderError } from "../../src/ai/provider";
import type { VaultAdapter } from "../../src/vault/adapter";
import type { Conversation } from "../../src/conversation/model";
import type { ConversationStore } from "../../src/conversation/store";
import { InMemoryConversationStore } from "../../src/conversation/store";
// Stub types (was in deleted src/conversation/writeback)
export interface WritebackResult {
  readonly status: "committed" | "retryable_error" | "fatal_error";
  readonly claim_ids?: readonly string[];
  readonly error?: string;
  readonly conversation_still_active?: boolean;
}

export interface ConfirmedClaim {
  readonly candidate_id: string;
  readonly canonical_text: string;
  readonly epistemic_status: "user_confirmed";
}

export interface WritebackRepository {
  commitClaims(
    claims: readonly ConfirmedClaim[],
    idempotencyKey: string,
  ): Promise<WritebackResult>;
}
import type { ConversationArchive } from "../../src/conversation/archive";
import type {
  WeeklyPreparationState,
  PreparedTopic,
} from "../../src/weekly/preparation-service";
import type { WeeklyPreparationStore } from "../../src/weekly/preparation-store";
import { ConversationSaveConflictError } from "../../src/conversation/store";

// ═══════════════════════════════════════════════════════════════════
// FakeAiProvider — routes by outputName, supports fault injection
// ═══════════════════════════════════════════════════════════════════

type FakeAiOutput = Record<string, unknown>;

interface FakeAiRoute {
  outputName: string;
  output: FakeAiOutput;
}

type FakeAiFault =
  | { kind: "throw"; error: Error }
  | { kind: "invalid_json"; output: unknown };

export class FakeAiProvider implements AiProvider {
  private routes: FakeAiRoute[] = [];
  private fault: FakeAiFault | null = null;
  private callCount = 0;
  /** Record of all calls for inspection. */
  public readonly calls: Array<{ request: AiCompletionRequest<unknown>; output: unknown }> = [];

  /** Configure a canned output for a specific outputName. */
  route(outputName: string, output: FakeAiOutput): void {
    // Remove existing route for this outputName and add new one
    this.routes = this.routes.filter((r) => r.outputName !== outputName);
    this.routes.push({ outputName, output });
  }

  /** Configure a fault to throw on the next call. */
  setFault(fault: FakeAiFault): void {
    this.fault = fault;
  }

  /** Reset all routing and fault state. */
  reset(): void {
    this.routes = [];
    this.fault = null;
    this.callCount = 0;
    this.calls.length = 0;
  }

  getCallCount(): number {
    return this.callCount;
  }

  async complete<Output>(
    request: AiCompletionRequest<Output>,
    _signal?: AbortSignal,
  ): Promise<Output> {
    this.callCount++;

    // Check fault injection first
    if (this.fault) {
      const f = this.fault;
      this.fault = null; // One-shot fault
      if (f.kind === "throw") {
        // Record the call before throwing
        this.calls.push({ request: request as AiCompletionRequest<unknown>, output: null });
        throw f.error;
      }
      // invalid_json: return the raw output (will fail schema validation)
      this.calls.push({ request: request as AiCompletionRequest<unknown>, output: f.output });
      return f.output as unknown as Output;
    }

    // Route by outputName
    const route = this.routes.find((r) => r.outputName === request.outputName);
    if (route) {
      this.calls.push({ request: request as AiCompletionRequest<unknown>, output: route.output });
      return route.output as unknown as Output;
    }

    // Default: throw with helpful message
    throw new Error(
      `FakeAiProvider: no route configured for outputName="${request.outputName}". ` +
      `Call fakeAi.route("${request.outputName}", output) to configure.`,
    );
  }

  /** Get the count of messages (system + user + assistant) in the last request for a given outputName. */
  getLastRequestMessages(outputName: string): string[] {
    const lastCall = [...this.calls].reverse().find(
      (c) => (c.request as AiCompletionRequest<unknown>).outputName === outputName,
    );
    if (!lastCall) return [];
    return lastCall.request.messages.map((m) => m.content);
  }

  /** Check if any request messages contain a specific string. */
  anyRequestContains(text: string): boolean {
    for (const call of this.calls) {
      for (const msg of call.request.messages) {
        if (msg.content.includes(text)) return true;
      }
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FakeVaultAdapter — in-memory file system with frontmatter support
// ═══════════════════════════════════════════════════════════════════

export interface VaultFileDef {
  path: string;
  content: string;
}

export class FakeVaultAdapter implements VaultAdapter {
  private files: Map<string, string>;

  constructor(files: VaultFileDef[] = []) {
    this.files = new Map();
    for (const f of files) {
      this.files.set(f.path, f.content);
    }
  }

  /** Add or overwrite a file. */
  putFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  /** Remove a file. */
  removeFile(path: string): void {
    this.files.delete(path);
  }

  /** Get all file paths (readonly). */
  getPaths(): string[] {
    return [...this.files.keys()];
  }

  async listFiles(): Promise<readonly { path: string }[]> {
    return [...this.files.keys()].map((path) => ({ path }));
  }

  async readText(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FakeConversationStore — wraps InMemoryConversationStore with
// restart simulation support (export/import for shared state)
// ═══════════════════════════════════════════════════════════════════

export class FakeConversationStore implements ConversationStore {
  private store = new InMemoryConversationStore();

  save(conversation: Conversation): void {
    this.store.save(conversation);
  }

  load(id: string): Conversation | null {
    return this.store.load(id);
  }

  list(): Conversation[] {
    return this.store.list();
  }

  delete(id: string): void {
    this.store.delete(id);
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  /** Export all conversations (used to simulate restart with shared data). */
  exportAll(): Conversation[] {
    return this.store.list();
  }

  /** Import conversations (used to simulate restart recovery). */
  importAll(conversations: Conversation[]): void {
    for (const conv of conversations) {
      try {
        this.store.save(conv);
      } catch {
        // Skip conflicts during import
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// FakeArchiveWriter — in-memory archive with fault injection
// ═══════════════════════════════════════════════════════════════════

export type FakeArchiveWriteResult =
  | { status: "written"; path: string }
  | { status: "retryable_error"; error: string }
  | { status: "fatal_error"; error: string };

export class FakeArchiveWriter {
  private archives = new Map<string, ConversationArchive>();
  private failCount = 0;
  private currentFailures = 0;
  private _shouldThrow = false;

  /** Configure: fail N times before succeeding. */
  configureFail(times: number): void {
    this.failCount = times;
    this.currentFailures = 0;
  }

  /** Configure: throw an error instead of returning error result. */
  configureThrow(shouldThrow: boolean): void {
    this._shouldThrow = shouldThrow;
  }

  async writeArchive(archive: ConversationArchive): Promise<FakeArchiveWriteResult> {
    // Cache the archive even before writing, so retryArchive can find it
    this.archives.set(archive.conversation_id, archive);

    if (this._shouldThrow) {
      throw new Error("Simulated archive write exception");
    }

    if (this.currentFailures < this.failCount) {
      this.currentFailures++;
      return { status: "retryable_error", error: `Simulated archive write failure (attempt ${this.currentFailures}/${this.failCount})` };
    }

    const path = `_个人认知系统/归档/${archive.conversation_id}.md`;
    return { status: "written", path };
  }

  async retryArchive(conversationId: string): Promise<FakeArchiveWriteResult> {
    const archive = this.archives.get(conversationId);
    if (!archive) {
      return { status: "fatal_error", error: `No cached archive for conversation ${conversationId}` };
    }
    this.currentFailures = this.failCount; // Bypass fail count for retry
    return this.writeArchive(archive);
  }

  getArchive(id: string): ConversationArchive | undefined {
    return this.archives.get(id);
  }

  hasArchive(id: string): boolean {
    return this.archives.has(id);
  }

  reset(): void {
    this.archives.clear();
    this.failCount = 0;
    this.currentFailures = 0;
    this._shouldThrow = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FakeWritebackRepo — in-memory repo with fault injection
// ═══════════════════════════════════════════════════════════════════

export class FakeWritebackRepo implements WritebackRepository {
  private committed: ConfirmedClaim[] = [];
  private committedKeys = new Set<string>();
  private mode: "success" | "retryable" | "fatal" | "revision_conflict" | "throw" = "success";

  configure(
    mode: "success" | "retryable" | "fatal" | "revision_conflict" | "throw",
  ): void {
    this.mode = mode;
  }

  async commitClaims(
    claims: readonly ConfirmedClaim[],
    idempotencyKey: string,
  ): Promise<WritebackResult> {
    // Idempotency: same key → return already committed
    if (this.committedKeys.has(idempotencyKey)) {
      return {
        status: "committed",
        claim_ids: claims.map((c) => `claim:${c.candidate_id}`),
      };
    }

    switch (this.mode) {
      case "success": {
        const ids = claims.map((c) => `claim:${c.candidate_id}`);
        this.committed.push(...claims);
        this.committedKeys.add(idempotencyKey);
        return { status: "committed", claim_ids: ids };
      }
      case "retryable":
        return {
          status: "retryable_error",
          error: "Simulated writeback failure",
          conversation_still_active: true,
        };
      case "fatal":
        return { status: "fatal_error", error: "Fatal writeback error" };
      case "revision_conflict":
        throw new Error("Revision conflict: expected v2, got v3");
      case "throw":
        throw new Error("Unexpected repository error");
    }
  }

  getCommitted(): readonly ConfirmedClaim[] {
    return this.committed;
  }

  getCommittedCount(): number {
    return this.committed.length;
  }

  /** Check if a specific idempotency key was committed. */
  wasKeyUsed(key: string): boolean {
    return this.committedKeys.has(key);
  }

  reset(): void {
    this.committed = [];
    this.committedKeys.clear();
    this.mode = "success";
  }
}

// ═══════════════════════════════════════════════════════════════════
// FakeWeeklyPrepStore — in-memory store for WeeklyPreparationState
// ═══════════════════════════════════════════════════════════════════

export class FakeWeeklyPrepStore implements WeeklyPreparationStore {
  private state: WeeklyPreparationState | null = null;

  async save(state: WeeklyPreparationState): Promise<void> {
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
      topic_id: existing.topic_id,
    } as PreparedTopic;

    const newTopics = [...this.state.topics];
    newTopics[index] = updated;

    this.state = { ...this.state, topics: newTopics };
    return updated;
  }

  /** Directly set state (bypasses save). */
  setState(state: WeeklyPreparationState): void {
    this.state = structuredClone(state) as WeeklyPreparationState;
  }

  clear(): void {
    this.state = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Custom error classes for fault testing (Journey 7)
// ═══════════════════════════════════════════════════════════════════

export class TestAuthenticationError extends Error {
  constructor(msg = "Invalid API key") {
    super(msg);
    this.name = "AuthenticationError";
  }
}

export class TestModelNotFoundError extends Error {
  constructor(msg = "Model not found") {
    super(msg);
    this.name = "ModelNotFoundError";
  }
}

export class TestNetworkError extends Error {
  constructor(msg = "Network timeout") {
    super(msg);
    this.name = "NetworkError";
  }
}
