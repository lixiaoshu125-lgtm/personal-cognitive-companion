/**
 * Conversation View — Pure Render Functions (Task 07)
 *
 * Pure functions for rendering Conversation messages, candidates,
 * confirmation banners, source references, and epistemic status badges.
 *
 * Also exports ConversationView — the Obsidian ItemView for conversation UI.
 *
 * Key constraints:
 *  - All user/AI text is HTML-escaped before output.
 *  - No Weekly type imports.
 *  - Error messages never contain API keys, body text, or absolute paths.
 */

import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { ConversationTurn } from "../conversation/model";
import type { AiCandidate } from "../conversation/engine";
import type { ConversationComposition } from "../conversation/composition-conversation";
import { classifyConversationError, sanitizeErrorMessage } from "../conversation/error-classifier";

// ═══════════════════════════════════════════════════════════════════
// HTML Escaping
// ═══════════════════════════════════════════════════════════════════

/**
 * Full HTML entity encoding for user/AI-generated text.
 * Prevents XSS by escaping <, >, &, ", '.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderReadableText(text: string): string {
  const normalized = text
    .replace(/\r\n?/gu, "\n")
    .trim()
    .replace(
      /[ \t]+(?=(?:\d{1,2}[.、](?!\d)|[一二三四五六七八九十]+、))/gu,
      "\n",
    );

  if (normalized.length === 0) return "";

  return normalized
    .split(/\n{2,}/gu)
    .map((paragraph) => {
      const trimmed = paragraph.trim();
      // Detect 【笔记标题】 blocks — wrap in styled container
      const noteRefMatch = trimmed.match(/^【(.+?)】\s*$/u);
      if (noteRefMatch) {
        const title = escapeHtml(noteRefMatch[1]!);
        return `<div class="cc-note-ref"><span class="cc-note-ref__icon">📄</span><span class="cc-note-ref__title">${title}</span></div>`;
      }
      const readable = escapeHtml(trimmed).replace(/\n/gu, "<br>");
      return `<p class="cc-readable-paragraph">${readable}</p>`;
    })
    .join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Status Labels & Colors
// ═══════════════════════════════════════════════════════════════════

/**
 * Map conversation status to Chinese display label.
 */
export function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return "进行中";
    case "paused":
      return "已暂停";
    case "completed":
      return "已完成";
    case "awaiting_summary_confirmation":
      return "待确认";
    default:
      return status;
  }
}

/**
 * Map conversation status to a CSS color value.
 */
export function statusColor(status: string): string {
  switch (status) {
    case "active":
      return "#4caf50";
    case "paused":
      return "#ff9800";
    case "completed":
      return "#9e9e9e";
    case "awaiting_summary_confirmation":
      return "#2196f3";
    default:
      return "#757575";
  }
}

// ═══════════════════════════════════════════════════════════════════
// Epistemic Status Badge
// ═══════════════════════════════════════════════════════════════════

const EPISTEMIC_COLORS: Record<string, string> = {
  user_confirmed: "#4caf50",
  ai_inferred: "#ff9800",
  to_verify: "#f44336",
  rejected: "#9e9e9e",
  superseded: "#795548",
};

const EPISTEMIC_LABELS: Record<string, string> = {
  user_confirmed: "已确认",
  ai_inferred: "AI 推断",
  to_verify: "待验证",
  rejected: "已否定",
  superseded: "已取代",
};

/**
 * Render an epistemic status badge as an inline HTML span.
 */
export function renderEpistemicStatusBadge(status: string): string {
  const color = EPISTEMIC_COLORS[status] ?? "#757575";
  const label = EPISTEMIC_LABELS[status] ?? status;
  return `<span class="cc-epistemic-badge" style="color:${color};border:1px solid ${color};padding:1px 6px;border-radius:3px;font-size:0.85em">${escapeHtml(label)}</span>`;
}

// ═══════════════════════════════════════════════════════════════════
// Source Reference
// ═══════════════════════════════════════════════════════════════════

export interface SourceRefData {
  source_id: string;
  source_type: string;
  epistemic_status: string;
  label: string;
}

/**
 * Render a reference source with epistemic status badge.
 */
export function renderSourceRef(ref: SourceRefData): string {
  const badge = renderEpistemicStatusBadge(ref.epistemic_status);
  return [
    `<span class="cc-source-ref" data-source-id="${escapeHtml(ref.source_id)}">`,
    `  <span class="cc-source-ref__type">${escapeHtml(ref.source_type)}</span>`,
    `  <span class="cc-source-ref__label">${escapeHtml(ref.label)}</span>`,
    `  ${badge}`,
    `</span>`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Candidate Chip
// ═══════════════════════════════════════════════════════════════════

/**
 * Render an AI candidate as a small chip/badge.
 * ai_inferred and to_verify get different visual treatments.
 */
export function renderCandidateChip(candidate: AiCandidate): string {
  const badge = renderEpistemicStatusBadge(candidate.epistemic_status);
  const statusClass =
    candidate.epistemic_status === "to_verify" ? "cc-candidate--to-verify" : "cc-candidate--ai-inferred";
  return [
    `<span class="cc-candidate ${statusClass}">`,
    `  <span class="cc-candidate__text">${escapeHtml(candidate.canonical_text)}</span>`,
    `  ${badge}`,
    `</span>`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Confirmation Banner
// ═══════════════════════════════════════════════════════════════════

/**
 * Render the summary confirmation banner with action buttons.
 * Shows summary text, candidates, and confirm/modify/reject/continue buttons.
 */
export function renderConfirmationBanner(
  summary: string,
  candidates: AiCandidate[],
): string {
  const lines: string[] = [
    `<section class="cc-confirmation-banner">`,
    `  <div class="cc-confirmation-banner__header">`,
    `    <span class="cc-confirmation-banner__icon">📋</span>`,
    `    <span class="cc-confirmation-banner__title">AI 总结确认</span>`,
    `  </div>`,
    `  <div class="cc-confirmation-banner__summary">`,
    `    ${renderReadableText(summary)}`,
    `  </div>`,
  ];

  if (candidates.length > 0) {
    lines.push(`  <div class="cc-confirmation-banner__candidates">`);
    for (const c of candidates) {
      lines.push(`    ${renderCandidateChip(c)}`);
    }
    lines.push(`  </div>`);
  }

  lines.push(
    `  <div class="cc-confirmation-banner__actions">`,
    `    <button class="cc-btn cc-btn--success" data-action="confirm">确认并保存</button>`,
    `    <button class="cc-btn cc-btn--secondary" data-action="continue-discuss">继续讨论</button>`,
    `  </div>`,
    `</section>`,
  );

  return lines.join("\n");
}

export function renderSavedConclusionReceipt(): string {
  return [
    `<section class="cc-confirmation-banner cc-saved-conclusion">`,
    `  <div class="cc-confirmation-banner__header">`,
    `    <span class="cc-confirmation-banner__icon">✅</span>`,
    `    <span class="cc-confirmation-banner__title">结论已保存</span>`,
    `  </div>`,
    `  <div class="cc-confirmation-banner__summary">`,
    `    已保存到插件内部认知模型，后续相关对话会自动引用。`,
    `  </div>`,
    `</section>`,
  ].join("\n");
}

export function confirmationOutcomeMessage(
  wikiConclution: string | null,
): { readonly kind: "success" | "info"; readonly text: string } {
  if (wikiConclution) {
    return {
      kind: "success",
      text: `结论已确认，将沉淀为 Wiki 页面`,
    };
  }
  return { kind: "info", text: "对话已完成" };
}

// ═══════════════════════════════════════════════════════════════════
// Conversation Message
// ═══════════════════════════════════════════════════════════════════

/**
 * Render a single conversation turn as HTML.
 * Handles user, assistant, and system roles with appropriate styling.
 */
export function renderConversationMessage(turn: ConversationTurn): string {
  const roleClass = `cc-msg--${turn.role}`;
  const roleLabel =
    turn.role === "user" ? "你" : turn.role === "assistant" ? "AI" : "系统";

  return [
    `<div class="cc-msg ${roleClass}">`,
    `  <div class="cc-msg__header">`,
    `    <span class="cc-msg__role-label">${escapeHtml(roleLabel)}</span>`,
    `    <span class="cc-msg__time">${escapeHtml(turn.timestamp)}</span>`,
    `  </div>`,
    `  <div class="cc-msg__body">${renderReadableText(turn.text)}</div>`,
    `</div>`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// ConversationView — Obsidian ItemView
// ═══════════════════════════════════════════════════════════════════

export const CONVERSATION_VIEW_TYPE = "cog-comp-conversation-view";

/**
 * Obsidian ItemView for the Conversation-first dialogue.
 *
 * UI layer boundary:
 * - Reads all state from ConversationComposition (never owns domain facts).
 * - Saves only presentation state (loading flag, selected conversation ID).
 * - Delegates all business logic to composition methods.
 * - Input area has duplicate-submit protection (loading flag).
 */
export class ConversationView extends ItemView {
  private composition: ConversationComposition;
  private _currentConversationId: string | null = null;

  /** Public getter for entry-point coordination (main.ts). */
  get currentConversationId(): string | null {
    return this._currentConversationId;
  }
  isLoading = false;

  /** Called from main.ts before auto-sending the first message. */
  setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.refresh();
  }

  constructor(leaf: WorkspaceLeaf, composition: ConversationComposition) {
    super(leaf);
    this.composition = composition;
  }

  getViewType(): string {
    return CONVERSATION_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "认知对话";
  }

  getIcon(): string {
    return "message-square";
  }

  async setConversation(id: string): Promise<void> {
    this._currentConversationId = id;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.contentEl.empty();

    if (!this._currentConversationId) {
      this.contentEl.innerHTML = `<div class="cc-conversation"><div class="cc-conversation__empty">选择或创建一个对话开始</div></div>`;
      return;
    }

    const conv = await this.composition.getConversation(this._currentConversationId);
    if (!conv) {
      this.contentEl.innerHTML = `<div class="cc-conversation"><div class="cc-conversation__empty">对话未找到</div></div>`;
      return;
    }

    const messagesHtml = conv.turns.map((t) => renderConversationMessage(t)).join("\n");

    // Thinking indicator — shown while waiting for AI response
    const thinkingHtml = this.isLoading
      ? `<div class="cc-thinking"><span class="cc-thinking__dot"></span> AI 思考中...</div>`
      : "";

    let inputHtml: string;
    if (conv.status === "awaiting_summary_confirmation") {
      inputHtml = renderConfirmationBanner("请确认以上总结", []);
    } else if (conv.status === "completed") {
      const receipt = conv.end_reason === "confirmed_results"
        ? renderSavedConclusionReceipt()
        : "";
      inputHtml = `${receipt}<section class="cc-dialogue__input-area"><button class="cc-btn cc-btn--primary" id="cc-rediscuss-btn">重新讨论此话题</button></section>`;
    } else if (conv.status === "paused") {
      inputHtml = `<section class="cc-dialogue__input-area"><button class="cc-btn cc-btn--success" id="cc-resume-btn">恢复对话</button></section>`;
    } else {
      const disabled = this.isLoading ? "disabled" : "";
      inputHtml = [
        `<section class="cc-dialogue__input-area">`,
        `  <textarea class="cc-dialogue__input" id="cc-input" placeholder="输入你的回答..." rows="2" ${disabled}></textarea>`,
        `  <div class="cc-dialogue__input-actions">`,
        `    <button class="cc-btn cc-btn--primary" id="cc-send-btn" ${disabled}>发送</button>`,
        `    <button class="cc-btn cc-btn--secondary" id="cc-pause-btn">暂停</button>`,
        `    <button class="cc-btn cc-btn--accent" id="cc-conclude-btn">生成结论</button>`,
        `    <button class="cc-btn cc-btn--warning" id="cc-end-btn">无结论结束</button>`,
        `  </div>`,
        `</section>`,
      ].join("\n");
    }

    const statusBadge = statusLabel(conv.status);

    // Derive a display title from the conversation seed
    let displayTitle = "对话";
    if (conv.seed.kind === "free_question") {
      displayTitle = conv.seed.question.length > 50
        ? conv.seed.question.slice(0, 47) + "..."
        : conv.seed.question;
    } else if (conv.seed.kind === "current_note") {
      displayTitle = "📄 " + (conv.seed.note_path?.split("/").pop() ?? conv.seed.note_path ?? "当前笔记");
    } else if (conv.seed.kind === "weekly_topic") {
      displayTitle = "📌 " + conv.seed.topic_title;
    }

    const html = [
      `<div class="cc-conversation">`,
      `  <header class="cc-conversation__header">`,
      `    <div class="cc-conversation__title">${escapeHtml(displayTitle)}</div>`,
      `    <div class="cc-conversation__meta">`,
      `      <span class="cc-badge">${escapeHtml(statusBadge)}</span>`,
      `      <span>${conv.turns.length} 轮对话</span>`,
      `    </div>`,
      `  </header>`,
      `  <div class="cc-conversation__messages">`,
      `    ${messagesHtml}`,
      `    ${thinkingHtml}`,
      `  </div>`,
      `  ${inputHtml}`,
      `</div>`,
    ].join("\n");

    this.contentEl.innerHTML = html;
    this.bindEvents();

    // Auto-scroll to the latest message
    requestAnimationFrame(() => {
      const container = this.contentEl.querySelector(".cc-conversation");
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });

    // Auto-focus the input (unless loading)
    if (!this.isLoading) {
      const textarea = this.contentEl.querySelector<HTMLTextAreaElement>("#cc-input");
      textarea?.focus();
    }
  }

  private bindEvents(): void {
    const sendBtn = this.contentEl.querySelector<HTMLButtonElement>("#cc-send-btn");
    if (sendBtn) {
      sendBtn.addEventListener("click", () => {
        this.doSend();
      });
    }

    // Enter key to send (Shift+Enter for newline)
    const textarea = this.contentEl.querySelector<HTMLTextAreaElement>("#cc-input");
    if (textarea) {
      textarea.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.doSend();
        }
      });
    }

    const pauseBtn = this.contentEl.querySelector<HTMLButtonElement>("#cc-pause-btn");
    if (pauseBtn) {
      pauseBtn.addEventListener("click", () => { this.handlePause(); });
    }

    const resumeBtn = this.contentEl.querySelector<HTMLButtonElement>("#cc-resume-btn");
    if (resumeBtn) {
      resumeBtn.addEventListener("click", () => { this.handleResume(); });
    }

    const rediscussBtn = this.contentEl.querySelector<HTMLButtonElement>("#cc-rediscuss-btn");
    if (rediscussBtn) {
      rediscussBtn.addEventListener("click", () => { this.handleRediscuss(); });
    }

    const concludeBtn = this.contentEl.querySelector<HTMLButtonElement>("#cc-conclude-btn");
    if (concludeBtn) {
      concludeBtn.addEventListener("click", () => { this.handleConclude(); });
    }

    const endBtn = this.contentEl.querySelector<HTMLButtonElement>("#cc-end-btn");
    if (endBtn) {
      endBtn.addEventListener("click", () => { this.handleEnd(); });
    }

    const retryBtn = this.contentEl.querySelector<HTMLButtonElement>("#cc-retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => { this.handleRetry(); });
    }

    const confirmBtns = this.contentEl.querySelectorAll<HTMLButtonElement>("[data-action]");
    for (const btn of confirmBtns) {
      const action = btn.getAttribute("data-action");
      if (action) {
        btn.addEventListener("click", () => { this.handleConfirmationAction(action); });
      }
    }
  }

  private doSend(): void {
    const textarea = this.contentEl.querySelector<HTMLTextAreaElement>("#cc-input");
    if (textarea && textarea.value.trim() !== "" && !this.isLoading) {
      const text = textarea.value.trim();
      textarea.value = "";
      this.handleSend(text);
    }
  }

  private async handleSend(text: string): Promise<void> {
    if (this.isLoading || !this._currentConversationId) return;
    this.setLoading(true);  // Show thinking indicator immediately
    try {
      await this.composition.sendMessage(this._currentConversationId, text);
    } catch (err) {
      const classified = classifyConversationError(err);
      new Notice(`❌ 发送失败：${classified.message}`, 5000);
      console.error("ConversationView: sendMessage failed", sanitizeErrorMessage(err instanceof Error ? err.message : String(err)));
    } finally {
      this.isLoading = false;
    }
    // Refresh AFTER isLoading is reset — otherwise the re-rendered
    // textarea and button are permanently disabled in the DOM.
    await this.refresh();
  }

  private async handlePause(): Promise<void> {
    if (!this._currentConversationId) return;
    try {
      await this.composition.pauseConversation(this._currentConversationId);
      await this.refresh();
    } catch (err) {
      const classified = classifyConversationError(err);
      new Notice(`❌ 暂停失败：${classified.message}`, 5000);
      console.error("ConversationView: pause failed", err);
    }
  }

  private async handleResume(): Promise<void> {
    if (!this._currentConversationId) return;
    try {
      await this.composition.resumeConversation(this._currentConversationId);
      await this.refresh();
    } catch (err) {
      const classified = classifyConversationError(err);
      new Notice(`❌ 恢复失败：${classified.message}`, 5000);
      console.error("ConversationView: resume failed", err);
    }
  }

  private async handleRediscuss(): Promise<void> {
    if (!this._currentConversationId) return;
    try {
      await this.composition.reopenConversation(this._currentConversationId);
      new Notice("对话已重新打开，可以继续讨论了", 3000);
      await this.refresh();
    } catch (err) {
      const classified = classifyConversationError(err);
      new Notice(`❌ 重新讨论失败：${classified.message}`, 5000);
      console.error("ConversationView: rediscuss failed", err);
    }
  }

  private async handleEnd(): Promise<void> {
    if (!this._currentConversationId) return;
    try {
      await this.composition.endWithoutConclusion(this._currentConversationId);
      await this.refresh();
    } catch (err) {
      const classified = classifyConversationError(err);
      new Notice(`❌ 结束失败：${classified.message}`, 5000);
      console.error("ConversationView: end failed", err);
    }
  }

  private async handleConclude(): Promise<void> {
    if (!this._currentConversationId || this.isLoading) return;
    this.setLoading(true);
    try {
      await this.composition.concludeConversation(this._currentConversationId);
      new Notice("📋 结论已生成，请在下方确认、修改或否定", 5000);
    } catch (err) {
      const classified = classifyConversationError(err);
      new Notice(`❌ 生成结论失败：${classified.message}`, 5000);
    } finally {
      this.isLoading = false;
    }
    await this.refresh();
  }

  private async handleRetry(): Promise<void> {
    if (!this._currentConversationId || this.isLoading) return;
    this.setLoading(true);
    try {
      await this.composition.retryAfterFailure(this._currentConversationId);
    } catch (err) {
      const classified = classifyConversationError(err);
      new Notice(`❌ 重试失败：${classified.message}`, 5000);
    } finally {
      this.isLoading = false;
    }
    await this.refresh();
  }

  private async handleConfirmationAction(action: string): Promise<void> {
    if (!this._currentConversationId) return;
    try {
      const result = await this.composition.handleConfirmation(this._currentConversationId, action);
      const outcome = confirmationOutcomeMessage(result.wikiConclution);
      new Notice(`${outcome.kind === "success" ? "✅" : "ℹ️"} ${outcome.text}`, 5000);
      await this.refresh();
    } catch (err) {
      const classified = classifyConversationError(err);
      new Notice(`❌ 确认操作失败：${classified.message}`, 5000);
      console.error("ConversationView: confirmation failed", err);
    }
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async onClose(): Promise<void> {
    // No cleanup needed
  }
}
