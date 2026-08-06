// ─── Dashboard UI ──────────────────────────────────────────────
//
// Part 1: buildDashboardData — pure logic extracting DashboardData from domain types
// Part 2: render* functions — pure HTML generators (return HTML strings)
// Part 3: DashboardView — Obsidian ItemView (thin UI layer)
//
// Security: all user-originated text is escaped via escapeMarkdownText.
// No API keys or absolute file paths appear in HTML output.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import type {
  DashboardData,
  WikiPageSummary,
  CompositionRoot,
} from "../composition";
import type { WeeklySnapshot } from "../domain/types";
import { escapeMarkdownText } from "../storage/markdown";

// ─── Part 1: buildDashboardData ───────────────────────────────

export interface BuildDashboardDataInput {
  readonly snapshot: WeeklySnapshot | null;
  readonly previousCompletedNoteIds: readonly string[] | undefined;
  readonly pendingTopicCount?: number;
  readonly newsConfigured?: boolean;
  readonly wikiPages?: readonly WikiPageSummary[];
}

/**
 * Build DashboardData from domain state fragments.
 * Pure function — no side effects, no Obsidian API calls.
 */
export function buildDashboardData(
  input: BuildDashboardDataInput
): DashboardData {
  // snapshotStatus
  const snapshotStatus: DashboardData["snapshotStatus"] =
    input.snapshot === null
      ? "no_snapshot"
      : input.snapshot.status;

  // newNoteCount and isFirstScan
  const hasSnapshot = input.snapshot !== null;
  const hasPreviousIds =
    input.previousCompletedNoteIds !== undefined &&
    input.previousCompletedNoteIds.length > 0;

  let newNoteCount = 0;
  let isFirstScan = false;

  if (hasSnapshot) {
    if (!hasPreviousIds) {
      newNoteCount = input.snapshot!.note_ids.length;
      isFirstScan = true;
    } else {
      const prevSet = new Set(input.previousCompletedNoteIds);
      newNoteCount = input.snapshot!.note_ids.filter(
        (id) => !prevSet.has(id)
      ).length;
      isFirstScan = false;
    }
  }

  return {
    snapshotStatus,
    newNoteCount,
    isFirstScan,
    pendingTopicCount: input.pendingTopicCount ?? 0,
    newsConfigured: input.newsConfigured ?? false,
    wikiPages: input.wikiPages ?? [],
  };
}

// ─── Part 2: HTML Renderers ───────────────────────────────────

function escapeHtml(text: string): string {
  return escapeMarkdownText(text);
}

/**
 * Map snapshot status to a display label and CSS class modifier.
 */
function statusBadge(status: DashboardData["snapshotStatus"]): {
  label: string;
  classMod: string;
} {
  switch (status) {
    case "no_snapshot":
      return { label: "无快照", classMod: "cc-badge--muted" };
    case "frozen":
      return { label: "已冻结", classMod: "cc-badge--info" };
    case "active":
      return { label: "进行中", classMod: "cc-badge--active" };
    case "paused":
      return { label: "已暂停", classMod: "cc-badge--warning" };
    case "completed":
      return { label: "已完成", classMod: "cc-badge--success" };
  }
}

/**
 * Render the top status bar: current week status badge + new note count + news status.
 */
export function renderStatusBar(data: DashboardData): string {
  const badge = statusBadge(data.snapshotStatus);
  const noteLabel = data.isFirstScan
    ? `${data.newNoteCount} 条笔记（首次扫描）`
    : `本周新增 ${data.newNoteCount} 条笔记`;
  const newsLabel = data.newsConfigured
    ? `<span class="cc-badge cc-badge--info">热点已启用</span>`
    : "";

  return [
    `<section class="cc-dashboard__status-bar">`,
    `  <span class="cc-badge ${badge.classMod}">${escapeHtml(badge.label)}</span>`,
    `  <span class="cc-dashboard__note-count">${escapeHtml(noteLabel)}</span>`,
    newsLabel ? `  ${newsLabel}` : "",
    `</section>`,
  ].filter(Boolean).join("\n");
}

/**
 * Render the core action area.
 */
export function renderActionArea(data: DashboardData): string {
  const topicLabel = "待讨论主题";

  return [
    `<section class="cc-dashboard__actions" aria-label="常用操作">`,
    `  <h2 class="cc-dashboard__section-title">开始思考</h2>`,
    `  <div class="cc-dashboard__action-grid">`,
    `    <button class="cc-dashboard__action-btn cc-dashboard__action-btn--primary" data-action="free-question" type="button">`,
    `      <span class="cc-dashboard__action-title">自由讨论</span>`,
    `      <span class="cc-dashboard__action-description">从一个问题或想法开始</span>`,
    `    </button>`,
    `    <button class="cc-dashboard__action-btn" data-action="current-note" type="button">`,
    `      <span class="cc-dashboard__action-title">讨论当前笔记</span>`,
    `      <span class="cc-dashboard__action-description">结合正在阅读的 Markdown 笔记</span>`,
    `    </button>`,
    `    <button class="cc-dashboard__action-btn" data-action="weekly-review" type="button">`,
    `      <span class="cc-dashboard__action-title">${topicLabel}</span>`,
    `      <span class="cc-dashboard__action-description">查看已准备的讨论主题或生成新主题</span>`,
    `    </button>`,
    `    <button class="cc-dashboard__action-btn" data-action="continue-conversation" type="button">`,
    `      <span class="cc-dashboard__action-title">继续历史对话</span>`,
    `      <span class="cc-dashboard__action-description">恢复已保存的任意对话</span>`,
    `    </button>`,
    `    <button class="cc-dashboard__action-btn cc-dashboard__action-btn--secondary" data-action="refresh-topics" type="button">`,
    `      <span class="cc-dashboard__action-title">刷新话题</span>`,
    `      <span class="cc-dashboard__action-description">重新扫描笔记 + 拉取新闻，生成新主题</span>`,
    `    </button>`,
    `  </div>`,
    `</section>`,
  ].join("\n");
}

export type DashboardActionId =
  | "free-question"
  | "current-note"
  | "weekly-review"
  | "continue-conversation"
  | "refresh-topics";

export interface DashboardActions {
  startFreeQuestion(): void | Promise<void>;
  startCurrentNote(): void | Promise<void>;
  startOrContinueWeeklyReview(): void | Promise<void>;
  continueConversation(): void | Promise<void>;
  refreshTopics(): void | Promise<void>;
}

export async function dispatchDashboardAction(
  action: DashboardActionId,
  actions: DashboardActions,
): Promise<void> {
  switch (action) {
    case "free-question":
      await actions.startFreeQuestion();
      return;
    case "current-note":
      await actions.startCurrentNote();
      return;
    case "weekly-review":
      await actions.startOrContinueWeeklyReview();
      return;
    case "continue-conversation":
      await actions.continueConversation();
      return;
    case "refresh-topics":
      await actions.refreshTopics();
      return;
  }
}

/**
 * Render the recent Wiki pages section.
 */
export function renderWikiList(data: DashboardData): string {
  const lines: string[] = [
    `<section class="cc-dashboard__wiki">`,
    `  <h2 class="cc-dashboard__section-title">最近生成的 Wiki</h2>`,
  ];

  if (data.wikiPages.length === 0) {
    lines.push(
      `  <p class="cc-dashboard__empty-hint">暂无 Wiki 页面。完成一轮深度对话后，AI 会自动沉淀结论为 Wiki。</p>`
    );
  } else {
    lines.push(`  <div class="cc-dashboard__wiki-list">`);
    for (const page of data.wikiPages) {
      const dateLabel = page.created
        ? escapeHtml(page.created.split("T")[0] ?? page.created)
        : "";
      lines.push(
        `    <div class="cc-dashboard__wiki-item">`,
        `      <span class="cc-dashboard__wiki-title">${escapeHtml(page.title)}</span>`,
        dateLabel
          ? `      <span class="cc-dashboard__wiki-date">${dateLabel}</span>`
          : "",
        `    </div>`
      );
    }
    lines.push(`  </div>`);
  }

  lines.push(`</section>`);
  return lines.join("\n");
}

/**
 * Render the footer: plugin version + data freshness.
 */
export function renderFooter(_data: DashboardData): string {
  const now = new Date().toISOString();
  return [
    `<footer class="cc-dashboard__footer">`,
    `  <span class="cc-dashboard__version">深度对话</span>`,

    `  <span class="cc-dashboard__updated">数据更新: ${escapeHtml(now)}</span>`,
    `</footer>`,
  ].join("\n");
}

/**
 * Render the complete Dashboard HTML from DashboardData.
 */
export function renderDashboardHTML(data: DashboardData): string {
  const sections: string[] = [];

  // Status bar (always visible)
  sections.push(renderStatusBar(data));

  // Action area (always visible, highest priority)
  sections.push(renderActionArea(data));

  // Wiki list
  sections.push(renderWikiList(data));

  // Footer (always visible)
  sections.push(renderFooter(data));

  // Wrap in a root container
  return [
    `<div class="cc-dashboard">`,
    ...sections.map((s) => `  ${s.replace(/\n/g, "\n  ")}`),
    `</div>`,
  ].join("\n");
}

// ─── Part 2b: Conversation-First Dashboard (Task 07) ────────────

export interface ConversationDashboardData {
  conversations: ConversationSummary[];
  activeGoals: ActiveGoalSummary[];
  pendingValidations: PendingFeedbackSummary[];
  vaultReady: boolean;
}

export interface ConversationSummary {
  id: string;
  seedType: "free_question" | "current_note" | "weekly_topic";
  title: string;
  status: string;
  turnCount: number;
  updatedAt: string;
  hasPendingConfirmation: boolean;
}

export interface ActiveGoalSummary {
  goal_id: string;
  text: string;
  horizon: string;
  status: string;
}

export interface PendingFeedbackSummary {
  experiment_id: string;
  action: string;
  status: string;
}

/**
 * Render a Conversation-first dashboard HTML.
 */
export function renderConversationDashboard(data: ConversationDashboardData): string {
  const lines: string[] = [
    `<div class="cc-dashboard cc-dashboard--conversation">`,
  ];

  // ── Vault status ──────────────────────────────────────────
  lines.push(
    `  <section class="cc-dashboard__status-bar">`,
    `    <span class="cc-badge ${data.vaultReady ? 'cc-badge--active' : 'cc-badge--warning'}">${data.vaultReady ? 'Vault 就绪' : 'Vault 未就绪'}</span>`,
    `    <span class="cc-dashboard__stat">${data.conversations.length} 个对话</span>`,
    `  </section>`,
  );

  // ── Conversation list ─────────────────────────────────────
  lines.push(`  <section class="cc-dashboard__conversations">`);
  lines.push(`    <h2 class="cc-dashboard__section-title">对话列表</h2>`);

  if (data.conversations.length === 0) {
    lines.push(`    <p class="cc-dashboard__empty-hint">暂无对话，使用命令面板开始一段对话</p>`);
  } else {
    lines.push(`    <div class="cc-conversation-list">`);
    for (const conv of data.conversations) {
      const statusClass = conv.status === "active" ? "cc-badge--active"
        : conv.status === "paused" ? "cc-badge--warning"
        : conv.status === "completed" ? "cc-badge--success"
        : "cc-badge--info";
      const statusLabel = conv.status === "active" ? "进行中"
        : conv.status === "paused" ? "已暂停"
        : conv.status === "completed" ? "已完成"
        : "待确认";
      const seedLabel = conv.seedType === "free_question" ? "自由提问"
        : conv.seedType === "current_note" ? "当前笔记"
        : "本周主题";

      lines.push(
        `      <div class="cc-conversation-list__item" data-conversation-id="${escapeHtml(conv.id)}">`,
        `        <div class="cc-conversation-list__item-header">`,
        `          <span class="cc-conversation-list__item-title">${escapeHtml(conv.title)}</span>`,
        `          <span class="cc-badge ${statusClass}">${escapeHtml(statusLabel)}</span>`,
        `        </div>`,
        `        <div class="cc-conversation-list__item-meta">`,
        `          <span>${escapeHtml(seedLabel)}</span>`,
        `          <span>${conv.turnCount} 轮</span>`,
        `          <span>${escapeHtml(conv.updatedAt)}</span>`,
        `        </div>`,
        `      </div>`,
      );
    }
    lines.push(`    </div>`);
  }
  lines.push(`  </section>`);

  // ── Active goals ──────────────────────────────────────────
  lines.push(`  <section class="cc-dashboard__goals">`);
  lines.push(`    <h2 class="cc-dashboard__section-title">长期目标</h2>`);
  if (data.activeGoals.length === 0) {
    lines.push(`    <p class="cc-dashboard__empty-hint">暂无活跃目标</p>`);
  } else {
    for (const goal of data.activeGoals) {
      lines.push(
        `    <div class="cc-dashboard__goal-card">`,
        `      <span>${escapeHtml(goal.text)}</span>`,
        `      <span class="cc-badge cc-badge--info">${escapeHtml(goal.horizon)}</span>`,
        `    </div>`,
      );
    }
  }
  lines.push(`  </section>`);

  // ── Pending validations ───────────────────────────────────
  lines.push(`  <section class="cc-dashboard__validations">`);
  lines.push(`    <h2 class="cc-dashboard__section-title">正在验证</h2>`);
  if (data.pendingValidations.length === 0) {
    lines.push(`    <p class="cc-dashboard__empty-hint">暂无待验证项</p>`);
  } else {
    for (const v of data.pendingValidations) {
      lines.push(
        `    <div class="cc-dashboard__validation-row">`,
        `      <span>${escapeHtml(v.action)}</span>`,
        `      <span class="cc-badge cc-badge--active">${escapeHtml(v.status)}</span>`,
        `    </div>`,
      );
    }
  }
  lines.push(`  </section>`);

  // ── Footer ────────────────────────────────────────────────
  lines.push(
    `  <footer class="cc-dashboard__footer">`,
    `    <span class="cc-dashboard__version">深度对话</span>`,
    `  </footer>`,
  );

  lines.push(`</div>`);
  return lines.join("\n");
}

// ─── Part 3: DashboardView ────────────────────────────────────

export const DASHBOARD_VIEW_TYPE = "cognitive-companion-dashboard";

/**
 * Obsidian ItemView for the Cognitive Companion Dashboard.
 */
export class DashboardView extends ItemView {
  private composition: CompositionRoot;
  private actions: DashboardActions;
  private isLoaded = false;

  constructor(
    leaf: WorkspaceLeaf,
    composition: CompositionRoot,
    actions: DashboardActions,
  ) {
    super(leaf);
    this.composition = composition;
    this.actions = actions;
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "深度对话";
  }

  getIcon(): string {
    return "brain";
  }

  /**
   * Refresh the dashboard view.
   * Reads fresh data from CompositionRoot and re-renders HTML.
   */
  async refresh(): Promise<void> {
    const data = await this.composition.getDashboardData();

    const html = renderDashboardHTML(data);
    this.contentEl.empty();
    this.contentEl.innerHTML = html;
    this.bindEvents();
  }

  async onOpen(): Promise<void> {
    await this.refresh();
    this.isLoaded = true;
  }

  async onClose(): Promise<void> {
    this.isLoaded = false;
  }

  /**
   * Bind DOM event listeners for action buttons.
   * Uses event delegation — buttons are identified by their data-action attribute.
   */
  private bindEvents(): void {
    this.contentEl.onclick = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLButtonElement>("button[data-action]");
      const action = button?.dataset.action as DashboardActionId | undefined;
      if (!action) return;
      void dispatchDashboardAction(action, this.actions);
    };
  }
}
