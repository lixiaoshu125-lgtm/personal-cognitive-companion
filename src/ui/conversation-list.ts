/**
 * Conversation List Component — Task 07
 *
 * Pure render functions for the Conversation list UI.
 * Reusable by DashboardView and ConversationView sidebars.
 *
 * Key constraints:
 *  - Pure functions: input props → HTML string
 *  - No Obsidian API dependencies
 *  - All user text HTML-escaped
 *  - No Weekly type imports
 */

import type { ConversationSummary } from "../conversation/composition-conversation";

// ═══════════════════════════════════════════════════════════════════
// HTML Escaping
// ═══════════════════════════════════════════════════════════════════

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ═══════════════════════════════════════════════════════════════════
// Status Helpers
// ═══════════════════════════════════════════════════════════════════

function statusLabel(status: string): string {
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

function statusClass(status: string): string {
  switch (status) {
    case "active":
      return "cc-badge--active";
    case "paused":
      return "cc-badge--warning";
    case "completed":
      return "cc-badge--success";
    case "awaiting_summary_confirmation":
      return "cc-badge--info";
    default:
      return "cc-badge--muted";
  }
}

// ═══════════════════════════════════════════════════════════════════
// Seed Type Labels
// ═══════════════════════════════════════════════════════════════════

function seedTypeLabel(type: ConversationSummary["seedType"]): string {
  switch (type) {
    case "free_question":
      return "自由提问";
    case "current_note":
      return "当前笔记";
    case "weekly_topic":
      return "本周主题";
  }
}

// ═══════════════════════════════════════════════════════════════════
// Render Functions
// ═══════════════════════════════════════════════════════════════════

export interface ConversationListProps {
  conversations: ConversationSummary[];
  activeId?: string;
}

/**
 * Render a single conversation item.
 */
export function renderConversationItem(
  summary: ConversationSummary,
  isActive: boolean,
): string {
  const activeClass = isActive ? " cc-conversation-list__item--active" : "";
  const typeLabel = seedTypeLabel(summary.seedType);
  const badgeClass = statusClass(summary.status);
  const label = statusLabel(summary.status);

  return [
    `<div class="cc-conversation-list__item${activeClass}" data-conversation-id="${escapeHtml(summary.id)}">`,
    `  <div class="cc-conversation-list__item-header">`,
    `    <span class="cc-conversation-list__item-title">${escapeHtml(summary.title)}</span>`,
    `    <span class="cc-badge ${badgeClass}">${escapeHtml(label)}</span>`,
    `  </div>`,
    `  <div class="cc-conversation-list__item-meta">`,
    `    <span class="cc-conversation-list__item-type">${escapeHtml(typeLabel)}</span>`,
    `    <span class="cc-conversation-list__item-turns">${summary.turnCount} 轮</span>`,
    `    <span class="cc-conversation-list__item-time">${escapeHtml(summary.updatedAt)}</span>`,
    `  </div>`,
    `</div>`,
  ].join("\n");
}

/**
 * Render the empty state when there are no conversations.
 */
export function renderEmptyState(): string {
  return [
    `<div class="cc-conversation-list__empty">`,
    `  <div class="cc-conversation-list__empty-icon">💬</div>`,
    `  <p class="cc-conversation-list__empty-text">暂无对话</p>`,
    `  <p class="cc-conversation-list__empty-hint">使用"自由提问"、"当前笔记"或"本周主题"开始一段对话</p>`,
    `</div>`,
  ].join("\n");
}

/**
 * Render the complete conversation list.
 */
export function renderConversationList(props: ConversationListProps): string {
  const { conversations, activeId } = props;

  if (conversations.length === 0) {
    return [
      `<div class="cc-conversation-list">`,
      `  ${renderEmptyState().replace(/\n/g, "\n  ")}`,
      `</div>`,
    ].join("\n");
  }

  const items = conversations.map((c) =>
    renderConversationItem(c, c.id === activeId),
  );

  return [
    `<div class="cc-conversation-list">`,
    ...items.map((item) => `  ${item.replace(/\n/g, "\n  ")}`),
    `</div>`,
  ].join("\n");
}
