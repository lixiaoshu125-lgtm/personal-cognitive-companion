import { z } from "zod";
import {
  type DialogueCommitProposal,
  type FinalizedValidation,
  type IdGenerator,
  type DialogueRepository,
  canonicalOperationPayload,
  validateCommitOperationInvariants
} from "./finalize";
import {
  cloneFrozen,
  isolateSession,
  type DialogueActiveStatus,
  type DialogueArchiveRecord,
  type DialogueSessionState,
  type DialogueTextArchiveRole,
  type DialogueTopic,
  type SessionCommitOperation,
  type SessionCandidate,
  type SessionValidationCandidate
} from "./session";

const revisionSchema = z.strictObject({ claim_id: z.string().trim().min(1), version: z.number().int().positive() });
const candidateSchema = z.strictObject({
  candidate_id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  explanation: z.string().trim().min(1).max(500),
  origin: z.enum(["source", "dialogue"]),
  claim_type: z.enum(["observation", "current_viewpoint", "pattern_hypothesis", "causal_hypothesis", "open_question"]),
  epistemic_status: z.enum(["ai_inferred", "to_verify"]),
  revises_claim: revisionSchema.optional()
});
const validationSchema = z.strictObject({
  hypothesis: z.string().trim().min(1),
  action: z.string().trim().min(1),
  kind: z.enum(["lightweight", "formal_plan"])
});
const completeTopicSchema = z.strictObject({
    action: z.literal("complete_topic"),
    candidates: z.array(candidateSchema),
    validation_candidates: z.array(validationSchema),
    request_user_confirmation: z.boolean().optional()
  }).superRefine((decision, refinement) => {
    const ids = decision.candidates.map(({ candidate_id }) => candidate_id);
    if (new Set(ids).size !== ids.length) refinement.addIssue({ code: "custom", path: ["candidates"], message: "Duplicate candidate id" });
  });
export const contentDecisionSchema = z.union([
  z.strictObject({ action: z.literal("ask"), question: z.string().trim().min(1) }),
  completeTopicSchema
]);
export const zeroIntentSchema = z.strictObject({ intent: z.enum(["confirm_zero", "reject_zero", "unclear"]) });
export const candidateIntentSchema = z.strictObject({
  intent: z.enum(["confirm", "reject", "unclear"]),
  candidate_ids: z.array(z.string().trim().min(1)).optional()
});
export const backgroundIntentSchema = z.strictObject({ status: z.enum(["known", "unknown", "unclear"]) });
export interface DialogueDecisionRequest {
  readonly session: DialogueSessionState;
  readonly topic: DialogueTopic | null;
  readonly userTurn: string | null;
  readonly instruction: string;
}

export interface DialogueDecisionMaker {
  decide(request: DialogueDecisionRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface UserIntentDecision {
  classifyZeroResult(input: Readonly<{ userTurn: string; activeQuestion: string }>, signal?: AbortSignal): Promise<unknown>;
  classifyCandidateConfirmation(input: Readonly<{
    userTurn: string;
    candidates: readonly SessionCandidate[];
  }>, signal?: AbortSignal): Promise<unknown>;
  classifyBackground(input: Readonly<{ userTurn: string; topicId: string }>, signal?: AbortSignal): Promise<unknown>;
}

export interface DialogueContext {
  readonly currentYear: number;
  readonly topics: readonly DialogueTopic[];
  readonly decisions: DialogueDecisionMaker;
  readonly userIntents: UserIntentDecision;
  readonly now: () => Date;
  readonly ids: IdGenerator;
  readonly repository: DialogueRepository;
  readonly signal?: AbortSignal;
}

export type DialogueTurnResult =
  | { readonly kind: "question"; readonly question: string; readonly session: DialogueSessionState }
  | { readonly kind: "final"; readonly final: DialogueCommitProposal; readonly session: DialogueSessionState };

export class DialogueOrchestrationError extends Error {
  constructor() {
    super("Unable to continue the dialogue safely");
    this.name = "DialogueOrchestrationError";
  }
}

const isOldAndLong = (topic: DialogueTopic, currentYear: number): boolean =>
  currentYear - topic.source_year >= 3 && Array.from(topic.source_excerpt).length >= 800;

function validSingleQuestion(question: string): boolean {
  return /^[^?？.!。！\r\n]+[?？]$/u.test(question.trim());
}

function archiveRecord(
  role: DialogueTextArchiveRole,
  content: string,
  now: Date,
  topicId: string | null,
  status?: "confirmed" | "unknown" | "unconfirmed"
): DialogueArchiveRecord {
  return { role, content, topic_id: topicId, recorded_at: now.toISOString(), ...(status === undefined ? {} : { status }) };
}

function ask(
  session: DialogueSessionState,
  question: string,
  now: Date,
  status: DialogueActiveStatus = "active"
): DialogueTurnResult {
  if (!validSingleQuestion(question)) throw new Error("invalid question");
  const topicId = status === "active" ? null : session.current_topic_index.toString();
  const next = isolateSession({
    ...session,
    status,
    paused_from_status: null,
    active_question: question,
    updated_at: now.toISOString(),
    archive: [...session.archive, archiveRecord("ai_question", question, now, topicId)]
  });
  return cloneFrozen({ kind: "question", question, session: next }) as DialogueTurnResult;
}

function withUserTurn(session: DialogueSessionState, userTurn: string, topic: DialogueTopic | null, now: Date): DialogueSessionState {
  const statement = userTurn.trim();
  if (statement === "") throw new Error("empty user turn");
  return isolateSession({
    ...session,
    archive: [...session.archive, archiveRecord("user_statement", statement, now, topic?.topic_id ?? null)],
    turn_index: session.turn_index + 1
  });
}

function isCompleteOneOrTwoSentences(text: string): boolean {
  const trimmed = text.trim();
  const matches = trimmed.match(/[^.!?。！？]+[.!?。！？]/gu);
  return matches !== null && matches.length >= 1 && matches.length <= 2 && matches.join("") === trimmed;
}

function operationMatchesCandidate(operation: SessionCommitOperation, candidate: SessionCandidate): boolean {
  return operation.candidate_id === candidate.candidate_id
    && operation.text === candidate.text
    && operation.explanation === candidate.explanation
    && operation.origin === candidate.origin
    && operation.claim_type === candidate.claim_type
    && operation.epistemic_status === candidate.epistemic_status
    && JSON.stringify(operation.confirmation) === JSON.stringify(candidate.confirmation ?? null)
    && JSON.stringify(operation.source_refs) === JSON.stringify(candidate.source_refs)
    && operation.expected_previous_version === (candidate.revises_claim?.version ?? 0)
    && operation.from_version === operation.expected_previous_version
    && operation.version === operation.from_version + 1
    && operation.to_version === operation.version
    && operation.event_type === (operation.from_version === 0 ? "claim_created" : "claim_revised")
    && (candidate.revises_claim === undefined
      ? operation.from_version === 0
      : operation.claim_id === candidate.revises_claim.claim_id && operation.from_version === candidate.revises_claim.version);
}

async function validateSealedSession(session: DialogueSessionState, repository: DialogueRepository): Promise<void> {
  const operationEventIds = session.pending_commit_operations.map(({ event_id }) => event_id);
  const candidateIds = session.accumulated_candidates.map(({ candidate_id }) => candidate_id);
  if (new Set(operationEventIds).size !== operationEventIds.length
    || new Set(candidateIds).size !== candidateIds.length) throw new Error("duplicate sealed event");
  if (session.pending_commit_operations.length > 0
    && session.commit_idempotency_key === null) throw new Error("missing sealed idempotency key");
  if (session.accumulated_candidates.length !== session.pending_commit_operations.length
    || session.accumulated_candidates.some((candidate) => !session.pending_commit_operations.some(
      (operation) => operation.candidate_id === candidate.candidate_id
    ))) throw new Error("unsealed candidate");
  for (const operation of session.pending_commit_operations) {
    const candidate = session.accumulated_candidates.find(({ candidate_id }) => candidate_id === operation.candidate_id);
    if (candidate === undefined || !operationMatchesCandidate(operation, candidate)
      || operation.idempotency_key !== session.commit_idempotency_key) throw new Error("sealed operation mismatch");
    if (!(await repository.verifyOperation(operation.operation_ref, canonicalOperationPayload(operation))))
      throw new Error("invalid sealed operation");
  }
  validateCommitOperationInvariants(session.pending_commit_operations);
}

async function sealCandidates(
  session: DialogueSessionState,
  candidates: readonly SessionCandidate[],
  context: DialogueContext,
  _occurredAt: Date
): Promise<Pick<DialogueSessionState, "pending_commit_operations" | "commit_idempotency_key">> {
  const turnKey = `${session.session_id}:turn:${session.turn_index}:topic:${candidates[0]?.source_refs.topic_id ?? "none"}`;
  const sealed = await context.repository.recordDialogueTurn({
    session_id: session.session_id,
    turn_key: turnKey,
    operations: candidates.map((candidate) => ({ ...candidate, revises_claim: candidate.revises_claim ?? null })),
    confirmations: candidates.flatMap((candidate) => candidate.confirmation === undefined ? [] : [{
      candidate_id: candidate.candidate_id,
      user_statement: candidate.confirmation.user_statement,
      turn_index: candidate.confirmation.turn_index
    }])
  });
  return {
    pending_commit_operations: [...session.pending_commit_operations, ...sealed.operations],
    commit_idempotency_key: session.commit_idempotency_key ?? sealed.idempotency_key
  };
}

async function buildCommitProposal(session: DialogueSessionState, context: DialogueContext): Promise<DialogueCommitProposal> {
  const zero = session.zero_confirmations.length === 0 ? null : session.zero_confirmations.join("\n");
  if (session.accumulated_candidates.length === 0 && (zero === null || zero.trim() === "")) throw new Error("invalid proposal");
  await validateSealedSession(session, context.repository);
  const idempotencyKey = session.commit_idempotency_key;
  if (idempotencyKey === null) throw new Error("missing idempotency key");
  const operations = session.pending_commit_operations;
  validateCommitOperationInvariants(operations);
  const claimIds = operations.map(({ claim_id }) => claim_id);
  const eventIds = operations.map(({ event_id }) => event_id);
  if (new Set(claimIds).size !== claimIds.length || new Set(eventIds).size !== eventIds.length) throw new Error("duplicate operation id");
  const validations = session.accumulated_validations.map((candidate): FinalizedValidation => ({
    ...candidate, status: candidate.kind === "formal_plan" ? "proposal" : "candidate"
  }));
  return cloneFrozen({
    session_id: session.session_id,
    idempotency_key: idempotencyKey,
    operations,
    validations,
    needs_formal_plan_confirmation: validations.some(({ kind }) => kind === "formal_plan"),
    zero_result_confirmation: zero,
    archive: session.archive
  }) as DialogueCommitProposal;
}

async function finalizeOrAdvance(
  session: DialogueSessionState,
  context: DialogueContext,
  userTurnForNextDecision: string | null
): Promise<DialogueTurnResult> {
  if (session.current_topic_index >= context.topics.length) {
    const final = await buildCommitProposal(session, context);
    const completed = isolateSession({ ...session, status: "completed", active_question: null, updated_at: context.now().toISOString() });
    return cloneFrozen({ kind: "final", final, session: completed }) as DialogueTurnResult;
  }
  return decideContent(session, userTurnForNextDecision, context);
}

async function finishTopic(
  session: DialogueSessionState,
  candidates: readonly SessionCandidate[],
  validations: readonly SessionValidationCandidate[],
  zeroConfirmation: string | null,
  context: DialogueContext,
  occurredAt: Date = context.now()
): Promise<DialogueTurnResult> {
  const now = context.now();
  for (const candidate of candidates) {
    if (!isCompleteOneOrTwoSentences(candidate.text) || candidate.explanation.trim() === "" || candidate.explanation.length > 500) {
      throw new Error("invalid candidate");
    }
  }
  const sealed = await sealCandidates(session, candidates, context, occurredAt);
  const topicId = context.topics[session.current_topic_index]?.topic_id;
  if (topicId === undefined) throw new Error("missing topic");
  const resultRecords: DialogueArchiveRecord[] = candidates.map((candidate) => ({
    role: candidate.epistemic_status === "user_confirmed" ? "formal_result"
      : candidate.epistemic_status === "to_verify" ? "to_verify_result" : "ai_inferred_result",
    candidate_id: candidate.candidate_id,
    text: candidate.text,
    explanation: candidate.explanation,
    claim_type: candidate.claim_type,
    origin: candidate.origin,
    epistemic_status: candidate.epistemic_status,
    revision_target: candidate.revises_claim ?? null,
    confirmation: candidate.confirmation ?? null,
    topic_id: topicId,
    recorded_at: now.toISOString()
  }));
  const next = isolateSession({
    ...session,
    status: "ready",
    active_question: null,
    current_topic_index: session.current_topic_index + 1,
    pending_candidates: [],
    pending_validations: [],
    accumulated_candidates: [...session.accumulated_candidates, ...candidates],
    accumulated_validations: [...session.accumulated_validations, ...validations],
    zero_confirmations: zeroConfirmation === null ? session.zero_confirmations : [...session.zero_confirmations, zeroConfirmation],
    archive: [...session.archive, ...resultRecords],
    ...sealed
  });
  return finalizeOrAdvance(next, context, null);
}

async function decideContent(
  session: DialogueSessionState,
  userTurn: string | null,
  context: DialogueContext
): Promise<DialogueTurnResult> {
  const topic = context.topics[session.current_topic_index] ?? null;
  const request = cloneFrozen({
    session,
    topic: topic === null ? null : cloneFrozen(topic),
    userTurn,
    instruction: "Return exactly one question or complete the current topic. Candidates are AI proposals only."
  });
  const raw = await context.decisions.decide(request as DialogueDecisionRequest, context.signal);
  const parsed = contentDecisionSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid content decision");
  if (parsed.data.action === "ask") return ask(session, parsed.data.question, context.now());
  if (topic === null) throw new Error("missing topic");
  const candidates = parsed.data.candidates.map((candidate): SessionCandidate => ({
    candidate_id: candidate.candidate_id,
    text: candidate.text,
    explanation: candidate.explanation,
    origin: candidate.origin,
    claim_type: candidate.claim_type,
    epistemic_status: candidate.epistemic_status,
    ...(candidate.revises_claim === undefined ? {} : { revises_claim: candidate.revises_claim }),
    source_refs: {
      session_id: session.session_id,
      topic_id: topic.topic_id,
      source_note_id: topic.source_note_id,
      candidate_id: candidate.candidate_id
    }
  }));
  const validations = parsed.data.validation_candidates as readonly SessionValidationCandidate[];
  if (candidates.length === 0) {
    const pending = isolateSession({ ...session, pending_validations: validations });
    return ask(pending, "Should we finish this topic without saving any formal result?", context.now(), "awaiting_zero_confirmation");
  }
  if (parsed.data.request_user_confirmation === true) {
    const pending = isolateSession({ ...session, pending_candidates: candidates, pending_validations: validations });
    return ask(pending, "Which of these specific candidates do you confirm as your own view?", context.now(), "awaiting_candidate_confirmation");
  }
  return finishTopic(session, candidates, validations, null, context);
}

async function advanceInternal(
  original: DialogueSessionState,
  userTurn: string | null,
  context: DialogueContext
): Promise<DialogueTurnResult> {
  if (original.status === "paused" || original.status === "completed") throw new Error("invalid state");
  const now = context.now();
  const topic = context.topics[original.current_topic_index] ?? null;
  let session = original;

  if (original.status === "awaiting_zero_confirmation") {
    if (userTurn === null || original.active_question === null) throw new Error("missing intent turn");
    session = withUserTurn(session, userTurn, topic, now);
    const raw = await context.userIntents.classifyZeroResult(cloneFrozen({
      userTurn: userTurn.trim(), activeQuestion: original.active_question
    }), context.signal);
    const intent = zeroIntentSchema.parse(raw).intent;
    if (intent === "confirm_zero") return finishTopic(session, [], original.pending_validations, userTurn.trim(), context, now);
    if (intent === "reject_zero") return ask(session, "What should we keep discussing in this topic?", now);
    return ask(session, "Do you want to finish this topic with no formal result?", now, "awaiting_zero_confirmation");
  }

  if (original.status === "awaiting_candidate_confirmation") {
    if (userTurn === null) throw new Error("missing intent turn");
    session = withUserTurn(session, userTurn, topic, now);
    const raw = await context.userIntents.classifyCandidateConfirmation(cloneFrozen({
      userTurn: userTurn.trim(), candidates: original.pending_candidates
    }), context.signal);
    const intent = candidateIntentSchema.parse(raw);
    if (intent.intent !== "confirm") {
      return ask(session, "Which specific candidate, if any, do you confirm as your view?", now, "awaiting_candidate_confirmation");
    }
    const ids = new Set(intent.candidate_ids ?? []);
    if (ids.size === 0 || [...ids].some((id) => !original.pending_candidates.some(({ candidate_id }) => candidate_id === id))) {
      throw new Error("invalid candidate confirmation");
    }
    const confirmedIds = [...ids];
    const candidates = original.pending_candidates.map((candidate): SessionCandidate => ids.has(candidate.candidate_id)
      ? { ...candidate, epistemic_status: "user_confirmed", confirmation: {
          user_statement: userTurn.trim(), confirmed_at: now.toISOString(), session_id: original.session_id,
          turn_index: session.turn_index, candidate_ids: confirmedIds
        } }
      : candidate);
    return finishTopic(session, candidates, original.pending_validations, null, context, now);
  }

  if (userTurn !== null) session = withUserTurn(session, userTurn, topic, now);

  if (original.awaiting_background_topic_id !== null) {
    if (userTurn === null) throw new Error("missing background turn");
    const raw = await context.userIntents.classifyBackground(cloneFrozen({
      userTurn: userTurn.trim(), topicId: original.awaiting_background_topic_id
    }), context.signal);
    const status = backgroundIntentSchema.parse(raw).status;
    const contextStatus = status === "unknown" ? "unknown" : status === "known" ? "confirmed" : "unconfirmed";
    session = isolateSession({
      ...session,
      archive: [...session.archive, archiveRecord("context_status", status, now, original.awaiting_background_topic_id, contextStatus)],
      unknown_context_topic_ids: status === "unknown"
        ? [...new Set([...session.unknown_context_topic_ids, original.awaiting_background_topic_id])]
        : session.unknown_context_topic_ids,
      awaiting_background_topic_id: status === "unclear" ? original.awaiting_background_topic_id : null
    });
    if (status === "unclear") return ask(session, "Can you clarify whether that background is unknown?", now);
  }

  if (topic !== null && isOldAndLong(topic, context.currentYear)
    && !session.background_prompted_topic_ids.includes(topic.topic_id)) {
    session = isolateSession({
      ...session,
      background_prompted_topic_ids: [...session.background_prompted_topic_ids, topic.topic_id],
      awaiting_background_topic_id: topic.topic_id
    });
    return ask(session, "What background do you remember for this older note?", now);
  }
  return decideContent(session, userTurn, context);
}

export async function advanceDialogue(
  session: DialogueSessionState,
  userTurn: string | null,
  context: DialogueContext
): Promise<DialogueTurnResult> {
  try {
    const safeSession = cloneFrozen(session) as DialogueSessionState;
    await validateSealedSession(safeSession, context.repository);
    const safeTopics = cloneFrozen(context.topics) as readonly DialogueTopic[];
    return await advanceInternal(safeSession, userTurn, { ...context, topics: safeTopics });
  } catch {
    throw new DialogueOrchestrationError();
  }
}
