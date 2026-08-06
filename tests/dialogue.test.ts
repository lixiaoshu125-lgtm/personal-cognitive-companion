import { describe, expect, it } from "vitest";
import {
  createDialogueSession,
  pauseDialogue,
  resumeDialogue,
  type DialogueSessionState,
  type DialogueTopic,
  type OperationRef
} from "../src/dialogue/session";
import {
  DialogueOrchestrationError,
  advanceDialogue,
  type DialogueContext,
  type DialogueDecisionMaker,
  type UserIntentDecision
} from "../src/dialogue/orchestrator";
import {
  CommitConflictError,
  commitDialogueProposal,
  renderArchiveSafely,
  type DialogueCommitProposal,
  type DialogueRepository,
  type DialogueTurnRecord,
  type OperationCanonicalPayload,
  type ZeroResultRef,
  canonicalOperationPayload,
  validateCommitOperationInvariants
} from "../src/dialogue/finalize";

const NOW = new Date("2026-07-26T08:00:00.000Z");

function topic(id = "topic-1", overrides: Partial<DialogueTopic> = {}): DialogueTopic {
  return {
    topic_id: id,
    source_note_id: `note-${id}`,
    source_year: 2026,
    source_excerpt: "A short source observation.",
    ai_summary: "The note considers deliberate practice.",
    historical_links: [],
    ...overrides
  };
}

function sequence(...outputs: unknown[]): { next(): Promise<unknown> } {
  let index = 0;
  return { next: async () => outputs[index++] };
}

function decisions(...outputs: unknown[]): DialogueDecisionMaker {
  const values = sequence(...outputs);
  return { decide: async () => values.next() };
}

function intents(outputs: {
  zero?: unknown[];
  candidate?: unknown[];
  background?: unknown[];
} = {}): UserIntentDecision {
  const zero = sequence(...(outputs.zero ?? []));
  const candidate = sequence(...(outputs.candidate ?? []));
  const background = sequence(...(outputs.background ?? []));
  return {
    classifyZeroResult: async () => zero.next(),
    classifyCandidateConfirmation: async () => candidate.next(),
    classifyBackground: async () => background.next()
  };
}

function context(
  content: DialogueDecisionMaker,
  userIntents: UserIntentDecision = intents(),
  topics: readonly DialogueTopic[] = [topic()],
  repository: MemoryRepository = new MemoryRepository([])
): DialogueContext {
  return {
    currentYear: 2026,
    topics,
    decisions: content,
    userIntents,
    repository,
    now: () => NOW,
    ids: { create: (scope) => `id:${scope}` }
  };
}

function session(topics: readonly DialogueTopic[] = [topic()]): DialogueSessionState {
  return createDialogueSession({ sessionId: "dialogue-1", snapshotId: "snapshot-1", topics, now: NOW });
}

const inferredCandidate = {
  candidate_id: "candidate-1",
  text: "Immediate feedback may improve deliberate practice.",
  explanation: "The source suggests a testable relationship.",
  origin: "source" as const,
  claim_type: "pattern_hypothesis" as const,
  epistemic_status: "ai_inferred" as const
};

describe("reviewed one-question dialogue architecture", () => {
  it("requires current-turn structured zero-result confirmation and keeps reject or unclear in the phase", async () => {
    const first = await advanceDialogue(session(), "No durable result yet.", context(decisions({
      action: "complete_topic", candidates: [], validation_candidates: []
    })));
    expect(first.kind).toBe("question");
    expect(first.session.status).toBe("awaiting_zero_confirmation");

    const unclear = await advanceDialogue(first.session, "Maybe.", context(
      decisions(), intents({ zero: [{ intent: "unclear" }] })
    ));
    expect(unclear.kind).toBe("question");
    expect(unclear.session.status).toBe("awaiting_zero_confirmation");

    const rejected = await advanceDialogue(unclear.session, "No, keep discussing.", context(
      decisions(), intents({ zero: [{ intent: "reject_zero" }] })
    ));
    expect(rejected.kind).toBe("question");
    expect(rejected.session.status).toBe("active");

    const pendingAgain = await advanceDialogue(rejected.session, "Now there is still nothing formal.", context(decisions({
      action: "complete_topic", candidates: [], validation_candidates: []
    })));
    const confirmed = await advanceDialogue(pendingAgain.session, "Yes, finish this topic with no formal result.", context(
      decisions(), intents({ zero: [{ intent: "confirm_zero" }] })
    ));
    expect(confirmed.kind).toBe("final");
    if (confirmed.kind !== "final") throw new Error("expected final");
    expect(confirmed.final.zero_result_confirmation).toContain("finish this topic");
  });

  it("rejects AI-endorsed candidates and requires independent current-turn candidate confirmation provenance", async () => {
    await expect(advanceDialogue(session(), "continue", context(decisions({
      action: "complete_topic",
      candidates: [{ ...inferredCandidate, epistemic_status: "user_confirmed" }],
      validation_candidates: []
    })))).rejects.toBeInstanceOf(DialogueOrchestrationError);

    const proposed = await advanceDialogue(session(), "continue", context(decisions({
      action: "complete_topic",
      candidates: [inferredCandidate],
      validation_candidates: [{ hypothesis: "A short trial helps.", action: "Try for 30 minutes.", kind: "lightweight" }],
      request_user_confirmation: true
    })));
    expect(proposed.session.status).toBe("awaiting_candidate_confirmation");
    const confirmed = await advanceDialogue(proposed.session, "I confirm candidate-1 as my current view.", context(
      decisions(),
      intents({ candidate: [{ intent: "confirm", candidate_ids: ["candidate-1"] }] })
    ));
    expect(confirmed.kind).toBe("final");
    if (confirmed.kind !== "final") throw new Error("expected final");
    expect(confirmed.final.operations[0]).toMatchObject({
      epistemic_status: "user_confirmed",
      confirmation: { user_statement: "I confirm candidate-1 as my current view." }
    });
    expect(confirmed.final.validations).toEqual([
      expect.objectContaining({ kind: "lightweight", status: "candidate" })
    ]);
    expect(confirmed.final.archive.slice(-2).map(({ role }) => role)).toEqual(["user_statement", "formal_result"]);
    expect(confirmed.final.archive.at(-1)).toEqual(expect.objectContaining({
      role: "formal_result",
      candidate_id: "candidate-1",
      text: inferredCandidate.text,
      explanation: inferredCandidate.explanation,
      claim_type: inferredCandidate.claim_type,
      origin: inferredCandidate.origin,
      epistemic_status: "user_confirmed",
      revision_target: null,
      confirmation: expect.objectContaining({ user_statement: "I confirm candidate-1 as my current view." })
    }));
  });

  it("rejects a forged user-confirmed candidate even when its public confirmation fields look valid", async () => {
    const base = session();
    const forged: DialogueSessionState = {
      ...base,
      accumulated_candidates: [{
        ...inferredCandidate,
        epistemic_status: "user_confirmed",
        source_refs: { session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-1" },
        confirmation: {
          user_statement: "I confirm it.",
          confirmed_at: NOW.toISOString(),
          session_id: "dialogue-1",
          turn_index: 1,
          candidate_ids: ["candidate-1"]
        }
      }]
    };
    await expect(advanceDialogue(forged, null, context(decisions({
      action: "complete_topic",
      candidates: [{ ...inferredCandidate, candidate_id: "candidate-2" }],
      validation_candidates: []
    }))))
      .rejects.toBeInstanceOf(DialogueOrchestrationError);
  });

  it("seals confirmed operations in session so restart, clock changes, and random IDs cannot alter them", async () => {
    const topics = [topic("one"), topic("two")];
    const content = decisions(
      { action: "complete_topic", candidates: [inferredCandidate], validation_candidates: [], request_user_confirmation: true },
      { action: "ask", question: "What matters in the second topic?" },
      { action: "complete_topic", candidates: [{ ...inferredCandidate, candidate_id: "candidate-2" }], validation_candidates: [] }
    );
    let idCounter = 0;
    let clockCounter = 0;
    const repository = new MemoryRepository([]);
    const changingContext: DialogueContext = {
      ...context(content, intents({ candidate: [{ intent: "confirm", candidate_ids: ["candidate-1"] }] }), topics, repository),
      ids: { create: (scope) => `${scope}:random-${++idCounter}` },
      now: () => new Date(NOW.getTime() + clockCounter++ * 60_000)
    };
    const proposed = await advanceDialogue(session(topics), "capture", changingContext);
    const confirmed = await advanceDialogue(proposed.session, "I confirm candidate-1.", changingContext);
    expect(confirmed.kind).toBe("question");
    expect(confirmed.session.pending_commit_operations).toHaveLength(1);
    expect(confirmed.session.pending_commit_operations[0]?.operation_ref).toBeTruthy();
    const sealed = structuredClone(confirmed.session.pending_commit_operations[0]);

    const restarted = structuredClone(confirmed.session);
    const completed = await advanceDialogue(restarted, "capture second", changingContext);
    expect(completed.kind).toBe("final");
    if (completed.kind !== "final") throw new Error("expected final");
    expect(completed.final.operations[0]).toEqual(sealed);
    expect(completed.final.operations[0]?.occurred_at).toBe(sealed?.occurred_at);

    await commitDialogueProposal(completed.final, repository);
    await commitDialogueProposal(completed.final, repository);
    expect(repository.events).toHaveLength(2);
  });

  it("rejects candidate tampering and forged confirmation references after restart", async () => {
    const topics = [topic("one"), topic("two")];
    const prepare = async () => {
      const content = decisions(
        { action: "complete_topic", candidates: [inferredCandidate], validation_candidates: [], request_user_confirmation: true },
        { action: "ask", question: "What matters in the second topic?" }
      );
      const repository = new MemoryRepository([]);
      const ctx = context(content, intents({ candidate: [{ intent: "confirm", candidate_ids: ["candidate-1"] }] }), topics, repository);
      const proposed = await advanceDialogue(session(topics), "capture", ctx);
      const confirmed = await advanceDialogue(proposed.session, "I confirm candidate-1.", ctx);
      return { session: confirmed.session, repository };
    };
    const prepared = await prepare();
    const tampered = structuredClone(prepared.session);
    (tampered.accumulated_candidates[0] as { text: string }).text = "Changed after confirmation.";
    await expect(advanceDialogue(tampered, "continue", context(decisions({ action: "ask", question: "What matters now?" }), intents(), topics, prepared.repository)))
      .rejects.toBeInstanceOf(DialogueOrchestrationError);

    const replayed = structuredClone(prepared.session);
    (replayed.pending_commit_operations as unknown as Array<Record<string, unknown>>)[0]!.operation_ref = "forged-ref";
    await expect(advanceDialogue(replayed, "continue", context(decisions({ action: "ask", question: "What matters now?" }), intents(), topics, prepared.repository)))
      .rejects.toBeInstanceOf(DialogueOrchestrationError);
  });

  it("trusts only repository-persisted confirmations across a session restart", async () => {
    const repository = new MemoryRepository([]);
    const topics = [topic("one"), topic("two")];
    const ctx = context(decisions(
      { action: "complete_topic", candidates: [inferredCandidate], validation_candidates: [], request_user_confirmation: true },
      { action: "ask", question: "What matters in the second topic?" }
    ), intents({ candidate: [{ intent: "confirm", candidate_ids: ["candidate-1"] }] }), topics, repository);
    const proposed = await advanceDialogue(session(topics), "capture", ctx);
    const confirmed = await advanceDialogue(proposed.session, "I confirm candidate-1.", ctx);
    const restarted = structuredClone(confirmed.session);
    await expect(advanceDialogue(restarted, "continue", context(
      decisions({ action: "ask", question: "What matters now?" }), intents(), topics, repository
    ))).resolves.toBeDefined();

    const forgedRepository = new MemoryRepository([]);
    await expect(advanceDialogue(restarted, "continue", context(
      decisions({ action: "ask", question: "What matters now?" }), intents(), topics, forgedRepository
    ))).rejects.toBeInstanceOf(DialogueOrchestrationError);
  });

  it("rejects every forged operation version invariant even with otherwise complete session state", async () => {
    const topics = [topic("one"), topic("two")];
    for (const candidate of [inferredCandidate, { ...inferredCandidate, revises_claim: { claim_id: "claim-1", version: 2 } }]) {
      const repository = new MemoryRepository("revises_claim" in candidate ? [{ claim_id: "claim-1", version: 2 }] : []);
      const prepared = await advanceDialogue(session(topics), "capture", context(decisions(
        { action: "complete_topic", candidates: [candidate], validation_candidates: [] },
        { action: "ask", question: "What matters next?" }
      ), intents(), topics, repository));
      const base = prepared.session.pending_commit_operations[0]!;
      const wrongPrevious = base.from_version === 0 ? 1 : 0;
      const mutations = [
        { expected_previous_version: wrongPrevious }, { from_version: wrongPrevious }, { version: base.version + 1 },
        { to_version: base.to_version + 1 },
        { event_type: base.event_type === "claim_created" ? "claim_revised" as const : "claim_created" as const },
        { claim_id: "other-claim" }, { event_id: "" }, { occurred_at: "not-an-instant" }
      ];
      for (const mutation of mutations) {
        const forged = structuredClone(prepared.session);
        (forged.pending_commit_operations as unknown as Array<Record<string, unknown>>)[0] = { ...base, ...mutation };
        await expect(advanceDialogue(forged, null, context(decisions(), intents(), topics, repository)))
          .rejects.toBeInstanceOf(DialogueOrchestrationError);
      }
    }
  });

  it("rejects an isolated new-claim claim_id mutation instead of relying on repository state", async () => {
    const repository = new MemoryRepository([]);
    const topics = [topic("one"), topic("two")];
    const prepared = await advanceDialogue(session(topics), "capture", context(decisions(
      { action: "complete_topic", candidates: [inferredCandidate], validation_candidates: [] },
      { action: "ask", question: "What matters next?" }
    ), intents(), topics, repository));
    const forged = structuredClone(prepared.session);
    (forged.pending_commit_operations as unknown as Array<Record<string, unknown>>)[0]!.claim_id = "other-new-claim";
    await expect(advanceDialogue(forged, null, context(decisions(
      { action: "ask", question: "What matters now?" }
    ), intents(), topics, repository)))
      .rejects.toBeInstanceOf(DialogueOrchestrationError);
  });

  it("records a whole dialogue turn idempotently and rejects conflicting reuse", async () => {
    const repository = new MemoryRepository([]);
    const turn = { session_id: "dialogue-1", turn_key: "dialogue-1:turn:1:topic:topic-1",
      operations: [{ ...inferredCandidate, revises_claim: null, source_refs: {
        session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-1"
      } }], confirmations: [] } satisfies DialogueTurnRecord;
    const first = await repository.recordDialogueTurn(turn);
    expect(await repository.recordDialogueTurn(structuredClone(turn))).toEqual(first);
    await expect(repository.recordDialogueTurn({ ...turn, operations: [{ ...turn.operations[0]!, text: "Different." }] }))
      .rejects.toBeInstanceOf(CommitConflictError);
  });

  it("records multi-candidate turns atomically and a retry creates no orphan operation", async () => {
    const repository = new MemoryRepository([], "candidate-2");
    const turn = { session_id: "dialogue-1", turn_key: "dialogue-1:turn:1:topic:topic-1",
      operations: [inferredCandidate, { ...inferredCandidate, candidate_id: "candidate-2", text: "A second result." }]
        .map((candidate) => ({ ...candidate, revises_claim: null, source_refs: {
          session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: candidate.candidate_id
        } })), confirmations: [] } satisfies DialogueTurnRecord;
    await expect(repository.recordDialogueTurn(turn)).rejects.toBeInstanceOf(CommitConflictError);
    const retried = await repository.recordDialogueTurn(turn);
    expect(retried.operations).toHaveLength(2);
    expect(new Set(retried.operations.map(({ operation_ref }) => operation_ref)).size).toBe(2);
  });

  it("rejects a forged proposal at both exported and repository commit boundaries", async () => {
    const repository = new MemoryRepository([]);
    const result = await advanceDialogue(session(), "capture", context(decisions({
      action: "complete_topic", candidates: [inferredCandidate], validation_candidates: []
    }), intents(), [topic()], repository));
    if (result.kind !== "final") throw new Error("expected final");
    const forged = structuredClone(result.final);
    (forged.operations as unknown as Array<Record<string, unknown>>)[0]!.claim_id = "forged-claim";
    await expect(commitDialogueProposal(forged, repository)).rejects.toBeInstanceOf(CommitConflictError);
    await expect(repository.commit(forged)).rejects.toBeInstanceOf(CommitConflictError);
  });

  it("keeps all AI validation outputs non-active and flags formal plans for separate confirmation", async () => {
    const result = await advanceDialogue(session(), "capture this", context(decisions({
      action: "complete_topic",
      candidates: [inferredCandidate],
      validation_candidates: [
        { hypothesis: "A short trial helps.", action: "Try for 30 minutes.", kind: "lightweight" },
        { hypothesis: "A week-long routine helps.", action: "Schedule a week.", kind: "formal_plan" }
      ]
    })));
    expect(result.kind).toBe("final");
    if (result.kind !== "final") throw new Error("expected final");
    expect(result.final.validations).toEqual([
      expect.objectContaining({ kind: "lightweight", status: "candidate" }),
      expect.objectContaining({ kind: "formal_plan", status: "proposal" })
    ]);
    expect(result.final.needs_formal_plan_confirmation).toBe(true);
  });

  it.each([
    "This is a statement.",
    "What matters? And why?",
    "What matters？Why now？",
    "What matters? Then explain.",
    "What matters"
  ])("rejects content that is not exactly one question: %s", async (question) => {
    await expect(advanceDialogue(session(), null, context(decisions({ action: "ask", question }))))
      .rejects.toBeInstanceOf(DialogueOrchestrationError);
  });

  it("accepts exactly one single-sentence question", async () => {
    const result = await advanceDialogue(session(), null, context(decisions({
      action: "ask", question: "What changed your view most?"
    })));
    expect(result.kind).toBe("question");
  });

  it("returns an idempotent atomic commit proposal with complete append-only events and preserves old versions", async () => {
    const revision = { ...inferredCandidate, revises_claim: { claim_id: "claim-1", version: 2 } };
    const repository = new MemoryRepository([{ claim_id: "claim-1", version: 2 }]);
    const makeProposal = async () => {
      const result = await advanceDialogue(session(), "revise it", context(decisions({
        action: "complete_topic", candidates: [revision], validation_candidates: []
      }), intents(), [topic()], repository));
      if (result.kind !== "final") throw new Error("expected final");
      return result.final;
    };
    const first = await makeProposal();
    const retry = await makeProposal();
    expect(retry.idempotency_key).toBe(first.idempotency_key);
    expect(retry.operations).toEqual(first.operations);
    expect(first.operations[0]).toMatchObject({
      expected_previous_version: 2,
      version: 3,
      event_type: "claim_revised",
      from_version: 2,
      to_version: 3,
      occurred_at: NOW.toISOString(),
      confirmation: null,
      source_refs: {
        session_id: "dialogue-1",
        topic_id: "topic-1",
        source_note_id: "note-topic-1",
        candidate_id: "candidate-1"
      },
      idempotency_key: first.idempotency_key
    });

    await commitDialogueProposal(first, repository);
    await commitDialogueProposal(retry, repository);
    expect(repository.versions("claim-1")).toEqual([2, 3]);
    expect(repository.events).toEqual([expect.objectContaining({ event_id: first.operations[0]?.event_id })]);

    const conflict = { ...first, idempotency_key: "other", operations: first.operations.map((operation) => ({
      ...operation, expected_previous_version: 1
    })) } satisfies DialogueCommitProposal;
    await expect(commitDialogueProposal(conflict, repository)).rejects.toBeInstanceOf(CommitConflictError);
  });

  it("rejects duplicate candidate IDs before repository sealing", async () => {
    await expect(advanceDialogue(session(), "capture", context(decisions({
      action: "complete_topic",
      candidates: [inferredCandidate, { ...inferredCandidate, text: "A second valid proposal exists." }],
      validation_candidates: []
    })))).rejects.toBeInstanceOf(DialogueOrchestrationError);
  });

  it("pauses and resumes the exact active or zero-confirmation phase", async () => {
    const active = await advanceDialogue(session(), null, context(decisions({ action: "ask", question: "What matters now?" })));
    const activePaused = pauseDialogue(active.session, NOW);
    expect(activePaused.paused_from_status).toBe("active");
    expect(resumeDialogue(activePaused, NOW).status).toBe("active");

    const zero = await advanceDialogue(session(), "none", context(decisions({
      action: "complete_topic", candidates: [], validation_candidates: []
    })));
    const zeroPaused = pauseDialogue(zero.session, NOW);
    expect(zeroPaused.paused_from_status).toBe("awaiting_zero_confirmation");
    expect(resumeDialogue(zeroPaused, NOW).status).toBe("awaiting_zero_confirmation");
  });

  it("clones and deeply freezes boundary inputs, AI context, archives, and results", async () => {
    const mutable = topic("mutable", { historical_links: ["old"] });
    let received: unknown;
    const content: DialogueDecisionMaker = {
      decide: async (request) => {
        received = request;
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.topic)).toBe(true);
        return { action: "ask", question: "What matters now?" };
      }
    };
    const created = session([mutable]);
    (mutable.historical_links as string[])[0] = "mutated";
    expect(created.archive[2] !== undefined && "content" in created.archive[2] ? created.archive[2].content : null).toBe("old");
    const result = await advanceDialogue(created, null, context(content, intents(), [mutable]));
    expect(received).toBeDefined();
    expect(Object.isFrozen(result.session.archive[0])).toBe(true);
    expect(() => (result.session.archive as unknown[]).push({})).toThrow();
  });

  it("renders archive as escaped Markdown without interpreting hostile source syntax and preserves order", () => {
    const hostile = topic("hostile", {
      source_excerpt: "---\n# heading\n```js\n[[wiki]] ![[embed]] <script>x</script>"
    });
    const created = session([hostile]);
    const rendered = renderArchiveSafely(created.archive);
    expect(rendered).not.toContain("\n# heading");
    expect(rendered).not.toContain("[[wiki]]");
    expect(rendered).not.toContain("![[embed]]");
    expect(rendered).not.toContain("<script>");
    expect(rendered.indexOf("source_excerpt")).toBeLessThan(rendered.indexOf("ai_summary"));
  });

  it.each([
    { text: "No terminal punctuation", explanation: "Explanation." },
    { text: "One. Two. Three.", explanation: "Explanation." },
    { text: "One valid sentence.", explanation: "" },
    { text: "One valid sentence.", explanation: "x".repeat(501) }
  ])("rejects incomplete or oversized formal candidate %#", async (bad) => {
    await expect(advanceDialogue(session(), "capture", context(decisions({
      action: "complete_topic",
      candidates: [{ ...inferredCandidate, ...bad }],
      validation_candidates: []
    })))).rejects.toBeInstanceOf(DialogueOrchestrationError);
  });

  it("records background as unconfirmed unless current-turn intent classifies it unknown", async () => {
    const old = topic("old", { source_year: 2018, source_excerpt: "x".repeat(900) });
    const prompt = await advanceDialogue(session([old]), null, context(decisions(), intents(), [old]));
    const unclear = await advanceDialogue(prompt.session, "I am not sure.", context(
      decisions(), intents({ background: [{ status: "unclear" }] }), [old]
    ));
    expect(unclear.session.archive).toContainEqual(expect.objectContaining({ role: "context_status", status: "unconfirmed" }));
    expect(unclear.session.unknown_context_topic_ids).toEqual([]);

    const unknown = await advanceDialogue(prompt.session, "I definitely cannot remember it.", context(
      decisions({ action: "ask", question: "Does the idea still fit now?" }),
      intents({ background: [{ status: "unknown" }] }), [old]
    ));
    expect(unknown.session.unknown_context_topic_ids).toEqual(["old"]);
  });

  it("advances across two topics and completes only after the second is finalized", async () => {
    const topics = [topic("one"), topic("two")];
    const content = decisions(
      { action: "complete_topic", candidates: [inferredCandidate], validation_candidates: [] },
      { action: "ask", question: "What matters in the second topic?" },
      { action: "complete_topic", candidates: [{ ...inferredCandidate, candidate_id: "candidate-2" }], validation_candidates: [] }
    );
    const repository = new MemoryRepository([]);
    const ctx = context(content, intents(), topics, repository);
    const afterFirst = await advanceDialogue(session(topics), "capture one", ctx);
    expect(afterFirst.kind).toBe("question");
    expect(afterFirst.session.current_topic_index).toBe(1);
    const done = await advanceDialogue(afterFirst.session, "capture two", ctx);
    expect(done.kind).toBe("final");
    expect(done.session.current_topic_index).toBe(2);
    if (done.kind !== "final") throw new Error("expected final");
    expect(done.final.operations).toHaveLength(2);
  });

  it("redacts provider, schema, clone, and finalize failures across the whole AI path", async () => {
    const secret = "PRIVATE-BODY-61c9";
    const privateTopic = topic("private", { source_excerpt: secret });
    const cases: DialogueDecisionMaker[] = [
      { decide: async () => { throw new Error(secret); } },
      decisions({ action: "ask", question: [secret] }),
      decisions({ action: "complete_topic", candidates: [{ ...inferredCandidate, text: secret }], validation_candidates: [] })
    ];
    for (const content of cases) {
      let caught: unknown;
      try {
        await advanceDialogue(session([privateTopic]), "continue", context(content, intents(), [privateTopic]));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DialogueOrchestrationError);
      expect(String(caught)).not.toContain(secret);
    }
  });
});

describe("Task 5 vulnerability fixes", () => {
  function sealedOperation(overrides: Partial<import("../src/dialogue/session").SessionCommitOperation> = {}): import("../src/dialogue/session").SessionCommitOperation {
    return {
      candidate_id: "candidate-1",
      text: "A test claim.",
      explanation: "Because it matters.",
      origin: "dialogue" as const,
      claim_type: "observation" as const,
      epistemic_status: "ai_inferred" as const,
      claim_id: "claim-test-1",
      version: 1,
      expected_previous_version: 0,
      event_id: "event-test-1",
      event_type: "claim_created" as const,
      from_version: 0,
      to_version: 1,
      occurred_at: NOW.toISOString(),
      confirmation: null,
      source_refs: {
        session_id: "dialogue-1",
        topic_id: "topic-1",
        source_note_id: "note-topic-1",
        candidate_id: "candidate-1"
      },
      idempotency_key: "key-proposal-1",
      operation_ref: "op-ref-1" as OperationRef,
      ...overrides
    };
  }

  function proposal(overrides: Partial<DialogueCommitProposal> = {}): DialogueCommitProposal {
    return {
      session_id: "dialogue-1",
      idempotency_key: "key-proposal-1",
      operations: [sealedOperation()],
      validations: [],
      needs_formal_plan_confirmation: false,
      zero_result_confirmation: null,
      archive: [],
      ...overrides
    };
  }

  // ── Vulnerability 1: duplicate claim_id ──

  it("rejects two operations with the same claim_id at the invariant validation layer", () => {
    const ops = [
      sealedOperation({ claim_id: "dup-claim", event_id: "event-a", operation_ref: "ref-a" as OperationRef }),
      sealedOperation({ claim_id: "dup-claim", event_id: "event-b", operation_ref: "ref-b" as OperationRef,
        candidate_id: "candidate-2", source_refs: { ...sealedOperation().source_refs, candidate_id: "candidate-2" } })
    ];
    expect(() => validateCommitOperationInvariants(ops)).toThrow(CommitConflictError);
  });

  it("rejects duplicate claim_id proposal at the commitDialogueProposal boundary", async () => {
    const repository = new MemoryRepository([]);
    const turn = await repository.recordDialogueTurn({
      session_id: "dialogue-1",
      turn_key: "dialogue-1:turn:1:topic:topic-1",
      operations: [
        { ...inferredCandidate, revises_claim: null, source_refs: {
          session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-1"
        } },
        { ...inferredCandidate, candidate_id: "candidate-2", text: "Second result.",
          revises_claim: null, source_refs: {
            session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-2"
          } }
      ],
      confirmations: []
    });
    // Clone both ops but give them the same claim_id
    const dup = turn.operations.map((op, i) => ({ ...op, claim_id: "same-claim", event_id: `event-dup-${i}`, operation_ref: `ref-dup-${i}` as OperationRef }));
    await expect(commitDialogueProposal(proposal({ operations: dup, idempotency_key: turn.idempotency_key }), repository))
      .rejects.toBeInstanceOf(CommitConflictError);
  });

  it("rejects duplicate claim_id proposal at the repository.commit boundary", async () => {
    const repository = new MemoryRepository([]);
    const turn = await repository.recordDialogueTurn({
      session_id: "dialogue-1",
      turn_key: "dialogue-1:turn:2:topic:topic-1",
      operations: [
        { ...inferredCandidate, revises_claim: null, source_refs: {
          session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-1"
        } },
        { ...inferredCandidate, candidate_id: "candidate-2", text: "Second result.",
          revises_claim: null, source_refs: {
            session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-2"
          } }
      ],
      confirmations: []
    });
    const dup = turn.operations.map((op, i) => ({ ...op, claim_id: "same-claim-2", event_id: `event-dup2-${i}`, operation_ref: `ref-dup2-${i}` as OperationRef }));
    await expect(repository.commit(proposal({ operations: dup, idempotency_key: turn.idempotency_key })))
      .rejects.toBeInstanceOf(CommitConflictError);
  });

  it("leaves zero events and zero claims after a duplicate claim_id rejection", async () => {
    const repository = new MemoryRepository([]);
    const turn = await repository.recordDialogueTurn({
      session_id: "dialogue-1",
      turn_key: "dialogue-1:turn:3:topic:topic-1",
      operations: [
        { ...inferredCandidate, revises_claim: null, source_refs: {
          session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-1"
        } },
        { ...inferredCandidate, candidate_id: "candidate-2", text: "Second result.",
          revises_claim: null, source_refs: {
            session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-2"
          } }
      ],
      confirmations: []
    });
    const dup = turn.operations.map((op, i) => ({ ...op, claim_id: "same-claim-3", event_id: `event-dup3-${i}`, operation_ref: `ref-dup3-${i}` as OperationRef }));
    await expect(repository.commit(proposal({ operations: dup, idempotency_key: turn.idempotency_key })))
      .rejects.toBeInstanceOf(CommitConflictError);
    expect(repository.events).toHaveLength(0);
  });

  it("prevents two operations from producing the same version of the same claim", async () => {
    // Two new-claim operations with same claim_id would both produce v1 → forbidden
    const ops = [
      sealedOperation({ claim_id: "claim-v1-dup", version: 1, expected_previous_version: 0, from_version: 0, to_version: 1,
        event_type: "claim_created", event_id: "ev-a", operation_ref: "ra" as OperationRef }),
      sealedOperation({ claim_id: "claim-v1-dup", version: 1, expected_previous_version: 0, from_version: 0, to_version: 1,
        event_type: "claim_created", event_id: "ev-b", operation_ref: "rb" as OperationRef,
        candidate_id: "candidate-2", source_refs: { ...sealedOperation().source_refs, candidate_id: "candidate-2" } })
    ];
    expect(() => validateCommitOperationInvariants(ops)).toThrow(CommitConflictError);
  });

  // ── Vulnerability 2: idempotency_key binding ──

  it("rejects a proposal where an operation idempotency_key differs from the proposal idempotency_key at commitDialogueProposal", async () => {
    const repository = new MemoryRepository([]);
    const turn = await repository.recordDialogueTurn({
      session_id: "dialogue-1",
      turn_key: "dialogue-1:turn:4:topic:topic-1",
      operations: [{ ...inferredCandidate, revises_claim: null, source_refs: {
        session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-1"
      } }],
      confirmations: []
    });
    const tampered = turn.operations.map((op) => ({ ...op, idempotency_key: "different-key" }));
    await expect(commitDialogueProposal(proposal({ operations: tampered, idempotency_key: turn.idempotency_key }), repository))
      .rejects.toBeInstanceOf(CommitConflictError);
  });

  it("rejects idempotency_key mismatch at the repository.commit boundary", async () => {
    const repository = new MemoryRepository([]);
    const turn = await repository.recordDialogueTurn({
      session_id: "dialogue-1",
      turn_key: "dialogue-1:turn:5:topic:topic-1",
      operations: [{ ...inferredCandidate, revises_claim: null, source_refs: {
        session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-1"
      } }],
      confirmations: []
    });
    const tampered = turn.operations.map((op) => ({ ...op, idempotency_key: "another-key" }));
    await expect(repository.commit(proposal({ operations: tampered, idempotency_key: turn.idempotency_key })))
      .rejects.toBeInstanceOf(CommitConflictError);
  });

  it("returns already_committed for a normal repeated commit", async () => {
    const repository = new MemoryRepository([]);
    const result = await advanceDialogue(session(), "capture", context(decisions({
      action: "complete_topic", candidates: [inferredCandidate], validation_candidates: []
    }), intents(), [topic()], repository));
    if (result.kind !== "final") throw new Error("expected final");
    await commitDialogueProposal(result.final, repository);
    const retry = await commitDialogueProposal(result.final, repository);
    expect(retry).toBe("already_committed");
  });

  it("returns the same already_committed for a zero-result turn repeated with a different key", async () => {
    const repository = new MemoryRepository([]);
    const first = await repository.sealZeroResultTurn({
      sessionId: "dialogue-1",
      topicId: "topic-1",
      turnIndex: 1,
      userText: "Yes, finish with no result.",
      confirmedAt: NOW,
      idempotencyKey: "zero-key-A"
    });
    // Same logical turn, different key → must return the same ref (with original key)
    const second = await repository.sealZeroResultTurn({
      sessionId: "dialogue-1",
      topicId: "topic-1",
      turnIndex: 1,
      userText: "Yes, finish with no result.",
      confirmedAt: NOW,
      idempotencyKey: "zero-key-B"
    });
    expect(second).toEqual(first);
    expect(second.idempotency_key).toBe("zero-key-A");
  });

  it("does not write half events when a later operation in a proposal fails version check", async () => {
    // Seed a claim at v0 (no claim), then have op2 try to revise a non-existent claim at v1→v2
    const repository = new MemoryRepository([]);
    // Both turns share the same session_id, so recordDialogueTurn assigns the same idempotency_key
    const turn1 = await repository.recordDialogueTurn({
      session_id: "dialogue-1",
      turn_key: "dialogue-1:turn:6a:topic:topic-1",
      operations: [{ ...inferredCandidate, revises_claim: null, source_refs: {
        session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-1"
      } }],
      confirmations: []
    });
    // Second operation revises claim-B at v1→v2, but claim-B has no prior version (current=0)
    const turn2 = await repository.recordDialogueTurn({
      session_id: "dialogue-1",
      turn_key: "dialogue-1:turn:6b:topic:topic-1",
      operations: [{ ...inferredCandidate, candidate_id: "candidate-2", text: "Revises non-existent claim.",
        revises_claim: { claim_id: "claim-B", version: 1 }, source_refs: {
          session_id: "dialogue-1", topic_id: "topic-1", source_note_id: "note-topic-1", candidate_id: "candidate-2"
        } }],
      confirmations: []
    });
    // Both operations share the same idempotency_key (from the session) → matches proposal key
    const key = turn1.idempotency_key;
    const ops = [turn1.operations[0]!, turn2.operations[0]!];
    await expect(repository.commit(proposal({ operations: ops, idempotency_key: key })))
      .rejects.toBeInstanceOf(CommitConflictError);
    // Zero events must have been written (atomicity)
    expect(repository.events).toHaveLength(0);
    // A retry with just the first operation should succeed (key was not consumed due to atomic rollback)
    await repository.commit(proposal({ operations: [turn1.operations[0]!], idempotency_key: key }));
    expect(repository.events).toHaveLength(1);
  });
});

class MemoryRepository implements DialogueRepository {
  private readonly claims: Array<{ claim_id: string; version: number }>;
  private readonly keys = new Set<string>();
  readonly events: Array<{ event_id: string }> = [];
  readonly #turns = new Map<string, { request: string; result: { idempotency_key: string; operations: readonly import("../src/dialogue/session").SessionCommitOperation[] } }>();
  readonly #operations = new Map<OperationRef, OperationCanonicalPayload>();
  readonly #zeroResults = new Map<string, ZeroResultRef>();
  private failCandidateId: string | null;

  constructor(claims: Array<{ claim_id: string; version: number }>, failCandidateId: string | null = null) {
    this.claims = [...claims];
    this.failCandidateId = failCandidateId;
  }

  async commit(proposal: DialogueCommitProposal): Promise<"committed" | "already_committed"> {
    validateCommitOperationInvariants(proposal.operations);
    for (const operation of proposal.operations) {
      if (operation.idempotency_key !== proposal.idempotency_key) throw new CommitConflictError();
      if (!(await this.verifyOperation(operation.operation_ref, canonicalOperationPayload(operation)))) throw new CommitConflictError();
    }
    if (this.keys.has(proposal.idempotency_key)) return "already_committed";
    for (const operation of proposal.operations) {
      const versions = this.versions(operation.claim_id);
      const current = versions.at(-1) ?? 0;
      if (current !== operation.expected_previous_version) throw new CommitConflictError();
    }
    this.claims.push(...proposal.operations.map(({ claim_id, version }) => ({ claim_id, version })));
    this.events.push(...proposal.operations.map(({ event_id }) => ({ event_id })));
    this.keys.add(proposal.idempotency_key);
    return "committed";
  }

  async sealZeroResultTurn(input: {
    readonly sessionId: string;
    readonly topicId: string;
    readonly turnIndex: number;
    readonly userText: string;
    readonly confirmedAt: Date;
    readonly idempotencyKey: string;
  }): Promise<ZeroResultRef> {
    const identityKey = `${input.sessionId} ${input.topicId} ${input.turnIndex}`;
    const existing = this.#zeroResults.get(identityKey);
    if (existing !== undefined) return existing;
    const ref: ZeroResultRef = {
      session_id: input.sessionId,
      topic_id: input.topicId,
      turn_index: input.turnIndex,
      idempotency_key: input.idempotencyKey
    };
    this.#zeroResults.set(identityKey, ref);
    this.keys.add(input.idempotencyKey);
    return ref;
  }

  async recordDialogueTurn(turn: DialogueTurnRecord): Promise<{ idempotency_key: string; operations: readonly import("../src/dialogue/session").SessionCommitOperation[] }> {
    const request = JSON.stringify(turn);
    const existing = this.#turns.get(turn.turn_key);
    if (existing !== undefined) {
      if (existing.request !== request) throw new CommitConflictError();
      return structuredClone(existing.result);
    }
    const candidateIds = turn.operations.map(({ candidate_id }) => candidate_id);
    const confirmationIds = turn.confirmations.map(({ candidate_id }) => candidate_id);
    if (!turn.turn_key.trim() || !turn.session_id.trim() || new Set(candidateIds).size !== candidateIds.length
      || new Set(confirmationIds).size !== confirmationIds.length
      || confirmationIds.some((candidateId) => !candidateIds.includes(candidateId))
      || turn.operations.some((candidate) => candidate.source_refs.session_id !== turn.session_id
        || candidate.source_refs.candidate_id !== candidate.candidate_id
        || (candidate.epistemic_status === "user_confirmed") !== confirmationIds.includes(candidate.candidate_id)
        || (candidate.epistemic_status === "user_confirmed" && (candidate.confirmation === undefined
          || !turn.confirmations.some((confirmation) => confirmation.candidate_id === candidate.candidate_id
            && confirmation.user_statement === candidate.confirmation?.user_statement
            && confirmation.turn_index === candidate.confirmation?.turn_index))))) {
      throw new CommitConflictError();
    }
    if (turn.operations.some(({ candidate_id }) => candidate_id === this.failCandidateId)) {
      this.failCandidateId = null;
      throw new CommitConflictError();
    }
    const idempotencyKey = `commit:${turn.session_id}`;
    const occurredAt = NOW.toISOString();
    const sealedPayloads: Array<[OperationRef, OperationCanonicalPayload]> = [];
    const operations = turn.operations.map((candidate, index) => {
      const expected = candidate.revises_claim?.version ?? 0;
      const claimId = candidate.revises_claim?.claim_id ?? `claim:${turn.turn_key}:${candidate.candidate_id}`;
      const eventId = `event:${turn.turn_key}:${candidate.candidate_id}:${index}`;
      const ref = `operation:${turn.turn_key}:${candidate.candidate_id}:${index}` as OperationRef;
      const operation: import("../src/dialogue/session").SessionCommitOperation = {
        candidate_id: candidate.candidate_id, text: candidate.text, explanation: candidate.explanation,
        origin: candidate.origin, claim_type: candidate.claim_type, epistemic_status: candidate.epistemic_status,
        claim_id: claimId, version: expected + 1, expected_previous_version: expected, event_id: eventId,
        event_type: expected === 0 ? "claim_created" : "claim_revised", from_version: expected, to_version: expected + 1,
        occurred_at: occurredAt, confirmation: candidate.confirmation ?? null, source_refs: candidate.source_refs,
        idempotency_key: idempotencyKey, operation_ref: ref
      };
      sealedPayloads.push([ref, canonicalOperationPayload(operation)]);
      return operation;
    });
    validateCommitOperationInvariants(operations);
    const result = structuredClone({ idempotency_key: idempotencyKey, operations });
    for (const [ref, payload] of sealedPayloads) this.#operations.set(ref, payload);
    this.#turns.set(turn.turn_key, { request, result });
    return structuredClone(result);
  }

  async verifyOperation(ref: OperationRef, expectedCanonicalPayload: OperationCanonicalPayload): Promise<boolean> {
    const payload = this.#operations.get(ref);
    return payload !== undefined && JSON.stringify(payload) === JSON.stringify(expectedCanonicalPayload);
  }

  versions(claimId: string): number[] {
    return this.claims.filter(({ claim_id }) => claim_id === claimId).map(({ version }) => version).sort((a, b) => a - b);
  }
}
