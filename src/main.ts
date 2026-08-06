// ─── Plugin Entry Point ─────────────────────────────────────────
//
// CognitiveCompanionPlugin is the Obsidian Plugin subclass.
// Its onload() only does three things (AGENT.md line 440):
//   1. Read settings
//   2. Call composition root
//   3. Register commands and views
//
// Pure functions extractSettings and checkNewWeekMessage are exported
// for testing without Obsidian runtime dependencies.
//
// Security: no real vault access, no API keys in HTML, no file writes
// outside the system output directory (enforced by validateWritePath in
// storage/markdown.ts).

import { App, Plugin, Notice, TFile, Modal, SuggestModal, type WorkspaceLeaf } from "obsidian";
import { createComposition, type CompositionRoot } from "./composition";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./ui/dashboard";
import { ConversationView, CONVERSATION_VIEW_TYPE } from "./ui/conversation-view";
import type { ConversationSeed } from "./conversation/model";
import { CognitiveCompanionSettingTab } from "./settings";
import {
  pluginSettingsSchema,
  type PluginSettings,
} from "./storage/plugin-state";
import type { VaultAdapter } from "./vault/adapter";
import type { MarkdownFileSystem } from "./storage/markdown";
import { isNewWeek, getWeekId } from "./weekly/orchestrator";
import type {
  PreparedTopic,
  WeeklyPreparationProgress,
  WeeklyPreparationService,
} from "./weekly/preparation-service";
import { PreparedTopicSuggestModal } from "./ui/prepared-topic-suggest-modal";
import { ConversationSuggestModal } from "./ui/conversation-suggest-modal";
import type { ConversationSummary } from "./conversation/composition-conversation";
import type { WeeklySnapshot } from "./domain/types";
import { testModelConnectivity } from "./ai/connectivity";
import { sanitizeErrorMessage } from "./conversation/error-classifier";
import { runCleanupPreflight } from "./conversation/cleanup-preflight";

// ─── Pure Functions (exported for testing) ────────────────────

export function formatWeeklyPreparationProgress(
  progress: WeeklyPreparationProgress,
): string {
  if (progress.phase === "generating_topics") {
    return `已分析 ${progress.noteCount} 篇笔记\nAI 正在生成候选主题…`;
  }

  const action = progress.phase === "scanning" ? "扫描" : "分析";
  return `正在${action}笔记 ${progress.current} / ${progress.total}\n当前：${progress.noteTitle}`;
}

export function createWeeklyPreparationProgressReporter(
  updateMessage: (message: string) => void,
  clock: () => number = Date.now,
  minIntervalMs = 300,
): (progress: WeeklyPreparationProgress) => void {
  let lastUpdateAt = Number.NEGATIVE_INFINITY;
  let lastPhase: WeeklyPreparationProgress["phase"] | null = null;

  return (progress) => {
    const now = clock();
    const phaseChanged = progress.phase !== lastPhase;
    const isBoundary = progress.phase === "generating_topics"
      || progress.current === 1
      || progress.current === progress.total;

    if (!phaseChanged && !isBoundary && now - lastUpdateAt < minIntervalMs) {
      return;
    }

    updateMessage(formatWeeklyPreparationProgress(progress));
    lastUpdateAt = now;
    lastPhase = progress.phase;
  };
}

/**
 * Extract PluginSettings from Obsidian loadData's raw return value.
 *
 * Behavior:
 * - null / undefined data → defaults (via Zod .default())
 * - object with valid "settings" key → parsed Settings
 * - object with invalid/missing "settings" key → defaults
 * - non-object data → defaults
 *
 * Uses Zod safeParse so invalid fields fall back to schema defaults
 * rather than throwing.
 */
export function extractSettings(data: unknown): PluginSettings {
  if (data === null || data === undefined) {
    return pluginSettingsSchema.parse({}) as PluginSettings;
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if ("settings" in obj) {
      const rawSettings = obj.settings;
      if (
        rawSettings !== null &&
        rawSettings !== undefined &&
        typeof rawSettings === "object"
      ) {
        const parsed = pluginSettingsSchema.safeParse(rawSettings);
        if (parsed.success) {
          return parsed.data as PluginSettings;
        }
      }
    }
  }
  // Fallback: return all defaults
  return pluginSettingsSchema.parse({}) as PluginSettings;
}

export type WeeklyEntryDecision =
  | { readonly kind: "resume"; readonly conversationId: string }
  | { readonly kind: "choose"; readonly topics: readonly PreparedTopic[] }
  | { readonly kind: "prepare" };

export function decideWeeklyEntry(
  topics: readonly PreparedTopic[],
): WeeklyEntryDecision {
  const inProgress = topics.find(
    (topic) => topic.status === "in_progress" && topic.conversation_id,
  );
  if (inProgress?.conversation_id) {
    return { kind: "resume", conversationId: inProgress.conversation_id };
  }

  const candidates = topics.filter(
    (topic) => topic.status === "pending" || topic.status === "snoozed",
  );
  if (candidates.length > 0) {
    return { kind: "choose", topics: candidates };
  }

  return { kind: "prepare" };
}

/**
 * Select up to `maxTopics` topics for display in the weekly topic chooser.
 *
 * Priority rules:
 *  1. Up to 3 news/hot topics (is_news_related === true) if available
 *  2. Remaining slots filled by note-based topics (is_news_related === false)
 *  3. Both discussable (pending/snoozed/in_progress) and discussed topics are included
 *     — discussed topics get a "[重新讨论]" label in the UI
 *  4. Sorted by relevance_score descending within each category
 */
export function selectDisplayTopics(
  allTopics: readonly PreparedTopic[],
  maxTopics: number,
): readonly PreparedTopic[] {
  if (allTopics.length === 0) return [];

  // Separate by status
  const discussable = allTopics.filter(
    (t) => t.status === "pending" || t.status === "snoozed" || t.status === "in_progress",
  );
  const discussed = allTopics.filter((t) => t.status === "discussed");

  // Within discussable: separate news-related from note-based
  const newsTopics = discussable.filter((t) => t.is_news_related);
  const noteBased = discussable.filter((t) => !t.is_news_related);

  // Sort each group by relevance
  const byScore = (a: PreparedTopic, b: PreparedTopic) => b.relevance_score - a.relevance_score;
  newsTopics.sort(byScore);
  noteBased.sort(byScore);
  discussed.sort(byScore);

  const selected: PreparedTopic[] = [];

  // Rule 1: Up to 3 news topics first
  const maxNews = Math.min(3, maxTopics);
  for (const t of newsTopics) {
    if (selected.length >= maxNews) break;
    selected.push(t);
  }

  // Rule 2: Fill remaining with note-based topics
  for (const t of noteBased) {
    if (selected.length >= maxTopics) break;
    selected.push(t);
  }

  // Rule 3: If still not enough, fill with remaining news
  for (const t of newsTopics) {
    if (selected.length >= maxTopics) break;
    if (!selected.includes(t)) selected.push(t);
  }

  // Rule 4: Fill remaining slots with re-discuss topics
  for (const t of discussed) {
    if (selected.length >= maxTopics) break;
    selected.push(t);
  }

  return selected;
}

/**
 * Check if a new week has started since the last snapshot was frozen.
 * Returns a human-readable Chinese message if a new week has started,
 * or null if no notification is needed.
 *
 * Cases:
 * - No snapshot → null (first run, no need to notify)
 * - Same week → null
 * - New week → "新的一周开始了（2026-W32），建议刷新快照并开始本周回顾。"
 */
export function checkNewWeekMessage(
  snapshot: WeeklySnapshot | null,
  now: Date
): string | null {
  if (snapshot === null) return null;
  if (isNewWeek(snapshot, now)) {
    const weekId = getWeekId(now);
    return `新的一周开始了（${weekId}），建议刷新快照并开始本周回顾。`;
  }
  return null;
}

// ─── Text Input Modal ─────────────────────────────────────────

/**
 * A simple modal with a text input field, used instead of the
 * browser prompt() which is unreliable in Obsidian's Electron runtime.
 *
 * Uses native createEl("input") instead of Setting to avoid lifecycle
 * issues with Obsidian's Setting component in onOpen().
 *
 * IMPORTANT: All DOM manipulation (titleEl.setText, createEl) must
 * happen in onOpen(), NOT in the constructor. In real Obsidian, titleEl
 * and contentEl may not be fully initialized until the modal is opened.
 */
class TextInputModal extends Modal {
  private onSubmit: (value: string | null) => void;
  private modalTitle: string;
  private modalPlaceholder: string;
  private submitted = false;

  constructor(
    app: App,
    title: string,
    placeholder: string,
    onSubmit: (value: string | null) => void,
  ) {
    super(app);
    this.onSubmit = onSubmit;
    this.modalTitle = title;
    this.modalPlaceholder = placeholder;
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);

    const input = this.contentEl.createEl("input", {
      type: "text",
      attr: { placeholder: this.modalPlaceholder },
    });
    input.style.width = "100%";
    input.style.padding = "8px";
    input.style.fontSize = "14px";
    input.style.border = "1px solid var(--background-modifier-border)";
    input.style.borderRadius = "4px";
    input.style.backgroundColor = "var(--background-primary)";
    input.style.color = "var(--text-normal)";

    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        this.submitted = true;
        const value = input.value.trim();
        this.close();
        this.onSubmit(value || null);
      }
    });

    input.focus();
  }

  onClose(): void {
    if (!this.submitted) {
      this.onSubmit(null);
    }
  }
}

// ─── Plugin Class ─────────────────────────────────────────────

export default class CognitiveCompanionPlugin extends Plugin {
  private composition: CompositionRoot | null = null;

  // ════════════════════════════════════════════════════════════
  // Lifecycle
  // ════════════════════════════════════════════════════════════

  async onload(): Promise<void> {
    try {
    // 1. Load settings data from Obsidian data.json
    const data = await this.loadData();

    // 2. Add settings tab (must be done before composition for proper DI)
    this.addSettingTab(new CognitiveCompanionSettingTab(this.app, this));

    // 3. Parse PluginSettings from data (with fallback to defaults)
    const settings = this.loadSettings(data);

    // 4. Create Composition Root — wires all dependencies
    this.composition = await createComposition({
      vaultAdapter: this.createVaultAdapter(),
      loadData: () => this.loadData(),
      saveData: (d) => this.saveData(d),
      markdownFs: this.createMarkdownFs(),
      settings,
    });

    // 5. Initialize composition (session-restore, first-run detection, etc.)
    await this.composition.initialize();

    // 6. Register views
    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new DashboardView(
        leaf,
        this.composition!,
        {
          startFreeQuestion: () => this.startFreeQuestionConversation(),
          startCurrentNote: () => this.startCurrentNoteConversation(),
          startOrContinueWeeklyReview: () => this.startOrContinueWeeklyReview(),
          continueConversation: () => this.continueConversation(),
          refreshTopics: () => this.refreshTopics(),
        },
      )
    );
    // Conversation-first view (Task 07)
    this.registerView(
      CONVERSATION_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        if (!this.composition?.conversations) {
          throw new Error("ConversationComposition not initialized");
        }
        return new ConversationView(leaf, this.composition.conversations);
      }
    );

    // 7. Register commands (id + 中文 name + callback)
    this.registerCommands();

    // 8. Add a single public-facing home entry.
    this.addRibbonIcon("sparkles", "深度对话", () => {
      this.activateDashboard();
    });

    // 9. Check if a new week has started and notify user
    this.checkNewWeek();

    } catch (err) {
      console.error("[PCC] onload failed:", err);
      new Notice(`PCC 插件加载失败：${err instanceof Error ? err.message : String(err)}`, 0);
      throw err;
    }
  }

  onunload(): void {
    this.composition?.shutdown();
  }

  // ════════════════════════════════════════════════════════════
  // Private: Settings Parsing
  // ════════════════════════════════════════════════════════════

  private loadSettings(data: unknown): PluginSettings {
    return extractSettings(data);
  }

  // ════════════════════════════════════════════════════════════
  // Private: Vault Adapter — wraps Obsidian Vault API
  // ════════════════════════════════════════════════════════════

  private createVaultAdapter(): VaultAdapter {
    const vault = this.app.vault;
    return {
      listFiles: async () => {
        // Use adapter.list() to read directly from disk, NOT getMarkdownFiles().
        const result = await vault.adapter.list("");
        return result.files.map((path) => ({ path }));
      },
      listDir: async (dirPath: string) => {
        // List files directly in a specific directory (non-recursive)
        const result = await vault.adapter.list(dirPath);
        return result.files.map((path) => ({ path }));
      },
      readText: async (path: string) => {
        return vault.adapter.read(path);
      },
    };
  }

  // ════════════════════════════════════════════════════════════
  // Private: Markdown File System — wraps Vault API limited to
  // the system output directory (path validation happens in
  // atomicWriteMarkdown via validateWritePath).
  // ════════════════════════════════════════════════════════════

  private createMarkdownFs(): MarkdownFileSystem {
    const vault = this.app.vault;
    return {
      writeFile: async (relativePath: string, content: string) => {
        // Ensure parent directory exists (vault.create does not auto-create folders)
        const lastSlash = relativePath.lastIndexOf("/");
        if (lastSlash > 0) {
          const parentDir = relativePath.slice(0, lastSlash);
          if (!(await vault.adapter.exists(parentDir))) {
            await vault.createFolder(parentDir);
          }
        }

        // create-or-modify: vault.create throws if path already exists
        const existing = vault.getAbstractFileByPath(relativePath);
        if (existing instanceof TFile) {
          await vault.modify(existing, content);
        } else {
          await vault.create(relativePath, content);
        }
        return new TextEncoder().encode(content).length;
      },
      readFile: async (relativePath: string) => {
        return vault.adapter.read(relativePath);
      },
      fileExists: async (relativePath: string) => {
        return vault.adapter.exists(relativePath);
      },
      copyFile: async (sourcePath: string, targetPath: string) => {
        await vault.adapter.copy(sourcePath, targetPath);
      },
      deleteFile: async (relativePath: string) => {
        // adapter.remove works with paths directly, avoids TFile cast
        if (await vault.adapter.exists(relativePath)) {
          await vault.adapter.remove(relativePath);
        }
      },
      listFiles: async (dirPath: string) => {
        const listed = await vault.adapter.list(dirPath);
        return listed.files;
      },
    };
  }

  // ════════════════════════════════════════════════════════════
  // Private: Command Registration
  // ════════════════════════════════════════════════════════════

  private registerCommands(): void {
    this.addCommand({
      id: "open-dashboard",
      name: "打开深度对话",
      callback: () => this.activateDashboard(),
    });

    this.addCommand({
      id: "conversation-current-note",
      name: "认知对话：从当前笔记",
      callback: () => this.startCurrentNoteConversation(),
    });
  }

  // ════════════════════════════════════════════════════════════
  // Private: View Activation
  // ════════════════════════════════════════════════════════════

  private async activateDashboard(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  private async activateConversationView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CONVERSATION_VIEW_TYPE)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: CONVERSATION_VIEW_TYPE, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  // ── Conversation-first entry points (Task 07) ─────────────

  /**
   * Shared helper: activate conversation view, set conversation,
   * auto-send the first message from the seed content, and refresh.
   *
   * The first user input (from Modal or elsewhere) is used as the
   * actual first conversation turn — NOT just as a title.
   */
  private async openConversationWithFirstMessage(
    conversations: NonNullable<typeof this.composition>["conversations"],
    seed: ConversationSeed,
    firstMessage: string,
  ): Promise<string> {
    const conv = await conversations.createConversation(seed);
    await this.activateConversationView();
    const leaves = this.app.workspace.getLeavesOfType(CONVERSATION_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof ConversationView) {
        // Check for active conversation before replacing
        if (leaf.view.currentConversationId) {
          const existing = await conversations.getConversation(leaf.view.currentConversationId);
          if (existing && existing.status !== "completed") {
            new Notice(`⚠ 已有未完成的对话，已自动暂停`);
          }
        }
        await leaf.view.setConversation(conv.id);
        // Show thinking indicator and auto-send the seed content
        leaf.view.setLoading(true);
        try {
          await conversations.sendMessage(conv.id, firstMessage);
        } catch (sendErr) {
          new Notice(`发送失败：${sendErr instanceof Error ? sendErr.message : "未知错误"}`);
        } finally {
          leaf.view.isLoading = false;
          await leaf.view.refresh();
        }
      }
    }
    return conv.id;
  }

  private async startFreeQuestionConversation(): Promise<void> {
    const conversations = this.composition?.conversations;
    if (!conversations) {
      new Notice("对话功能尚未就绪");
      return;
    }

    const question = await new Promise<string | null>((resolve) => {
      new TextInputModal(
        this.app,
        "自由提问",
        "输入你的问题：",
        (value) => resolve(value),
      ).open();
    });
    if (!question || !question.trim()) return;

    try {
      const seed: ConversationSeed = {
        kind: "free_question",
        question: question.trim(),
      };
      await this.openConversationWithFirstMessage(conversations, seed, question.trim());
    } catch (err) {
      new Notice(`创建对话失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  private async startCurrentNoteConversation(): Promise<void> {
    const conversations = this.composition?.conversations;
    if (!conversations) {
      new Notice("对话功能尚未就绪");
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension.toLowerCase() !== "md") {
      new Notice("请先打开一篇 Markdown 笔记");
      return;
    }

    try {
      const seed: ConversationSeed = {
        kind: "current_note",
        note_id: activeFile.path,
        note_path: activeFile.path,
      };
      await this.openConversationWithFirstMessage(
        conversations,
        seed,
        `我想讨论笔记「${activeFile.basename}」`,
      );
    } catch (err) {
      new Notice(`创建对话失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  private async startOrContinueWeeklyReview(): Promise<void> {
    const service = this.composition?.weeklyPreparation;
    if (!service) {
      new Notice("待讨论主题功能尚未就绪");
      return;
    }

    const settings = this.composition?.pluginState.settings;
    const maxTopics = settings?.maxPriorityTopics || 3;

    // Collect all non-dismissed topics
    const allTopics = await service.listTopics();
    const visible = allTopics.filter(
      (t) => t.status === "pending" || t.status === "snoozed" || t.status === "in_progress" || t.status === "discussed",
    );

    // If we have topics, select up to maxTopics and show the chooser
    if (visible.length > 0) {
      const selected = selectDisplayTopics(visible, maxTopics);
      this.openWeeklyTopicChooser(service, selected);
      return;
    }

    // No topics at all — prepare new ones
    const preparedTopics = await this.prepareWeeklyTopics();
    if (preparedTopics === null) return;
    if (preparedTopics.length === 0) {
      new Notice("本次扫描没有生成可讨论主题", 5000);
      return;
    }
    // Limit prepared topics too
    const selected = selectDisplayTopics(preparedTopics, maxTopics);
    this.openWeeklyTopicChooser(service, selected);
  }

  private openWeeklyTopicChooser(
    service: WeeklyPreparationService,
    topics: readonly PreparedTopic[],
  ): void {
    const conversations = this.composition?.conversations;
    if (!conversations) {
      new Notice("对话功能尚未就绪");
      return;
    }

    new PreparedTopicSuggestModal(
      this.app,
      topics,
      (selectedTopic: PreparedTopic) => {
        void (async () => {
          // Handle re-discuss: reset discussed topic to pending first
          if (selectedTopic.status === "discussed") {
            try {
              await (service as any).resetTopicForRediscuss?.(selectedTopic.topic_id);
            } catch {
              // If resetTopicForRediscuss doesn't exist, try markTopicInProgress directly
              // The topic will be handled as in_progress below
            }
          }

          // Resume in-progress conversation
          if (selectedTopic.status === "in_progress" && selectedTopic.conversation_id) {
            await this.openConversationById(
              selectedTopic.conversation_id,
              `已恢复本周主题：${selectedTopic.title}`,
            );
            return;
          }

          // Start new conversation for pending/snoozed/discussed(reset) topics
          const noteIds = selectedTopic.source_note_id
            ? [selectedTopic.source_note_id]
            : [];
          const seed: ConversationSeed = {
            kind: "weekly_topic",
            topic_id: selectedTopic.topic_id,
            topic_title: selectedTopic.title,
            note_ids: noteIds,
          };

          try {
            const conversationId = await this.openConversationWithFirstMessage(
              conversations,
              seed,
              selectedTopic.title,
            );
            await service.markTopicInProgress(selectedTopic.topic_id, conversationId);
            this.refreshDashboardLeaf();
          } catch (err) {
            new Notice(
              `创建对话失败：${err instanceof Error ? err.message : "未知错误"}`,
            );
          }
        })();
      },
    ).open();
  }

  // ════════════════════════════════════════════════════════════
  // Private: Command Handlers
  // ════════════════════════════════════════════════════════════

  private async refreshSnapshot(): Promise<void> {
    if (!this.composition) return;
    const confirmed = confirm(
      "刷新笔记快照将扫描全部笔记并重建本周快照，确定继续？"
    );
    if (!confirmed) return;

    try {
      await this.composition.refreshSnapshot();
      new Notice("笔记快照已刷新");
      await this.refreshDashboardLeaf();
    } catch (err) {
      new Notice(`刷新快照失败：${String(err)}`);
    }
  }

  /**
   * Refresh any open Dashboard views so they reflect
   * the latest pluginState after a command mutates it.
   */
  private refreshDashboardLeaf(): void {
    const leaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof DashboardView) {
        leaf.view.refresh();
      }
    }
  }

  // ── Weekly Preparation (Task 08) ───────────────────────────

  /**
   * Trigger AI-powered topic scanning and preparation.
   * Creates a new WeeklyPreparationService, scans the vault,
   * calls AI to generate/merge/rank topics, and displays results.
   */
  private async prepareWeeklyTopics(): Promise<readonly PreparedTopic[] | null> {
    const service = this.composition?.weeklyPreparation;
    if (!this.composition || !service) {
      new Notice("插件尚未就绪");
      return null;
    }

    const progressNotice = new Notice("正在扫描笔记并拉取热点…", 0);
    const reportProgress = createWeeklyPreparationProgressReporter((message) => {
      progressNotice.setMessage(message);
    });
    try {
      const result = await service.prepareWeeklyTopics(reportProgress);
      progressNotice.hide();
      new Notice(result.message, 5000);

      // Refresh dashboard to show updated weekly status
      this.refreshDashboardLeaf();
      return result.mergedTopics;
    } catch (err) {
      progressNotice.hide();
      new Notice(`准备主题失败：${err instanceof Error ? err.message : "未知错误"}`, 5000);
      return null;
    }
  }

  /**
   * Refresh topics + rebuild note index in one go.
   * Called from the dashboard "刷新话题" button.
   */
  private async refreshTopics(): Promise<void> {
    const service = this.composition?.weeklyPreparation;
    if (!this.composition || !service) {
      new Notice("插件尚未就绪");
      return;
    }

    const progressNotice = new Notice("正在扫描笔记、重建索引、拉取热点…", 0);

    try {
      // 1. Rebuild note index (so context search finds latest notes)
      if (this.composition.rebuildNoteIndex) {
        progressNotice.setMessage("正在重建笔记索引…");
        const index = await this.composition.rebuildNoteIndex(
          (current, total, _path) => {
            if (current % 100 === 0) {
              progressNotice.setMessage(`正在重建笔记索引… ${current}/${total}`);
            }
          },
        );
        console.log(`[PCC] Note index rebuilt: ${index.totalNotes} notes`);
      }

      // 2. Prepare weekly topics
      progressNotice.setMessage("正在生成讨论主题…");
      const reportProgress = createWeeklyPreparationProgressReporter((message) => {
        progressNotice.setMessage(message);
      });
      const result = await service.prepareWeeklyTopics(reportProgress);

      progressNotice.hide();
      new Notice(`✅ ${result.message}`, 5000);
      this.refreshDashboardLeaf();
    } catch (err) {
      progressNotice.hide();
      new Notice(`刷新失败：${err instanceof Error ? err.message : "未知错误"}`, 5000);
    }
  }

  // ── Continue / Resume Conversation ─────────────────────────

  private async continueConversation(): Promise<void> {
    const conversations = this.composition?.conversations;
    if (!conversations) {
      new Notice("对话功能尚未就绪");
      return;
    }

    const all = await conversations.listConversations();
    if (all.length === 0) {
      new Notice("暂无历史对话，请先开始一段新对话", 5000);
      return;
    }

    // Build summary list for SuggestModal
    const summaries = all.map((c) => ({
      id: c.id,
      seedType: c.seed.kind as "free_question" | "current_note" | "weekly_topic",
      title: c.seed.kind === "weekly_topic"
        ? (c.seed as { topic_title?: string }).topic_title ?? "本周主题"
        : c.seed.kind === "current_note"
          ? (c.seed as { note_title?: string }).note_title ?? "当前笔记"
          : "自由提问",
      status: c.status,
      turnCount: c.turns.length,
      updatedAt: c.updated_at,
      hasPendingConfirmation: c.status === "awaiting_summary_confirmation",
    }));

    new ConversationSuggestModal(
      this.app,
      summaries,
      async (selected) => {
        await this.openConversationById(selected.id, `已恢复对话：${selected.title}`);
      },
    ).open();
  }

  private async openConversationById(
    conversationId: string,
    noticeMessage?: string,
  ): Promise<void> {
    await this.activateConversationView();
    const leaves = this.app.workspace.getLeavesOfType(CONVERSATION_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof ConversationView) {
        await leaf.view.setConversation(conversationId);
        if (noticeMessage) new Notice(noticeMessage, 3000);
        return;
      }
    }
    new Notice("无法打开认知对话视图", 5000);
  }

  // ── Manual Conclusion Generation ──────────────────────────

  private async generateConclusion(): Promise<void> {
    const conversations = this.composition?.conversations;
    if (!conversations) {
      new Notice("对话功能尚未就绪");
      return;
    }

    const leaves = this.app.workspace.getLeavesOfType(CONVERSATION_VIEW_TYPE);
    let activeConvId: string | null = null;
    for (const leaf of leaves) {
      if (leaf.view instanceof ConversationView) {
        activeConvId = leaf.view.currentConversationId;
        break;
      }
    }

    if (!activeConvId) {
      new Notice("请先打开一段对话", 5000);
      return;
    }

    const conv = await conversations.getConversation(activeConvId);
    if (!conv) {
      new Notice("对话不存在", 5000);
      return;
    }

    if (conv.status === "completed") {
      new Notice("对话已结束，无需再次生成结论", 5000);
      return;
    }

    if (conv.turns.length < 2) {
      new Notice("对话轮次不足，请至少进行一轮问答后再生成结论", 5000);
      return;
    }

    // Show thinking, then trigger manual conclusion
    for (const leaf of leaves) {
      if (leaf.view instanceof ConversationView) {
        leaf.view.setLoading(true);
      }
    }

    try {
      const result = await conversations.concludeConversation(activeConvId);
      for (const leaf of leaves) {
        if (leaf.view instanceof ConversationView) {
          leaf.view.setLoading(false);
          if (result.conversation.status === "awaiting_summary_confirmation") {
            new Notice("结论已生成，请在对话中确认、修改或否定", 5000);
          }
        }
      }
    } catch (err) {
      for (const leaf of leaves) {
        if (leaf.view instanceof ConversationView) {
          leaf.view.setLoading(false);
        }
      }
      new Notice(
        `生成结论失败：${err instanceof Error ? err.message : "未知错误"}`,
        5000,
      );
    }
  }

  private checkNewWeek(): void {
    if (!this.composition) return;

    // New approach (Task 08): use week ID comparison directly
    const now = new Date();
    const currentWeekId = getWeekId(now);

    // Also check the old snapshot-based approach for backward compatibility
    const snapshot = this.composition.pluginState.snapshot;
    if (snapshot !== null) {
      const snapshotWeekId = getWeekId(new Date(snapshot.frozen_at));
      if (snapshotWeekId !== currentWeekId) {
        new Notice(
          `新的一周开始了（${currentWeekId}），可以使用"准备本周主题"命令来扫描笔记并生成候选主题。`,
          0,
        );
        return;
      }
    }
  }

  // ── Connectivity Test (Task 10) ────────────────────────────

  private async testConnectivity(): Promise<void> {
    if (!this.composition) {
      new Notice("插件尚未就绪");
      return;
    }

    const settings = this.composition.pluginState.settings;
    if (!settings.deepseekApiKey) {
      new Notice("❌ 请先在设置中填写 API Key");
      return;
    }

    new Notice("正在测试连接...");
    const result = await testModelConnectivity(
      settings.deepseekEndpoint,
      settings.deepseekApiKey,
      settings.deepseekModel,
    );

    if (result.ok) {
      new Notice(`✅ ${result.model} 连接成功`, 5000);
    } else {
      const safeError = result.error ?? "未知错误";
      new Notice(`❌ 连接失败：${safeError}`, 5000);
    }
  }

  // ── Cleanup Preflight (Task 10) ────────────────────────────

  private async cleanupPreflight(): Promise<void> {
    if (!this.composition) {
      new Notice("插件尚未就绪");
      return;
    }

    const settings = this.composition.pluginState.settings;
    const vault = this.createVaultAdapter();

    new Notice("正在扫描旧数据...");
    try {
      const result = await runCleanupPreflight(vault, settings.systemOutputDir);

      if (result.scannedCount === 0) {
        new Notice("未找到旧运行数据文件，无需清理。");
        return;
      }

      new Notice(result.summary, 5000);

      // If there are files needing human judgment, list them
      if (result.blocked) {
        const humanFiles = result.files.filter((f) => f.decision === "human_judgment");
        const fileList = humanFiles.map((f) => `  - ${f.path} (${f.attribution})`).join("\n");
        new Notice(`需人工判断的文件：\n${fileList}`, 8000);
      }
    } catch (err) {
      const safeMsg = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      new Notice(`❌ 清理预检失败：${safeMsg}`);
    }
  }
}
