export type DialogueTextArchiveRole =
  | "source_excerpt"
  | "ai_summary"
  | "ai_question"
  | "ai_hypothesis"
  | "historical_link"
  | "user_statement"
  | "context_status";
export type DialogueResultArchiveRole = "ai_inferred_result" | "to_verify_result" | "formal_result";
export type DialogueArchiveRole = DialogueTextArchiveRole | DialogueResultArchiveRole;

export interface DialogueTextArchiveRecord {
  readonly role: DialogueTextArchiveRole;
  readonly content: string;
  readonly topic_id: string | null;
  readonly recorded_at: string;
  readonly status?: "confirmed" | "unknown" | "unconfirmed";
}

export interface DialogueResultArchiveRecord {
  readonly role: DialogueResultArchiveRole;
  readonly candidate_id: string;
  readonly text: string;
  readonly explanation: string;
  readonly claim_type: SessionCandidate["claim_type"];
  readonly origin: SessionCandidate["origin"];
  readonly epistemic_status: SessionCandidate["epistemic_status"];
  readonly revision_target: Exclude<SessionCandidate["revises_claim"], undefined> | null;
  readonly confirmation: CandidateConfirmation | null;
  readonly topic_id: string;
  readonly recorded_at: string;
}

export type DialogueArchiveRecord = DialogueTextArchiveRecord | DialogueResultArchiveRecord;

export interface DialogueTopic {
  readonly topic_id: string;
  readonly source_note_id: string;
  readonly source_year: number;
  readonly source_excerpt: string;
  readonly ai_summary: string;
  readonly historical_links: readonly string[];
}

export interface CandidateConfirmation {
  readonly user_statement: string;
  readonly confirmed_at: string;
  readonly session_id: string;
  readonly turn_index: number;
  readonly candidate_ids: readonly string[];
}

export interface CandidateSourceRefs {
  readonly session_id: string;
  readonly topic_id: string;
  readonly source_note_id: string;
  readonly candidate_id: string;
}

export type OperationRef = string & { readonly __operationRef: unique symbol };

export interface SessionCommitOperation {
  readonly candidate_id: string;
  readonly text: string;
  readonly explanation: string;
  readonly origin: "source" | "dialogue";
  readonly claim_type: "observation" | "current_viewpoint" | "pattern_hypothesis" | "causal_hypothesis" | "open_question";
  readonly epistemic_status: "ai_inferred" | "to_verify" | "user_confirmed";
  readonly claim_id: string;
  readonly version: number;
  readonly expected_previous_version: number;
  readonly event_id: string;
  readonly event_type: "claim_created" | "claim_revised";
  readonly from_version: number;
  readonly to_version: number;
  readonly occurred_at: string;
  readonly confirmation: CandidateConfirmation | null;
  readonly source_refs: CandidateSourceRefs;
  readonly idempotency_key: string;
  readonly operation_ref: OperationRef;
}

export interface SessionCandidate {
  readonly candidate_id: string;
  readonly text: string;
  readonly explanation: string;
  readonly origin: "source" | "dialogue";
  readonly claim_type: "observation" | "current_viewpoint" | "pattern_hypothesis" | "causal_hypothesis" | "open_question";
  readonly epistemic_status: "ai_inferred" | "to_verify" | "user_confirmed";
  readonly revises_claim?: { readonly claim_id: string; readonly version: number };
  readonly confirmation?: CandidateConfirmation;
  readonly source_refs: CandidateSourceRefs;
}

export interface SessionValidationCandidate {
  readonly hypothesis: string;
  readonly action: string;
  readonly kind: "lightweight" | "formal_plan";
}

export type DialogueActiveStatus = "active" | "awaiting_zero_confirmation" | "awaiting_candidate_confirmation";

export interface DialogueSessionState {
  readonly session_id: string;
  readonly snapshot_id: string;
  readonly status: "ready" | DialogueActiveStatus | "paused" | "completed";
  readonly paused_from_status: DialogueActiveStatus | null;
  readonly active_question: string | null;
  readonly current_topic_index: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archive: readonly DialogueArchiveRecord[];
  readonly unknown_context_topic_ids: readonly string[];
  readonly background_prompted_topic_ids: readonly string[];
  readonly awaiting_background_topic_id: string | null;
  readonly pending_candidates: readonly SessionCandidate[];
  readonly pending_validations: readonly SessionValidationCandidate[];
  readonly accumulated_candidates: readonly SessionCandidate[];
  readonly accumulated_validations: readonly SessionValidationCandidate[];
  readonly zero_confirmations: readonly string[];
  readonly turn_index: number;
  readonly pending_commit_operations: readonly SessionCommitOperation[];
  readonly commit_idempotency_key: string | null;
}

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? ReadonlyArray<DeepReadonly<Item>>
  : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function cloneFrozen<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value));
}

export function isolateSession(session: DialogueSessionState): DialogueSessionState {
  return cloneFrozen(session) as DialogueSessionState;
}

export function createDialogueSession(input: {
  readonly sessionId: string;
  readonly snapshotId: string;
  readonly topics: readonly DialogueTopic[];
  readonly now: Date;
}): DialogueSessionState {
  const recordedAt = input.now.toISOString();
  const topics = cloneFrozen(input.topics);
  const archive: DialogueArchiveRecord[] = [];
  for (const item of topics) {
    archive.push({ role: "source_excerpt", content: item.source_excerpt, topic_id: item.topic_id, recorded_at: recordedAt });
    archive.push({ role: "ai_summary", content: item.ai_summary, topic_id: item.topic_id, recorded_at: recordedAt });
    for (const historical of item.historical_links) {
      archive.push({ role: "historical_link", content: historical, topic_id: item.topic_id, recorded_at: recordedAt });
    }
  }
  return isolateSession({
    session_id: input.sessionId,
    snapshot_id: input.snapshotId,
    status: "ready",
    paused_from_status: null,
    active_question: null,
    current_topic_index: 0,
    created_at: recordedAt,
    updated_at: recordedAt,
    archive,
    unknown_context_topic_ids: [],
    background_prompted_topic_ids: [],
    awaiting_background_topic_id: null,
    pending_candidates: [],
    pending_validations: [],
    accumulated_candidates: [],
    accumulated_validations: [],
    zero_confirmations: [],
    turn_index: 0,
    pending_commit_operations: [],
    commit_idempotency_key: null
  });
}

export function pauseDialogue(session: DialogueSessionState, now: Date): DialogueSessionState {
  if (session.status !== "active" && session.status !== "awaiting_zero_confirmation"
    && session.status !== "awaiting_candidate_confirmation") {
    throw new Error("Only a dialogue with an active question can pause");
  }
  return isolateSession({
    ...session,
    status: "paused",
    paused_from_status: session.status,
    updated_at: now.toISOString()
  });
}

export function resumeDialogue(session: DialogueSessionState, now: Date): DialogueSessionState {
  if (session.status !== "paused" || session.paused_from_status === null || session.active_question === null) {
    throw new Error("Only a paused dialogue question can resume");
  }
  return isolateSession({
    ...session,
    status: session.paused_from_status,
    paused_from_status: null,
    updated_at: now.toISOString()
  });
}
