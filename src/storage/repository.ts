import type { Claim } from "../domain/types";
import type { ModelEvent } from "./plugin-state";
import type {
  DialogueRepository,
  DialogueTurnRecord,
  SealedDialogueTurn,
  DialogueCommitProposal,
  OperationCanonicalPayload,
  ZeroResultRef,
  IdGenerator,
} from "../dialogue/finalize";
import {
  canonicalOperationPayload,
  CommitConflictError,
  validateCommitOperationInvariants,
} from "../dialogue/finalize";
import type { SessionCommitOperation, OperationRef } from "../dialogue/session";
import type { PluginState, IdempotencyPointers } from "./plugin-state";

// ─── Error Types ─────────────────────────────────────────────

export class RepositoryCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryCommitError";
  }
}

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

// ─── Types (was in src/model/repository.ts, now defined locally) ───

export interface RepositoryImportSummary {
  readonly claimsAdded: number;
  readonly eventsAdded: number;
  readonly claimsSkipped: number;
  readonly eventsSkipped: number;
}

// ─── Helpers (was in src/model/repository.ts, now defined locally) ───

/** Deterministic key for a claim. */
export function claimKey(claim: Claim): string {
  return `${claim.claim_id}:v${claim.version}`;
}

/** Stable JSON representation for equality comparison (sorted keys). */
export function stableValue(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

/** Deep-clone and freeze for immutability. */
export function isolated<T>(value: T): T {
  return structuredClone(value);
}

// ─── Internal Snapshot ───────────────────────────────────────

interface MapsSnapshot {
  claims: Map<string, Claim>;
  events: Map<string, ModelEvent>;
  committedKeys: Set<string>;
  lastCommitKey: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────

function operationToClaim(operation: SessionCommitOperation): Claim {
  const userStance =
    operation.epistemic_status === "user_confirmed" ? "endorsed" as const
    : "unconfirmed" as const;

  return {
    schema_version: "1.1",
    claim_id: operation.claim_id,
    canonical_text: operation.text,
    claim_type: operation.claim_type,
    epistemic_status: operation.epistemic_status,
    user_stance: userStance,
    objective_truth_status: "unknown" as const,
    formed_at: operation.occurred_at,
    time_scope: "current",
    applicable_contexts: [],
    scope_limits: "",
    source_note_ids: [operation.source_refs.source_note_id],
    source_topic_ids: [operation.source_refs.topic_id],
    source_dialogue_refs: [operation.source_refs.session_id],
    support_evidence_ids: [],
    counterexample_candidate_ids: [],
    missing_context: "",
    version: operation.version,
    created_at: operation.occurred_at,
    updated_at: operation.occurred_at,
  } as unknown as Claim;
}

function operationToEvent(operation: SessionCommitOperation): ModelEvent {
  const details: Record<string, unknown> = {
    candidate_id: operation.candidate_id,
    from_version: operation.from_version,
    to_version: operation.to_version,
    origin: operation.origin,
  };
  if (operation.confirmation !== null) {
    details.confirmation = operation.confirmation;
  }
  return {
    event_id: operation.event_id,
    event_type: operation.event_type,
    claim_id: operation.claim_id,
    timestamp: operation.occurred_at,
    details,
  };
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

// ─── PluginCognitiveRepository ────────────────────────────────

export class PluginCognitiveRepository implements DialogueRepository {
  // Internal state — the single source of truth
  private readonly claims = new Map<string, Claim>();
  private readonly events = new Map<string, ModelEvent>();
  private readonly sealedTurns = new Map<string, SealedDialogueTurn>();
  private readonly operationRefs = new Map<string, OperationCanonicalPayload>();
  private readonly zeroResults = new Map<string, ZeroResultRef>();
  private readonly committedKeys = new Set<string>();
  private lastCommitKey: string | null = null;

  private readonly turnRequests = new Map<string, string>(); // turn_key → JSON of DialogueTurnRecord

  private readonly loadState: () => PluginState;
  private readonly saveState: (state: PluginState) => Promise<void>;
  private readonly idGenerator: IdGenerator;

  constructor(options: {
    loadState: () => PluginState;
    saveState: (state: PluginState) => Promise<void>;
    idGenerator: IdGenerator;
  }) {
    this.loadState = options.loadState;
    this.saveState = options.saveState;
    this.idGenerator = options.idGenerator;
    this.restoreFromState(options.loadState());
  }

  // ════════════════════════════════════════════════════════════
  // DialogueRepository
  // ════════════════════════════════════════════════════════════

  async recordDialogueTurn(turn: DialogueTurnRecord): Promise<SealedDialogueTurn> {
    const request = JSON.stringify(turn);

    // Idempotent: return existing sealed turn for the same turn_key + request
    const existing = this.sealedTurns.get(turn.turn_key);
    if (existing !== undefined) {
      const priorRequest = this.turnRequests.get(turn.turn_key);
      if (priorRequest !== request) {
        throw new CommitConflictError();
      }
      return deepClone(existing);
    }

    // Validate turn internals
    const candidateIds = turn.operations.map((op) => op.candidate_id);
    const confirmationIds = turn.confirmations.map((c) => c.candidate_id);
    if (
      !turn.turn_key.trim() ||
      !turn.session_id.trim() ||
      new Set(candidateIds).size !== candidateIds.length ||
      new Set(confirmationIds).size !== confirmationIds.length ||
      confirmationIds.some((id) => !candidateIds.includes(id)) ||
      turn.operations.some(
        (op) =>
          op.source_refs.session_id !== turn.session_id ||
          op.source_refs.candidate_id !== op.candidate_id ||
          (op.epistemic_status === "user_confirmed") !== confirmationIds.includes(op.candidate_id) ||
          (op.epistemic_status === "user_confirmed" &&
            (op.confirmation === undefined ||
              !turn.confirmations.some(
                (c) =>
                  c.candidate_id === op.candidate_id &&
                  c.user_statement === op.confirmation!.user_statement &&
                  c.turn_index === op.confirmation!.turn_index
              )))
      )
    ) {
      throw new CommitConflictError();
    }

    // Generate idempotency key for the session
    const idempotencyKey = `commit:${turn.session_id}`;
    const occurredAt = new Date().toISOString();

    // Build sealed operations
    const sealedPayloads: Array<[string, OperationCanonicalPayload]> = [];
    const operations: SessionCommitOperation[] = turn.operations.map((candidate, index) => {
      const expected = candidate.revises_claim?.version ?? 0;
      const claimId = candidate.revises_claim?.claim_id ?? `claim:${turn.turn_key}:${candidate.candidate_id}`;
      const eventId = `event:${turn.turn_key}:${candidate.candidate_id}:${index}`;
      const ref = `operation:${turn.turn_key}:${candidate.candidate_id}:${index}` as OperationRef;

      const operation: SessionCommitOperation = {
        candidate_id: candidate.candidate_id,
        text: candidate.text,
        explanation: candidate.explanation,
        origin: candidate.origin,
        claim_type: candidate.claim_type,
        epistemic_status: candidate.epistemic_status,
        claim_id: claimId,
        version: expected + 1,
        expected_previous_version: expected,
        event_id: eventId,
        event_type: expected === 0 ? "claim_created" : "claim_revised",
        from_version: expected,
        to_version: expected + 1,
        occurred_at: occurredAt,
        confirmation: candidate.confirmation ?? null,
        source_refs: candidate.source_refs,
        idempotency_key: idempotencyKey,
        operation_ref: ref,
      };

      sealedPayloads.push([ref, canonicalOperationPayload(operation)]);
      return operation;
    });

    // Validate sealed operations
    validateCommitOperationInvariants(operations);

    const sealed: SealedDialogueTurn = {
      idempotency_key: idempotencyKey,
      operations,
    };

    // Persist in memory
    this.sealedTurns.set(turn.turn_key, deepClone(sealed));
    this.turnRequests.set(turn.turn_key, request);
    for (const [ref, payload] of sealedPayloads) {
      this.operationRefs.set(ref, deepClone(payload));
    }

    // Persist to PluginState
    await this.persistToState();

    return deepClone(sealed);
  }

  async verifyOperation(
    ref: OperationRef,
    expectedCanonicalPayload: OperationCanonicalPayload
  ): Promise<boolean> {
    const stored = this.operationRefs.get(ref);
    if (stored === undefined) return false;
    return stableValue(stored) === stableValue(expectedCanonicalPayload);
  }

  async commit(proposal: DialogueCommitProposal): Promise<"committed" | "already_committed"> {
    // 1. Check idempotency
    if (this.committedKeys.has(proposal.idempotency_key)) {
      return "already_committed";
    }

    // 2. Validate invariants
    validateCommitOperationInvariants(proposal.operations);

    // 3. Check each operation's idempotency_key and operation_ref
    for (const operation of proposal.operations) {
      if (operation.idempotency_key !== proposal.idempotency_key) {
        throw new CommitConflictError();
      }
      if (!(await this.verifyOperation(operation.operation_ref, canonicalOperationPayload(operation)))) {
        throw new CommitConflictError();
      }
    }

    // 4. Check claim version conflicts (duplicate claim_id, version mismatch)
    const claimIds = proposal.operations.map((op) => op.claim_id);
    if (new Set(claimIds).size !== claimIds.length) {
      throw new CommitConflictError();
    }
    for (const operation of proposal.operations) {
      const currentVersion = this.getCurrentVersion(operation.claim_id);
      if (currentVersion !== operation.expected_previous_version) {
        throw new CommitConflictError();
      }
    }

    // Take snapshot for rollback
    const snapshot = this.snapshotMaps();

    try {
      // 5. Add claims and events
      for (const operation of proposal.operations) {
        const claim = operationToClaim(operation);
        const key = claimKey(claim);

        // Check for conflicting claim key
        const existing = this.claims.get(key);
        if (existing !== undefined && stableValue(existing) !== stableValue(claim)) {
          throw new CommitConflictError();
        }

        this.claims.set(key, isolated(claim));
      }

      for (const operation of proposal.operations) {
        const event = operationToEvent(operation);
        const existing = this.events.get(event.event_id);
        if (existing !== undefined && stableValue(existing) !== stableValue(event)) {
          throw new CommitConflictError();
        }

        this.events.set(event.event_id, isolated(event));
      }

      // 6. Mark committed
      this.committedKeys.add(proposal.idempotency_key);
      this.lastCommitKey = proposal.idempotency_key;

      // 7. Persist to PluginState
      await this.persistToState();

      return "committed";
    } catch (error) {
      // Rollback on any failure (including saveState failure)
      this.restoreSnapshot(snapshot);
      throw error;
    }
  }

  async sealZeroResultTurn(input: {
    readonly sessionId: string;
    readonly topicId: string;
    readonly turnIndex: number;
    readonly userText: string;
    readonly confirmedAt: Date;
    readonly idempotencyKey: string;
  }): Promise<ZeroResultRef> {
    const identityKey = `${input.sessionId}\t${input.topicId}\t${input.turnIndex}`;

    // Idempotent: return existing ref
    const existing = this.zeroResults.get(identityKey);
    if (existing !== undefined) {
      return { ...existing };
    }

    const ref: ZeroResultRef = {
      session_id: input.sessionId,
      topic_id: input.topicId,
      turn_index: input.turnIndex,
      idempotency_key: input.idempotencyKey,
    };

    this.zeroResults.set(identityKey, deepClone(ref));
    this.committedKeys.add(input.idempotencyKey);

    // Persist to PluginState
    await this.persistToState();

    return { ...ref };
  }

  // ════════════════════════════════════════════════════════════
  // CognitiveModelRepository methods
  // ════════════════════════════════════════════════════════════

  importBatch(claims: readonly Claim[], events: readonly ModelEvent[]): RepositoryImportSummary {
    const incomingClaims = new Map<string, Claim>();
    const incomingEvents = new Map<string, ModelEvent>();

    for (const claim of claims) {
      const key = claimKey(claim);
      const prior = incomingClaims.get(key) ?? this.claims.get(key);
      if (prior && stableValue(prior) !== stableValue(claim)) {
        throw new Error(`Import conflicts with existing claim version: ${claim.claim_id} v${claim.version}`);
      }
      incomingClaims.set(key, claim);
    }
    for (const event of events) {
      const prior = incomingEvents.get(event.event_id) ?? this.events.get(event.event_id);
      if (prior && stableValue(prior) !== stableValue(event)) {
        throw new Error(`Import conflicts with append-only event: ${event.event_id}`);
      }
      incomingEvents.set(event.event_id, event);
    }

    let claimsAdded = 0;
    let claimsSkipped = 0;
    for (const [key, claim] of incomingClaims) {
      if (this.claims.has(key)) {
        claimsSkipped += 1;
      } else {
        this.claims.set(key, isolated(claim));
        claimsAdded += 1;
      }
    }
    let eventsAdded = 0;
    let eventsSkipped = 0;
    for (const [id, event] of incomingEvents) {
      if (this.events.has(id)) {
        eventsSkipped += 1;
      } else {
        this.events.set(id, isolated(event));
        eventsAdded += 1;
      }
    }

    return { claimsAdded, eventsAdded, claimsSkipped, eventsSkipped };
  }

  async importBatchAndPersist(
    claims: readonly Claim[],
    events: readonly ModelEvent[],
  ): Promise<RepositoryImportSummary> {
    const snapshot = this.snapshotMaps();
    try {
      const summary = this.importBatch(claims, events);
      await this.persistToState();
      return summary;
    } catch (error) {
      this.restoreSnapshot(snapshot);
      throw error;
    }
  }

  getEndorsed(): readonly Claim[] {
    return this.getCurrentClaims().filter(
      (claim) =>
        claim.epistemic_status === "user_confirmed" &&
        claim.user_stance === "endorsed" &&
        claim.claim_type === "current_viewpoint"
    );
  }

  getConfirmedObservations(): readonly Claim[] {
    return this.getCurrentClaims().filter(
      (claim) =>
        claim.epistemic_status === "user_confirmed" &&
        claim.user_stance === "endorsed" &&
        claim.claim_type === "observation"
    );
  }

  getHistorical(): readonly Claim[] {
    return isolated([...this.claims.values()]);
  }

  getAiHypotheses(): readonly Claim[] {
    return this.getCurrentClaims().filter((claim) => claim.epistemic_status === "ai_inferred");
  }

  getToVerify(): readonly Claim[] {
    return this.getCurrentClaims().filter((claim) => claim.epistemic_status === "to_verify");
  }

  getEvents(): readonly ModelEvent[] {
    return isolated([...this.events.values()]);
  }

  // ════════════════════════════════════════════════════════════
  // Internal: Current claim versions
  // ════════════════════════════════════════════════════════════

  private getCurrentVersion(claimId: string): number {
    let current = 0;
    for (const claim of this.claims.values()) {
      if (claim.claim_id === claimId && claim.version > current) {
        current = claim.version;
      }
    }
    return current;
  }

  private getCurrentClaims(): readonly Claim[] {
    const current = new Map<string, Claim>();
    for (const claim of this.claims.values()) {
      const prior = current.get(claim.claim_id);
      if (!prior || claim.version > prior.version) {
        current.set(claim.claim_id, claim);
      }
    }
    return isolated([...current.values()]);
  }

  // ════════════════════════════════════════════════════════════
  // Persistence: PluginState ↔ internal Maps
  // ════════════════════════════════════════════════════════════

  private restoreFromState(state: PluginState): void {
    // Claims
    for (const [key, claim] of Object.entries(state.claims)) {
      this.claims.set(key, claim as Claim);
    }

    // Events
    for (const [id, event] of Object.entries(state.modelEvents)) {
      this.events.set(id, event as ModelEvent);
    }

    // Sealed turns
    for (const [turnKey, turn] of Object.entries(state.sealedTurns)) {
      this.sealedTurns.set(turnKey, turn as unknown as SealedDialogueTurn);
    }

    // Operation refs
    for (const [ref, payload] of Object.entries(state.operationRefs)) {
      this.operationRefs.set(ref, payload as unknown as OperationCanonicalPayload);
    }

    // Zero results
    for (const [key, ref] of Object.entries(state.zeroResults)) {
      this.zeroResults.set(key, ref as ZeroResultRef);
    }

    // Turn requests
    for (const [turnKey, request] of Object.entries(state.turnRequests)) {
      this.turnRequests.set(turnKey, request);
    }

    // Committed keys
    for (const key of Object.keys(state.idempotencyPointers.committedKeys)) {
      this.committedKeys.add(key);
    }

    // Last commit key
    this.lastCommitKey = state.idempotencyPointers.lastCommitKey;
  }

  private async persistToState(): Promise<void> {
    const state = this.loadState();

    // Build claims record
    const claimsRecord: Record<string, Claim> = {};
    for (const [key, claim] of this.claims) {
      claimsRecord[key] = claim;
    }

    // Build events record
    const eventsRecord: Record<string, ModelEvent> = {};
    for (const [id, event] of this.events) {
      eventsRecord[id] = event;
    }

    // Build sealed turns record
    const turnsRecord: Record<string, SealedDialogueTurn> = {};
    for (const [turnKey, turn] of this.sealedTurns) {
      turnsRecord[turnKey] = turn;
    }

    // Build operation refs record
    const opRefsRecord: Record<string, OperationCanonicalPayload> = {};
    for (const [ref, payload] of this.operationRefs) {
      opRefsRecord[ref] = payload;
    }

    // Build zero results record
    const zeroResultsRecord: Record<string, ZeroResultRef> = {};
    for (const [key, ref] of this.zeroResults) {
      zeroResultsRecord[key] = ref;
    }

    // Build committed keys record
    const committedKeysRecord: Record<string, true> = {};
    for (const key of this.committedKeys) {
      committedKeysRecord[key] = true as const;
    }

    // Build lastZeroResultKeys from zeroResults map
    const lastZeroResultKeys: Record<string, string> = {};
    for (const [key, ref] of this.zeroResults) {
      lastZeroResultKeys[key] = ref.idempotency_key;
    }

    // Build turn requests record
    const turnRequestsRecord: Record<string, string> = {};
    for (const [key, request] of this.turnRequests) {
      turnRequestsRecord[key] = request;
    }

    // Merge into state (preserving all existing fields)
    const updated: PluginState = {
      ...state,
      claims: claimsRecord,
      modelEvents: eventsRecord,
      sealedTurns: turnsRecord as unknown as Record<string, SealedDialogueTurn>,
      operationRefs: opRefsRecord as unknown as Record<string, OperationCanonicalPayload>,
      zeroResults: zeroResultsRecord,
      turnRequests: turnRequestsRecord,
      idempotencyPointers: {
        ...state.idempotencyPointers,
        lastCommitKey: this.lastCommitKey ?? state.idempotencyPointers.lastCommitKey,
        lastZeroResultKeys,
        committedKeys: committedKeysRecord,
      },
    };

    await this.saveState(updated);
  }

  // ════════════════════════════════════════════════════════════
  // Snapshot / Rollback
  // ════════════════════════════════════════════════════════════

  private snapshotMaps(): MapsSnapshot {
    return {
      claims: new Map(this.claims),
      events: new Map(this.events),
      committedKeys: new Set(this.committedKeys),
      lastCommitKey: this.lastCommitKey,
    };
  }

  private restoreSnapshot(snapshot: MapsSnapshot): void {
    this.claims.clear();
    for (const [key, value] of snapshot.claims) {
      this.claims.set(key, value);
    }

    this.events.clear();
    for (const [key, value] of snapshot.events) {
      this.events.set(key, value);
    }

    this.committedKeys.clear();
    for (const key of snapshot.committedKeys) {
      this.committedKeys.add(key);
    }

    this.lastCommitKey = snapshot.lastCommitKey;
  }
}
