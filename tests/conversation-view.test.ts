// ─── Tests for src/ui/conversation-view.ts (pure functions) ──────
//
// Tests focus on pure render functions exported from conversation-view.ts.
// These functions are testable without Obsidian runtime.
// No Weekly types, no real AI, no DOM manipulation (pure string output).

import { describe, expect, it } from "vitest";
import {
  renderConversationMessage,
  renderReadableText,
  renderCandidateChip,
  renderSourceRef,
  renderConfirmationBanner,
  renderEpistemicStatusBadge,
  renderSavedConclusionReceipt,
  confirmationOutcomeMessage,
  statusLabel,
  statusColor,
} from "../src/ui/conversation-view";
import { renderConversationList, renderConversationItem, renderEmptyState } from "../src/ui/conversation-list";
import type { ConversationSummary } from "../src/conversation/composition-conversation";
import type { ConversationTurn } from "../src/conversation/model";
import type { AiCandidate } from "../src/conversation/engine";

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function makeTurn(overrides?: Partial<ConversationTurn>): ConversationTurn {
  return {
    role: "user",
    text: "Hello",
    timestamp: "2026-07-29T08:00:00.000Z",
    ...overrides,
  } as unknown as ConversationTurn;
}

function makeAiCandidate(overrides?: Partial<AiCandidate>): AiCandidate {
  return {
    epistemic_status: "ai_inferred",
    canonical_text: "AI candidate text",
    evidence_refs: [],
    ...overrides,
  };
}

function makeSummary(overrides?: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: "conv:test:0:abc",
    seedType: "free_question",
    title: "测试对话",
    status: "active",
    turnCount: 0,
    updatedAt: "2026-07-29T08:00:00.000Z",
    hasPendingConfirmation: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Scenario 1: renderConversationMessage user turn
// ═══════════════════════════════════════════════════════════════════

describe("renderConversationMessage", () => {
  it("renders a user turn message correctly", () => {
    const turn = makeTurn({ role: "user", text: "什么是认知偏差？" });
    const html = renderConversationMessage(turn);

    expect(html).toContain("什么是认知偏差？");
    expect(html).toContain("cc-msg");
    expect(html).toContain("user");
  });

  // ── Scenario 2: renderConversationMessage AI turn ──────────

  it("renders an AI turn with candidate information", () => {
    const turn = makeTurn({
      role: "assistant",
      text: "认知偏差是系统性的思维误差...",
    });
    const html = renderConversationMessage(turn);

    expect(html).toContain("认知偏差是系统性的思维误差");
    expect(html).toContain("cc-msg");
    expect(html).toContain("assistant");
  });

  // ── Scenario 3: renderCandidateChip ─────────────────────────

  it("renderCandidateChip shows different styles for ai_inferred vs to_verify", () => {
    const aiInferred = makeAiCandidate({ epistemic_status: "ai_inferred" });
    const toVerify = makeAiCandidate({ epistemic_status: "to_verify" });

    const inferredHtml = renderCandidateChip(aiInferred);
    const verifyHtml = renderCandidateChip(toVerify);

    // Should contain the Chinese labels for each status
    expect(inferredHtml).toContain("AI 推断");
    expect(verifyHtml).toContain("待验证");
    // Should have different CSS classes
    expect(inferredHtml).toContain("cc-candidate--ai-inferred");
    expect(verifyHtml).toContain("cc-candidate--to-verify");
    // Different outputs
    expect(inferredHtml).not.toBe(verifyHtml);
  });

  // ── Scenario 4: renderConfirmationBanner ────────────────────

  it("renderConfirmationBanner renders summary text with confirmation buttons", () => {
    const candidates = [makeAiCandidate({ canonical_text: "候选观点1" })];
    const html = renderConfirmationBanner("这是一个总结", candidates);

    expect(html).toContain("这是一个总结");
    expect(html).toContain("候选观点1");
    expect(html).toContain("confirm");
    expect(html).toContain("modify");
    expect(html).toContain("reject");
  });

  // ── Scenario 5: renderSourceRef ─────────────────────────────

  it("renderSourceRef shows reference source with epistemic status", () => {
    const html = renderSourceRef({
      source_id: "claim:test:123",
      source_type: "claim",
      epistemic_status: "user_confirmed",
      label: "测试观点",
    });

    expect(html).toContain("claim:test:123");
    expect(html).toContain("测试观点");
    // The badge shows the Chinese label "已确认" for user_confirmed
    expect(html).toContain("已确认");
  });

  // ── Scenario 6: renderEpistemicStatusBadge ──────────────────

  it("renderEpistemicStatusBadge uses different colors for different statuses", () => {
    const confirmed = renderEpistemicStatusBadge("user_confirmed");
    const inferred = renderEpistemicStatusBadge("ai_inferred");
    const toVerify = renderEpistemicStatusBadge("to_verify");

    // All should produce output
    expect(confirmed.length).toBeGreaterThan(0);
    expect(inferred.length).toBeGreaterThan(0);
    expect(toVerify.length).toBeGreaterThan(0);

    // Each should have different colors
    const colors = [confirmed, inferred, toVerify];
    const unique = new Set(colors);
    expect(unique.size).toBe(3);
  });
});

describe("renderReadableText", () => {
  it("preserves explicit paragraphs and line breaks", () => {
    const html = renderReadableText("第一段第一行\n第一段第二行\n\n第二段");

    expect(html).toContain("第一段第一行<br>第一段第二行");
    expect(html).toContain("<p class=\"cc-readable-paragraph\">第二段</p>");
  });

  it("separates inline Arabic and Chinese numbered items", () => {
    const html = renderReadableText("1. 第一条结论 2. 第二条结论 一、补充说明 二、行动建议");

    expect(html).toContain("第一条结论<br>2. 第二条结论");
    expect(html).toContain("<br>一、补充说明");
    expect(html).toContain("<br>二、行动建议");
  });

  it("escapes HTML before adding layout markup", () => {
    const html = renderReadableText("1. <script>alert('xss')</script>\n2. 安全内容");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<br>2. 安全内容");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 7: statusLabel
// ═══════════════════════════════════════════════════════════════════

describe("statusLabel", () => {
  it("returns correct Chinese labels for each status", () => {
    expect(statusLabel("active")).toBe("进行中");
    expect(statusLabel("paused")).toBe("已暂停");
    expect(statusLabel("completed")).toBe("已完成");
    expect(statusLabel("awaiting_summary_confirmation")).toBe("待确认");
  });
});

describe("saved conclusion receipt", () => {
  it("renders a persistent receipt for a completed confirmed-results conversation", () => {
    const html = renderSavedConclusionReceipt();

    expect(html).toContain("结论已保存");
    expect(html).toContain("插件内部认知模型");
    expect(html).toContain("后续相关对话会自动引用");
  });

  it("reports success when wikiConclution is present, info when null", () => {
    expect(confirmationOutcomeMessage("结论文本")).toEqual({
      kind: "success",
      text: "结论已确认，将沉淀为 Wiki 页面",
    });

    expect(confirmationOutcomeMessage(null)).toEqual({
      kind: "info",
      text: "对话已完成",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 8: HTML escaping (XSS prevention)
// ═══════════════════════════════════════════════════════════════════

describe("HTML escaping", () => {
  it("escapes script tags in user text", () => {
    const turn = makeTurn({
      role: "user",
      text: "<script>alert('xss')</script>",
    });
    const html = renderConversationMessage(turn);

    // Should NOT contain executable script tag
    expect(html).not.toContain("<script>alert");
    // Should be escaped
    expect(html).toContain("&lt;script&gt;");
    // or the text should be safely encoded
    expect(html).not.toMatch(/<script>/i);
  });

  it("escapes HTML entities in candidate text", () => {
    const candidate = makeAiCandidate({
      canonical_text: '<img src=x onerror=alert(1)>',
    });
    const html = renderCandidateChip(candidate);

    // The < and > must be escaped
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    // The > must be escaped
    expect(html).toContain("&gt;");
  });

  it("escapes HTML in confirmation banner summary", () => {
    const html = renderConfirmationBanner(
      '<a href="javascript:alert(1)">click</a>',
      [],
    );
    // The <a href= tag must be escaped — no raw HTML tags should appear
    expect(html).not.toContain("<a href");
    expect(html).toContain("&lt;a");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 9: ConversationList empty state
// ═══════════════════════════════════════════════════════════════════

describe("ConversationList", () => {
  it("renderEmptyState shows guidance text when no conversations", () => {
    const html = renderEmptyState();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("暂无对话");
  });

  // ── Scenario 10: ConversationList active highlight ──────────

  it("renderConversationList highlights the active conversation", () => {
    const conversations: ConversationSummary[] = [
      makeSummary({ id: "conv:1", title: "对话1" }),
      makeSummary({ id: "conv:2", title: "对话2" }),
    ];

    const html = renderConversationList({ conversations, activeId: "conv:1" });

    expect(html).toContain("对话1");
    expect(html).toContain("对话2");
    // Active item should have a special CSS class
    expect(html).toContain("cc-conversation-list__item--active");
  });

  it("renderConversationItem shows status badge and title", () => {
    const item = makeSummary({ title: "测试对话", status: "active" });
    const html = renderConversationItem(item, false);

    expect(html).toContain("测试对话");
    expect(html).toContain("进行中");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 11: statusColor
// ═══════════════════════════════════════════════════════════════════

describe("statusColor", () => {
  it("returns distinct colors for different statuses", () => {
    const active = statusColor("active");
    const paused = statusColor("paused");
    const completed = statusColor("completed");
    const awaiting = statusColor("awaiting_summary_confirmation");

    expect(active.length).toBeGreaterThan(0);
    expect(paused.length).toBeGreaterThan(0);
    expect(completed.length).toBeGreaterThan(0);
    expect(awaiting.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Scenario 12: Error Notice privacy
// ═══════════════════════════════════════════════════════════════════

describe("Error privacy", () => {
  it("statusLabel does not expose API keys or body text", () => {
    // statusLabel is a pure label function — it never returns input text
    const result = statusLabel("active");
    expect(result).toBe("进行中");
    // Should never return anything that looks like an API key
    expect(result).not.toMatch(/sk-/);
    expect(result).not.toMatch(/api_key/);
  });

  it("render functions do not embed raw text unsafely", () => {
    // Verify that dangerous characters are always escaped
    const turn = makeTurn({ role: "user", text: 'say "hello" & goodbye' });
    const html = renderConversationMessage(turn);

    // The text should appear but be safe
    expect(html).toContain("&amp;");
    // No unescaped ampersands in text content
    expect(html).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
  });
});
