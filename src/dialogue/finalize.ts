import type {
  DialogueArchiveRecord,
  DialogueResultArchiveRecord,
  OperationRef,
  SessionCandidate,
  SessionCommitOperation,
  SessionValidationCandidate
} from "./session";
import { cloneFrozen } from "./session";

export interface IdGenerator {
  create(scope: string): string;
}

export type DialogueCommitOperation = SessionCommitOperation;
export type OperationCanonicalPayload = Omit<SessionCommitOperation, "operation_ref">;

export interface DialogueTurnConfirmation {
  readonly candidate_id: string;
  readonly user_statement: string;
  readonly turn_index: number;
}

export type DialogueTurnOperation = Omit<SessionCandidate, "revises_claim"> & {
  readonly revises_claim: SessionCandidate["revises_claim"] | null;
};

export interface DialogueTurnRecord {
  readonly session_id: string;
  readonly turn_key: string;
  readonly operations: readonly DialogueTurnOperation[];
  readonly confirmations: readonly DialogueTurnConfirmation[];
}

export interface SealedDialogueTurn {
  readonly idempotency_key: string;
  readonly operations: readonly SessionCommitOperation[];
}

export function canonicalOperationPayload(operation: SessionCommitOperation): OperationCanonicalPayload {
  const { operation_ref: _operationRef, ...payload } = operation;
  return cloneFrozen(payload) as OperationCanonicalPayload;
}

export interface FinalizedValidation extends SessionValidationCandidate {
  readonly status: "candidate" | "proposal";
}

export interface DialogueCommitProposal {
  readonly session_id: string;
  readonly idempotency_key: string;
  readonly operations: readonly DialogueCommitOperation[];
  readonly validations: readonly FinalizedValidation[];
  readonly needs_formal_plan_confirmation: boolean;
  readonly zero_result_confirmation: string | null;
  readonly archive: readonly DialogueArchiveRecord[];
}

export interface ZeroResultRef {
  readonly session_id: string;
  readonly topic_id: string;
  readonly turn_index: number;
  readonly idempotency_key: string;
}

export interface DialogueRepository {
  recordDialogueTurn(turn: DialogueTurnRecord): Promise<SealedDialogueTurn>;
  verifyOperation(ref: OperationRef, expectedCanonicalPayload: OperationCanonicalPayload): Promise<boolean>;
  commit(proposal: DialogueCommitProposal): Promise<"committed" | "already_committed">;
  sealZeroResultTurn(input: {
    readonly sessionId: string;
    readonly topicId: string;
    readonly turnIndex: number;
    readonly userText: string;
    readonly confirmedAt: Date;
    readonly idempotencyKey: string;
  }): Promise<ZeroResultRef>;
}

export class CommitConflictError extends Error {
  constructor() {
    super("Dialogue commit conflicts with the current model version");
    this.name = "CommitConflictError";
  }
}

export function validateCommitOperationInvariants(operations: readonly SessionCommitOperation[]): void {
  const eventIds = new Set<string>();
  const claimIds = new Set<string>();
  for (const operation of operations) {
    const occurredAt = new Date(operation.occurred_at);
    if (!operation.claim_id.trim() || !operation.event_id.trim() || eventIds.has(operation.event_id)
      || claimIds.has(operation.claim_id)
      || !Number.isInteger(operation.expected_previous_version) || operation.expected_previous_version < 0
      || operation.from_version !== operation.expected_previous_version
      || operation.version !== operation.from_version + 1 || operation.to_version !== operation.version
      || operation.event_type !== (operation.from_version === 0 ? "claim_created" : "claim_revised")
      || Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== operation.occurred_at
      || !operation.operation_ref.trim()) throw new CommitConflictError();
    eventIds.add(operation.event_id);
    claimIds.add(operation.claim_id);
  }
}

export async function commitDialogueProposal(
  proposal: DialogueCommitProposal,
  repository: DialogueRepository
): Promise<"committed" | "already_committed"> {
  const safe = cloneFrozen(proposal) as DialogueCommitProposal;
  validateCommitOperationInvariants(safe.operations);
  for (const operation of safe.operations) {
    if (operation.idempotency_key !== safe.idempotency_key) throw new CommitConflictError();
    if (!(await repository.verifyOperation(operation.operation_ref, canonicalOperationPayload(operation)))) {
      throw new CommitConflictError();
    }
  }
  return repository.commit(safe);
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_{}\[\]()<>#+\-.!|~>])/gu, "\\$1")
    .replace(/\r?\n/gu, "  \n> ");
}

export function renderArchiveSafely(records: readonly DialogueArchiveRecord[]): string {
  const isResult = (record: DialogueArchiveRecord): record is DialogueResultArchiveRecord =>
    record.role === "formal_result" || record.role === "ai_inferred_result" || record.role === "to_verify_result";
  return records.map((record) => isResult(record)
    ? [
        `- role: ${record.role}`,
        `  candidate: ${escapeMarkdown(record.candidate_id)}`,
        `  topic: ${escapeMarkdown(record.topic_id)}`,
        `  text: > ${escapeMarkdown(record.text)}`,
        `  explanation: > ${escapeMarkdown(record.explanation)}`,
        `  claim_type: ${record.claim_type}`,
        `  origin: ${record.origin}`,
        `  epistemic_status: ${record.epistemic_status}`,
        `  revision_target: ${record.revision_target === null ? "none" : escapeMarkdown(`${record.revision_target.claim_id}@${record.revision_target.version}`)}`,
        `  confirmation: ${record.confirmation === null ? "none" : escapeMarkdown(record.confirmation.user_statement)}`
      ].join("\n")
    : [
        `- role: ${record.role}`,
        `  topic: ${record.topic_id ?? "none"}`,
        `  content: > ${escapeMarkdown(record.content)}`
      ].join("\n")).join("\n");
}
