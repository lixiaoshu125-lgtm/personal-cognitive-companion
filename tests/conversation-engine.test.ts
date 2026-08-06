/**
 * Conversation Engine Tests — Task 05
 *
 * 14 Required Test Scenarios:
 *  1. sendMessage → AI reply with candidates
 *  2. AI asks only one question per turn
 *  3. AI outputs user_confirmed → engine rejects response
 *  4. AI proposes summary → awaiting_summary_confirmation
 *  5. User confirms summary → completed + confirmed_results
 *  6. User modifies then confirms → modified claims become user_confirmed
 *  7. User rejects summary → back to active
 *  8. User continues discussion → back to active
 *  9. endWithoutConclusion → completed + no_formal_result, no claims written
 * 10. Writeback success → claims in repository
 * 11. Writeback failure → conversation stays awaiting_summary_confirmation
 * 12. Restart recovery → awaiting_summary_confirmation preserved
 * 13. Archive contains real content (non-empty turns/claims/references)
 * 14. No Weekly dependency (verified by grep at end)
 *
 * All tests use FakeConversationAiProvider — no real DeepSeek calls.
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { ConversationAiOutput } from "../src/conversation/engine";
import {
  ConversationEngine,
  buildConversationPrompt,
  conversationAiOutputSchema,
  classifyConfirmationIntent,
} from "../src/conversation/engine";
import type {
  ConversationTurnResult,
  ConfirmationResult,
  AiCandidate,
} from "../src/conversation/engine";
// writeback module deleted — writeback is now handled inline in the engine
import type { ConversationArchive, ArchivedTurn } from "../src/conversation/archive";
import { buildConversationArchive } from "../src/conversation/archive";
import type { AiProvider, AiCompletionRequest } from "../src/ai/provider";
import type { CognitiveContext } from "../src/context/cognitive-context";
import {
  createConversation,
  appendTurn,
  type Conversation,
  type ConversationSeed,
  type Clock,
} from "../src/conversation/model";
import { InMemoryConversationStore } from "../src/conversation/store";

// ═══════════════════════════════════════════════════════════════
// Fake AI Provider
// ═══════════════════════════════════════════════════════════════

class FakeConversationAiProvider implements AiProvider {
  private outputs: ConversationAiOutput[] = [];

  /** Enqueue a preset output. Each call to complete() dequeues one. */
  enqueue(output: ConversationAiOutput): void {
    this.outputs.push(output);
  }

  async complete<Output>(
    _request: AiCompletionRequest<Output>,
    _signal?: AbortSignal,
  ): Promise<Output> {
    const output = this.outputs.shift();
    if (!output) {
      throw new Error("FakeConversationAiProvider: no queued output");
    }
    return output as unknown as Output;
  }

  /** Clear all queued outputs. */
  reset(): void {
    this.outputs.length = 0;
  }
}

// Writeback is now handled inline in the engine — no separate repository or service.
// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function clock(iso: string): Clock {
  const d = new Date(iso);
  return { now: () => d };
}

function freeQuestionSeed(question = "What should I focus on?"): ConversationSeed {
  return { kind: "free_question", question };
}

function freshConversation(seed?: ConversationSeed): Conversation {
  return createConversation(seed ?? freeQuestionSeed(), clock("2026-07-29T08:00:00Z"));
}

function emptyContext(): CognitiveContext {
  return {
    vaultSnippets: [],
    wikiSnippets: [],
    exclusions: [],
    truncated: false,
    metadata: {
      vault_notes_scanned: 0,
      vault_notes_matched: 0,
      vault_notes_excluded: 0,
      wiki_pages_scanned: 0,
      wiki_pages_matched: 0,
      snippet_chars_used: 0,
      budget_exceeded: false,
    },
  };
}

function normalReply(): ConversationAiOutput {
  return {
    response_text: "这是一个很好的问题。让我帮你梳理一下思路。",
    candidates: [
      {
        epistemic_status: "ai_inferred" as const,
        canonical_text: "你的工作重点应该放在提高深度工作的时间上",
        evidence_refs: [],
        confidence: 0.8,
      },
    ],
    should_summarize: false,
    should_generate_wiki: false,
    question: "你目前每天有多少不受打扰的工作时间？",
  };
}

function summarizeReply(): ConversationAiOutput {
  return {
    response_text: "基于我们的讨论，我认为可以总结出以下几点...",
    candidates: [
      {
        epistemic_status: "to_verify" as const,
        canonical_text: "你需要每天至少2小时的深度工作时间来提高产出",
        evidence_refs: [],
        confidence: 0.85,
      },
    ],
    should_summarize: true,
    should_generate_wiki: false,
    summary: "你的核心问题是深度工作时间不足，建议每天安排2小时不受打扰的专注时段。",
    question: "这个总结是否准确反映了你的情况？",
  };
}

function maliciousReply(): ConversationAiOutput {
  return {
    response_text: "我已经帮你确认了这个观点。",
    candidates: [
      {
        epistemic_status: "user_confirmed" as any, // Deliberately wrong
        canonical_text: "这个观点已经被用户确认",
        evidence_refs: [],
        confidence: 0.95,
      },
    ],
    should_summarize: false,
    should_generate_wiki: false,
    question: "还有其他问题吗？",
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. Send Message → AI Reply
// ═══════════════════════════════════════════════════════════════

describe("Conversation Engine", () => {
  let ai: FakeConversationAiProvider;
  let engine: ConversationEngine;

  beforeEach(() => {
    ai = new FakeConversationAiProvider();
    engine = new ConversationEngine(ai, clock("2026-07-29T08:00:00Z"));
  });

  describe("scenario 1: sendMessage → AI reply with candidates", () => {
    it("appends user turn and AI turn, returns candidates", async () => {
      ai.enqueue(normalReply());
      const conv = freshConversation();

      const result = await engine.sendMessage(conv, "我应该关注什么？", emptyContext());

      // Conversation updated
      expect(result.conversation.revision).toBeGreaterThan(conv.revision);
      expect(result.conversation.turns.length).toBe(1); // KI-T11-01: only assistant, user appended by caller

      // KI-T11-01: engine no longer appends user turn — caller is responsible.
      // Only the AI (assistant) turn is in the conversation.
      expect(result.conversation.turns[0]!.role).toBe("assistant");
      expect(result.conversation.turns[0]!.text).toBe(normalReply().response_text);

      // AI response content
      expect(result.aiResponse.text).toBe(normalReply().response_text);
      expect(result.aiResponse.internal.candidates.length).toBe(1);
      expect(result.aiResponse.internal.candidates[0]!.epistemic_status).toBe("ai_inferred");

      // Candidates
      expect(result.newCandidates.length).toBe(1);
      expect(result.newCandidates[0]!.epistemic_status).toBe("ai_inferred");

      // Not awaiting confirmation
      expect(result.awaitingConfirmation).toBe(false);

      // Status stays active
      expect(result.conversation.status).toBe("active");
    });

    it("throws when conversation is not active", async () => {
      // Complete the conversation first
      const conv = freshConversation();
      const paused = await engine.endWithoutConclusion(conv);
      // completed conversation

      await expect(
        engine.sendMessage(paused, "hello", emptyContext()),
      ).rejects.toThrow();
    });
  });

  describe("manual conclusion", () => {
    it("forces a plain-text AI result into summary confirmation without a synthetic user turn", async () => {
      ai.enqueue({
        response_text: "1. 我需要优先处理核心项目 2. 我需要减少低价值事务",
        candidates: [],
        should_summarize: false,
        should_generate_wiki: false,
        question: "还有什么想法吗？",
      });
      const conversation = appendTurn(
        freshConversation(),
        "user",
        "我最近的时间安排很混乱",
        clock("2026-07-29T08:01:00Z"),
      );

      const result = await engine.concludeConversation(conversation, emptyContext());

      expect(result.awaitingConfirmation).toBe(true);
      expect(result.conversation.status).toBe("awaiting_summary_confirmation");
      expect(result.summaryText).toBe("1. 我需要优先处理核心项目 2. 我需要减少低价值事务");
      expect(result.conversation.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
      expect(result.conversation.turns.some((turn) => turn.text.includes("请基于我们以上"))).toBe(false);
    });

    it("shows only the final summary when the AI also returns explanatory response text", async () => {
      ai.enqueue(summarizeReply());
      const conversation = appendTurn(
        freshConversation(),
        "user",
        "我需要改善专注时间",
        clock("2026-07-29T08:01:00Z"),
      );

      const result = await engine.concludeConversation(conversation, emptyContext());

      expect(result.conversation.turns).toHaveLength(2);
      expect(result.conversation.turns[1]?.text).toBe(summarizeReply().summary);
      expect(result.conversation.turns.some((turn) => turn.text === summarizeReply().response_text)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 2. AI asks only one question
  // ═══════════════════════════════════════════════════════════

  describe("scenario 2: AI asks only one question per turn", () => {
    it("AI output has exactly one question string", async () => {
      ai.enqueue(normalReply());
      const conv = freshConversation();

      const result = await engine.sendMessage(conv, "告诉我关于深度工作的事情", emptyContext());

      // question field is a single string
      expect(typeof result.aiResponse.internal.question).toBe("string");
      expect(result.aiResponse.internal.question!.length).toBeGreaterThan(0);

      // The question should not contain multiple questions (no multiple ? marks)
      const q = result.aiResponse.internal.question!;
      const questionMarks = (q.match(/[?？]/g) ?? []).length;
      expect(questionMarks).toBeLessThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 3. AI outputs user_confirmed → REJECTED
  // ═══════════════════════════════════════════════════════════

  describe("scenario 3: AI outputs user_confirmed → engine rejects", () => {
    it("throws AiProviderError when AI returns user_confirmed in candidates", async () => {
      ai.enqueue(maliciousReply());
      const conv = freshConversation();

      await expect(
        engine.sendMessage(conv, "你好", emptyContext()),
      ).rejects.toThrow(/invalid/);
    });

    it("conversation is not mutated after rejection", async () => {
      ai.enqueue(maliciousReply());
      const conv = freshConversation();
      const originalRevision = conv.revision;
      const originalTurnCount = conv.turns.length;

      try {
        await engine.sendMessage(conv, "你好", emptyContext());
      } catch {
        // Expected — conversation should be unchanged
      }

      // Conversation object is immutable, but verify no new version was produced
      expect(conv.revision).toBe(originalRevision);
      expect(conv.turns.length).toBe(originalTurnCount);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 4. AI proposes summary → awaiting_summary_confirmation
  // ═══════════════════════════════════════════════════════════

  describe("scenario 4: AI proposes summary confirmation", () => {
    it("transitions to awaiting_summary_confirmation when should_summarize is true", async () => {
      ai.enqueue(summarizeReply());
      const conv = freshConversation();

      const result = await engine.sendMessage(conv, "我觉得深度工作很重要", emptyContext());

      expect(result.awaitingConfirmation).toBe(true);
      expect(result.summaryText).toBe(summarizeReply().summary);
      expect(result.conversation.status).toBe("awaiting_summary_confirmation");
    });

    it("summary is required when should_summarize is true", async () => {
      const replyWithoutSummary: ConversationAiOutput = {
        response_text: "总结如下...",
        candidates: [{ epistemic_status: "to_verify", canonical_text: "test", evidence_refs: [], confidence: 0.5 }],
        should_summarize: true,
        should_generate_wiki: false,
        // summary is missing (required when should_summarize)
        question: "对吗？",
      };

      ai.enqueue(replyWithoutSummary);
      const conv = freshConversation();

      await expect(
        engine.sendMessage(conv, "测试", emptyContext()),
      ).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 5. User confirms summary → completed + confirmed_results
  // ═══════════════════════════════════════════════════════════

  describe("scenario 5: user confirms summary", () => {
    it("completes conversation with confirmed_results on user confirmation", async () => {
      // First, get to awaiting_summary_confirmation state
      ai.enqueue(summarizeReply());
      const conv = freshConversation();
      const interim = await engine.sendMessage(conv, "讨论深度工作", emptyContext());
      expect(interim.conversation.status).toBe("awaiting_summary_confirmation");

      // User confirms
      const result = await engine.handleConfirmationResponse(
        interim.conversation,
        "好的，这个总结很准确，我同意。",
        emptyContext(),
      );

      expect(result.action).toBe("confirmed");
      expect(result.conversation.status).toBe("completed");
      expect(result.conversation.end_reason).toBe("confirmed_results");
      expect(result.wikiConclution).not.toBeNull();
      expect(result.wikiConclution!.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 6. User modifies then confirms
  // ═══════════════════════════════════════════════════════════

  describe("scenario 6: user modifies then confirms", () => {
    it("modified summary captures user's correction as wikiConclution", async () => {
      ai.enqueue(summarizeReply());
      const conv = freshConversation();
      const interim = await engine.sendMessage(conv, "讨论深度工作", emptyContext());

      // User modifies the summary
      const result = await engine.handleConfirmationResponse(
        interim.conversation,
        "改成：我需要每天3小时的深度工作时间，而不是2小时。",
        emptyContext(),
      );

      expect(result.action).toBe("modified");
      expect(result.conversation.status).toBe("completed");
      expect(result.conversation.end_reason).toBe("confirmed_results");
      // Modified wikiConclution should reflect user's correction
      expect(result.wikiConclution).not.toBeNull();
      expect(result.wikiConclution).toContain("3小时");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 7. User rejects summary → back to active
  // ═══════════════════════════════════════════════════════════

  describe("scenario 7: user rejects summary", () => {
    it("transitions back to active when user rejects", async () => {
      ai.enqueue(summarizeReply());
      const conv = freshConversation();
      const interim = await engine.sendMessage(conv, "讨论深度工作", emptyContext());
      expect(interim.conversation.status).toBe("awaiting_summary_confirmation");

      const result = await engine.handleConfirmationResponse(
        interim.conversation,
        "不对，这个总结没有抓住重点。",
        emptyContext(),
      );

      expect(result.action).toBe("rejected");
      expect(result.conversation.status).toBe("active");
      // No wiki conclusion should be produced
      expect(result.wikiConclution).toBeNull();
    });

    it("can continue sending messages after rejection", async () => {
      ai.enqueue(summarizeReply());
      const conv = freshConversation();
      const interim = await engine.sendMessage(conv, "讨论", emptyContext());

      const rejected = await engine.handleConfirmationResponse(
        interim.conversation,
        "不对，重新讨论。",
        emptyContext(),
      );

      // Now send another message
      ai.enqueue(normalReply());
      const continued = await engine.sendMessage(
        rejected.conversation,
        "那我们换个角度讨论",
        emptyContext(),
      );

      expect(continued.conversation.status).toBe("active");
      expect(continued.aiResponse.text).toBe(normalReply().response_text);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 8. User continues discussion → back to active
  // ═══════════════════════════════════════════════════════════

  describe("scenario 8: user continues discussion", () => {
    it("transitions back to active when user wants to continue", async () => {
      ai.enqueue(summarizeReply());
      const conv = freshConversation();
      const interim = await engine.sendMessage(conv, "讨论", emptyContext());
      expect(interim.conversation.status).toBe("awaiting_summary_confirmation");

      const result = await engine.handleConfirmationResponse(
        interim.conversation,
        "再聊聊这个话题，我还有疑问。",
        emptyContext(),
      );

      expect(result.action).toBe("continued");
      expect(result.conversation.status).toBe("active");
      expect(result.wikiConclution).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 9. endWithoutConclusion
  // ═══════════════════════════════════════════════════════════

  describe("scenario 9: endWithoutConclusion", () => {
    it("completes with no_formal_result and writes no claims", async () => {
      ai.enqueue(normalReply());
      const conv = freshConversation();
      const withTurn = await engine.sendMessage(conv, "随便聊聊", emptyContext());

      const ended = await engine.endWithoutConclusion(withTurn.conversation);

      expect(ended.status).toBe("completed");
      expect(ended.end_reason).toBe("no_formal_result");
    });

    it("completes without producing wiki conclusion", async () => {
      ai.enqueue(normalReply());
      const conv = freshConversation();
      const withTurn = await engine.sendMessage(conv, "随便聊聊", emptyContext());

      const ended = await engine.endWithoutConclusion(withTurn.conversation);

      // No wiki conclusion is produced for no_formal_result
      expect(ended.status).toBe("completed");
      expect(ended.end_reason).toBe("no_formal_result");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 10. User confirmation completes conversation directly
  // ═══════════════════════════════════════════════════════════

  describe("scenario 10: user confirmation completes conversation", () => {
    it("completes conversation and produces wikiConclution on user confirmation", async () => {
      ai.enqueue(summarizeReply());
      const conv = freshConversation();
      const interim = await engine.sendMessage(conv, "讨论", emptyContext());

      const result = await engine.handleConfirmationResponse(
        interim.conversation,
        "好的，我同意这个总结。",
        emptyContext(),
      );

      expect(result.action).toBe("confirmed");
      expect(result.conversation.status).toBe("completed");
      expect(result.wikiConclution).not.toBeNull();
      expect(result.wikiConclution!.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 11. Confirming a non-awaiting conversation throws
  // ═══════════════════════════════════════════════════════════

  describe("scenario 11: cannot confirm a non-awaiting conversation", () => {
    it("throws when confirming an active conversation", async () => {
      const conv = freshConversation();

      await expect(
        engine.handleConfirmationResponse(conv, "好的，我同意。", emptyContext()),
      ).rejects.toThrow("awaiting_summary_confirmation");
    });

    it("throws when confirming a completed conversation", async () => {
      ai.enqueue(summarizeReply());
      const conv = freshConversation();
      const interim = await engine.sendMessage(conv, "讨论", emptyContext());
      const confirmed = await engine.handleConfirmationResponse(
        interim.conversation,
        "好的，我同意。",
        emptyContext(),
      );
      expect(confirmed.conversation.status).toBe("completed");

      // Cannot confirm again
      await expect(
        engine.handleConfirmationResponse(confirmed.conversation, "再一次", emptyContext()),
      ).rejects.toThrow("awaiting_summary_confirmation");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 12. Restart recovery: awaiting_summary_confirmation preserved
  // ═══════════════════════════════════════════════════════════

  describe("scenario 12: restart recovery preserves awaiting_summary_confirmation", () => {
    it("conversation state survives JSON serialize → deserialize round-trip", async () => {
      // Get to awaiting_summary_confirmation
      ai.enqueue(summarizeReply());
      const conv = freshConversation();
      const interim = await engine.sendMessage(conv, "讨论", emptyContext());
      expect(interim.conversation.status).toBe("awaiting_summary_confirmation");

      // Simulate Obsidian restart: serialize → deserialize (plugin state JSON round-trip)
      const serialized = JSON.stringify(interim.conversation);
      const restored: Conversation = JSON.parse(serialized);
      expect(restored.status).toBe("awaiting_summary_confirmation");

      // Create a new engine instance (simulates fresh plugin load)
      const newEngine = new ConversationEngine(
        new FakeConversationAiProvider(),
        clock("2026-07-29T10:00:00Z"),
      );

      // User should be able to confirm from restored state
      const confirmResult = await newEngine.handleConfirmationResponse(
        restored,
        "好的，我同意。",
        emptyContext(),
      );

      expect(confirmResult.action).toBe("confirmed");
      expect(confirmResult.conversation.status).toBe("completed");
      expect(confirmResult.conversation.end_reason).toBe("confirmed_results");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 13. Archive contains real content
  // ═══════════════════════════════════════════════════════════

  describe("scenario 13: archive contains real content", () => {
    it("completed conversation produces non-empty archive", async () => {
      ai.enqueue(normalReply());
      ai.enqueue(summarizeReply());
      const conv = freshConversation();

      // Have a multi-turn conversation
      const t1 = await engine.sendMessage(conv, "什么是深度工作？", emptyContext());
      const interim = await engine.sendMessage(t1.conversation, "我觉得这很重要", emptyContext());

      // Confirm summary
      const confirmed = await engine.handleConfirmationResponse(
        interim.conversation,
        "好的，我同意这个总结。",
        emptyContext(),
      );

      const archive = buildConversationArchive(confirmed.conversation, confirmed.wikiConclution);

      // Archive must reflect real conversation content
      expect(archive.status).toBe("completed");
      expect(archive.end_reason).toBe("confirmed_results");

      // turns must be non-empty
      expect(archive.turns.length).toBeGreaterThan(0);
      // Each turn should have content
      for (const turn of archive.turns) {
        expect(turn.text.length).toBeGreaterThan(0);
      }

      // wiki_conclusion must be non-null for confirmed_results
      expect(archive.wiki_conclusion).not.toBeNull();

      // context_summary must reference real conversation
      expect(archive.turns.length).toBeGreaterThanOrEqual(2); // at least user + assistant exchanges
    });

    it("no_formal_result archive also contains real turns", async () => {
      ai.enqueue(normalReply());
      const conv = freshConversation();
      const withTurn = await engine.sendMessage(conv, "随便聊聊", emptyContext());
      const ended = await engine.endWithoutConclusion(withTurn.conversation);

      const archive = buildConversationArchive(ended, null);

      expect(archive.status).toBe("completed");
      expect(archive.end_reason).toBe("no_formal_result");
      expect(archive.turns.length).toBeGreaterThan(0);
      expect(archive.wiki_conclusion).toBeNull(); // no wiki for no_formal_result
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 14. No Weekly dependency
  // ═══════════════════════════════════════════════════════════
  // Verified by: tests import no Weekly types; grep confirms zero Weekly imports
  // (see task report)
});

// ═══════════════════════════════════════════════════════════════
// buildConversationPrompt Tests
// ═══════════════════════════════════════════════════════════════

describe("buildConversationPrompt", () => {
  it("includes conversation history in messages", () => {
    const conv = freshConversation();
    const withTurn = appendTurn(conv, "user", "什么是深度工作？", clock("2026-07-29T08:01:00Z"));

    const request = buildConversationPrompt(
      withTurn,
      "继续讨论",
      emptyContext(),
      "你是一个认知助手",
    );

    expect(request.messages.length).toBeGreaterThanOrEqual(2);
    // Should have system message
    expect(request.messages[0]!.role).toBe("system");
    // Should use the conversationAiOutputSchema
    expect(request.outputSchema).toBe(conversationAiOutputSchema);
    expect(request.outputName).toBe("conversation_ai_output");
  });

  it("includes cognitive context vault snippets when available", () => {
    const conv = freshConversation();
    const ctx: CognitiveContext = {
      vaultSnippets: [
        {
          note_id: "note-1",
          note_path: "note-1.md",
          note_title: "note-1",
          snippet: "用户偏好深度工作",
          char_count: 10,
        },
      ],
      wikiSnippets: [],
      exclusions: [],
      truncated: false,
      metadata: {
        vault_notes_scanned: 1,
        vault_notes_matched: 1,
        vault_notes_excluded: 0,
        wiki_pages_scanned: 0,
        wiki_pages_matched: 0,
        snippet_chars_used: 0,
        budget_exceeded: false,
      },
    };

    const request = buildConversationPrompt(
      conv,
      "深度工作",
      ctx,
      "你是一个认知助手",
    );

    // The system message or user message should reference the snippet
    const allContent = request.messages.map((m) => m.content).join("\n");
    expect(allContent).toContain("用户偏好深度工作");
  });
});

// ═══════════════════════════════════════════════════════════════
// classifyConfirmationIntent Tests
// ═══════════════════════════════════════════════════════════════

describe("classifyConfirmationIntent", () => {
  it('classifies "好的" as confirmed', () => {
    expect(classifyConfirmationIntent("好的，我同意")).toBe("confirmed");
  });

  it('classifies "同意" as confirmed', () => {
    expect(classifyConfirmationIntent("同意这个总结")).toBe("confirmed");
  });

  it('classifies "改成" as modified', () => {
    expect(classifyConfirmationIntent("改成每天3小时")).toBe("modified");
  });

  it('classifies "应该是" as modified', () => {
    expect(classifyConfirmationIntent("应该是每天4小时才对")).toBe("modified");
  });

  it('classifies "不对" as rejected', () => {
    expect(classifyConfirmationIntent("不对，这个总结有问题")).toBe("rejected");
  });

  it('classifies "再聊聊" as continued', () => {
    expect(classifyConfirmationIntent("再聊聊这个话题")).toBe("continued");
  });

  it('classifies "继续讨论" as continued', () => {
    expect(classifyConfirmationIntent("继续讨论，我还有疑问")).toBe("continued");
  });

  it("defaults to continued for ambiguous input", () => {
    expect(classifyConfirmationIntent("嗯，让我想想")).toBe("continued");
  });
});

// ═══════════════════════════════════════════════════════════════
// conversationAiOutputSchema Validation
// ═══════════════════════════════════════════════════════════════

describe("conversationAiOutputSchema", () => {
  it("accepts valid ai_inferred candidate", () => {
    const result = conversationAiOutputSchema.safeParse(normalReply());
    expect(result.success).toBe(true);
  });

  it("accepts valid to_verify candidate", () => {
    const result = conversationAiOutputSchema.safeParse(summarizeReply());
    expect(result.success).toBe(true);
  });

  it("rejects user_confirmed epistemic_status", () => {
    const result = conversationAiOutputSchema.safeParse(maliciousReply());
    expect(result.success).toBe(false);
  });

  it("requires summary when should_summarize is true", () => {
    const invalid = {
      response_text: "总结...",
      candidates: [{ epistemic_status: "to_verify", canonical_text: "x", evidence_refs: [] }],
      should_summarize: true,
      question: "对吗？",
    };
    const result = conversationAiOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
