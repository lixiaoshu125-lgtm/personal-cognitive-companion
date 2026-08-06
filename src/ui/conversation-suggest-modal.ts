/**
 * ConversationSuggestModal — presents existing conversations
 * for the user to resume, replacing the old dashboard-only list
 * that had no click handlers.
 *
 * S1 Vault Acceptance: "继续对话" entry point.
 */

import { App, SuggestModal } from "obsidian";
import type { ConversationSummary } from "../conversation/composition-conversation";

export class ConversationSuggestModal extends SuggestModal<ConversationSummary> {
  constructor(
    app: App,
    private readonly conversations: readonly ConversationSummary[],
    private readonly onChoose: (conv: ConversationSummary) => void,
  ) {
    super(app);
    this.setPlaceholder("输入关键词筛选对话…");
  }

  getSuggestions(query: string): ConversationSummary[] {
    const q = query.toLowerCase().trim();
    if (!q) return [...this.conversations];
    return this.conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.seedType.toLowerCase().includes(q),
    );
  }

  renderSuggestion(conv: ConversationSummary, el: HTMLElement): void {
    const statusLabel =
      conv.status === "active" ? "进行中"
      : conv.status === "paused" ? "已暂停"
      : conv.status === "completed" ? "已完成"
      : "待确认";
    const seedLabel =
      conv.seedType === "free_question" ? "自由提问"
      : conv.seedType === "current_note" ? "当前笔记"
      : "本周主题";
    el.createEl("div", { text: conv.title, cls: "pcc-suggest-title" });
    el.createEl("small", {
      text: `${seedLabel} · ${conv.turnCount}轮 · ${statusLabel}`,
      cls: "pcc-suggest-desc",
    });
  }

  onChooseSuggestion(conv: ConversationSummary): void {
    this.onChoose(conv);
  }
}
