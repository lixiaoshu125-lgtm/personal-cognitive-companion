import { App, Plugin, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type { PluginSettings, PluginState } from "./storage/plugin-state";
import { loadPluginState, serializePluginState } from "./storage/plugin-state";
import type { SpeechAliasDictionary } from "./language/aliases";
import { addUnambiguousAlias } from "./language/aliases";
import { sanitizeErrorMessage } from "./conversation/error-classifier";

// ─── Validation Utilities ───────────────────────────────────

/**
 * 验证 DeepSeek endpoint URL 格式。
 * 返回 { valid: true } 或 { valid: false, error: "错误信息" }。
 */
export function validateEndpoint(
  url: string
): { valid: boolean; error?: string } {
  if (!url || url.trim().length === 0) {
    return { valid: false, error: "Endpoint 不能为空" };
  }

  const trimmed = url.trim();

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        valid: false,
        error: "Endpoint 必须以 http:// 或 https:// 开头",
      };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Endpoint 格式无效，请输入有效的 URL" };
  }
}

/**
 * 掩码 API Key（用于 UI 显示）。
 * 规则：
 * - 保留前 4 位和后 4 位，中间用 * 替换
 * - 至少显示 8 个掩码字符（当 key 长度 >= 16 时中间至少 8 个 *）
 * - 少于 8 位 → 全部掩码
 * - 空字符串 → 返回空字符串
 */
export function maskApiKey(key: string): string {
  if (key.length === 0) return "";
  if (key.length < 8) return "*".repeat(key.length);

  const prefix = key.slice(0, 4);
  const suffix = key.slice(-4);
  const maskLen = Math.max(8, key.length - 8);
  return prefix + "*".repeat(maskLen) + suffix;
}

/**
 * 验证系统输出目录名。
 * 拒绝：空字符串、..、/、\、以 . 开头
 */
export function validateOutputDir(
  dir: string
): { valid: boolean; error?: string } {
  if (!dir || dir.trim().length === 0) {
    return { valid: false, error: "输出目录不能为空" };
  }

  const trimmed = dir.trim();

  if (trimmed.includes("..")) {
    return { valid: false, error: "输出目录不能包含 .." };
  }
  if (trimmed.includes("/")) {
    return { valid: false, error: "输出目录不能包含 /" };
  }
  if (trimmed.includes("\\")) {
    return { valid: false, error: "输出目录不能包含 \\" };
  }
  if (trimmed.startsWith(".")) {
    return { valid: false, error: "输出目录不能以 . 开头" };
  }

  return { valid: true };
}

/**
 * 验证数值设置在有效范围内。
 */
export function validateNumericSetting(
  value: number,
  min: number,
  max: number,
  label: string
): { valid: boolean; error?: string } {
  if (!Number.isFinite(value)) {
    return { valid: false, error: `${label} 必须是有效数字` };
  }
  if (!Number.isInteger(value)) {
    return { valid: false, error: `${label} 必须是整数` };
  }
  if (value < min) {
    return { valid: false, error: `${label} 不能小于 ${min}` };
  }
  if (value > max) {
    return { valid: false, error: `${label} 不能大于 ${max}` };
  }

  return { valid: true };
}

// ─── Alias Dictionary Management ─────────────────────────────

/**
 * 添加别名到字典。
 * 委托给 addUnambiguousAlias，如果 autoAddUnambiguous 关闭则跳过。
 */
export function addAliasToDictionary(
  dictionary: SpeechAliasDictionary,
  alias: string,
  canonical: string,
  autoAddUnambiguous: boolean
): { dictionary: SpeechAliasDictionary; added: boolean; reason?: string } {
  if (!autoAddUnambiguous) {
    return { dictionary, added: false, reason: "autoAddUnambiguous 未开启" };
  }

  const normalizedAlias = alias.trim().normalize("NFKC");
  const normalizedCanonical = canonical.trim().normalize("NFKC");

  if (normalizedAlias.length === 0 || normalizedCanonical.length === 0) {
    return { dictionary, added: false, reason: "别名或正确说法不能为空" };
  }

  // 检查别名是否已存在（大小写不敏感、trim 后比较）
  const aliasKey = normalizedAlias.toLocaleLowerCase();
  const exists = Object.keys(dictionary).some(
    (key) => key.trim().normalize("NFKC").toLocaleLowerCase() === aliasKey
  );
  if (exists) {
    return { dictionary, added: false, reason: "别名已存在" };
  }

  const updated = addUnambiguousAlias(dictionary, normalizedAlias, normalizedCanonical);
  if (updated === dictionary) {
    return {
      dictionary,
      added: false,
      reason: "无法添加该别名（可能与现有别名存在歧义冲突）",
    };
  }

  return { dictionary: updated, added: true };
}

/**
 * 从字典中删除别名。不存在的别名幂等返回原字典。
 */
export function removeAliasFromDictionary(
  dictionary: SpeechAliasDictionary,
  alias: string
): SpeechAliasDictionary {
  const normalizedInput = alias.trim().normalize("NFKC");

  const newDict: Record<string, readonly string[]> = {};
  let found = false;

  for (const [key, value] of Object.entries(dictionary)) {
    if (key.trim().normalize("NFKC") === normalizedInput) {
      found = true;
    } else {
      newDict[key] = value;
    }
  }

  if (!found) return dictionary;
  return Object.freeze(newDict);
}

/**
 * 合并导入的别名字典。冲突时跳过不覆盖已有条目。
 * 返回合并后的字典及 added/skipped 计数。
 */
export function mergeAliasDictionaries(
  existing: SpeechAliasDictionary,
  imported: SpeechAliasDictionary
): { dictionary: SpeechAliasDictionary; added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  let result: Record<string, readonly string[]> = { ...existing };

  const existingKeys = new Set(
    Object.keys(existing).map((k) =>
      k.trim().normalize("NFKC").toLocaleLowerCase()
    )
  );

  for (const [alias, canonicals] of Object.entries(imported)) {
    const normalizedAlias = alias
      .trim()
      .normalize("NFKC")
      .toLocaleLowerCase();

    if (existingKeys.has(normalizedAlias)) {
      skipped += 1;
    } else {
      result[alias] = canonicals;
      existingKeys.add(normalizedAlias);
      added += 1;
    }
  }

  return {
    dictionary: Object.freeze(result),
    added,
    skipped,
  };
}

// ─── Section Labels ──────────────────────────────────────────

const SECTION_AI_SERVICE = "AI 服务";
const SECTION_SYSTEM_OUTPUT = "系统输出";
const SECTION_WIKI = "Wiki 输出";
const SECTION_BUDGET_LIMITS = "主题设置";
const SECTION_ALIAS_MANAGEMENT = "语音别名管理";

// ─── Settings Tab ────────────────────────────────────────────

export class CognitiveCompanionSettingTab extends PluginSettingTab {
  private readonly plugin: Plugin;
  private currentSettings: PluginSettings | null = null;
  // 记录被用户关闭（toggle off）的别名，用于 5 秒撤销窗口
  private pendingDeletes = new Map<
    string,
    { entry: [string, readonly string[]]; timeout: ReturnType<typeof setTimeout> }
  >();

  constructor(app: App, plugin: Plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ════════════════════════════════════════════════════════════
  // Obsidian 生命周期
  // ════════════════════════════════════════════════════════════

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("div", {
      text: "加载设置中…",
      cls: "setting-item-description",
    });

    this.plugin.loadData().then((rawData: unknown) => {
      const state = loadPluginState(rawData);
      this.currentSettings = state.settings;
      containerEl.empty();
      this.buildAllSections(containerEl);
    });
  }

  hide(): void {
    // 清除所有待处理的撤销定时器
    for (const [, pending] of this.pendingDeletes) {
      clearTimeout(pending.timeout);
    }
    this.pendingDeletes.clear();
  }

  // ════════════════════════════════════════════════════════════
  // 持久化
  // ════════════════════════════════════════════════════════════

  private async saveSettings(settings: PluginSettings): Promise<void> {
    this.currentSettings = settings;
    const rawData = await this.plugin.loadData();
    const state = loadPluginState(rawData);
    const updated: PluginState = {
      ...state,
      settings,
    };
    await this.plugin.saveData(serializePluginState(updated));
  }

  private async updateAliasDictionary(
    dictionary: SpeechAliasDictionary
  ): Promise<void> {
    const rawData = await this.plugin.loadData();
    const state = loadPluginState(rawData);
    const updated: PluginState = {
      ...state,
      aliasDictionary: dictionary,
    };
    // 同步更新 currentSettings（aliasDictionary 不在 settings 中，但保持一致性）
    await this.plugin.saveData(serializePluginState(updated));
  }

  private async loadAliasDictionary(): Promise<SpeechAliasDictionary> {
    const rawData = await this.plugin.loadData();
    const state = loadPluginState(rawData);
    return state.aliasDictionary;
  }

  // ════════════════════════════════════════════════════════════
  // 构建全部 Section
  // ════════════════════════════════════════════════════════════

  private buildAllSections(containerEl: HTMLElement): void {
    this.buildSection1(containerEl);
    this.buildSection2(containerEl);
    this.buildSectionWiki(containerEl);
    this.buildSection3(containerEl);
    this.buildSection4(containerEl);
  }

  // ════════════════════════════════════════════════════════════
  // Section 1：AI 服务
  // ════════════════════════════════════════════════════════════

  private buildSection1(containerEl: HTMLElement): void {
    const settings = this.currentSettings!;

    containerEl.createEl("h2", { text: SECTION_AI_SERVICE });

    // DeepSeek Endpoint
    new Setting(containerEl)
      .setName("DeepSeek Endpoint")
      .setDesc("DeepSeek API 的地址前缀")
      .addText((text) =>
        text
          .setPlaceholder("https://api.deepseek.com/v1")
          .setValue(settings.deepseekEndpoint)
          .onChange(async (value) => {
            const updated = { ...this.currentSettings!, deepseekEndpoint: value };
            await this.saveSettings(updated);
          })
      );

    // DeepSeek Model — dropdown with old-model migration detection
    const OLD_MODEL_NAMES: readonly string[] = ["deepseek-chat", "deepseek-reasoner"];
    const currentModel = settings.deepseekModel;
    const isOldModel = OLD_MODEL_NAMES.includes(currentModel);

    // Auto-migrate old model name immediately on detection
    if (isOldModel) {
      const migrated = { ...this.currentSettings!, deepseekModel: "deepseek-v4-pro" };
      this.saveSettings(migrated);
    }

    const modelDescEl = containerEl.createEl("span");
    const modelSetting = new Setting(containerEl)
      .setName("DeepSeek Model");

    if (isOldModel) {
      modelSetting.descEl.createEl("span", {
        text: `⚠️ 检测到旧模型名 "${currentModel}"，该模型已停用。已自动切换为 deepseek-v4-pro。请确认后保存。`,
        attr: { style: "color: var(--text-warning); font-weight: 600;" },
      });
    } else {
      modelSetting.setDesc("选择 DeepSeek 模型。V4 Pro 推荐日常使用，V4 Flash 更快但精确度略低。");
    }

    modelSetting.addDropdown((dropdown) => {
      dropdown
        .addOption("deepseek-v4-pro", "DeepSeek V4 Pro（推荐）")
        .addOption("deepseek-v4-flash", "DeepSeek V4 Flash（快速）")
        .setValue(isOldModel ? "deepseek-v4-pro" : currentModel)
        .onChange(async (value) => {
          const updated = { ...this.currentSettings!, deepseekModel: value };
          await this.saveSettings(updated);
        });
    });

    // DeepSeek API Key（带 Show/Hide + Clear 按钮）
    const apiKeySetting = new Setting(containerEl)
      .setName("DeepSeek API Key")
      .setDesc("API Key 保存在本地 data.json，不会上传");

    let isMasked = true;
    let apiKeyTextComp: TextComponent | null = null;

    apiKeySetting.addText((text) => {
      apiKeyTextComp = text;
      text
        .setPlaceholder("sk-...")
        .setValue(
          isMasked && settings.deepseekApiKey
            ? maskApiKey(settings.deepseekApiKey)
            : settings.deepseekApiKey
        );
      text.inputEl.type = isMasked && settings.deepseekApiKey ? "password" : "text";
      text.onChange(async (value) => {
        const updated = { ...this.currentSettings!, deepseekApiKey: value };
        await this.saveSettings(updated);
      });
      return text;
    });

    // Show/Hide 切换按钮
    apiKeySetting.addExtraButton((btn) => {
      btn.setIcon("eye")
        .setTooltip("显示/隐藏 API Key")
        .onClick(() => {
          if (!apiKeyTextComp) return;
          isMasked = !isMasked;
          const currentKey = this.currentSettings?.deepseekApiKey ?? "";
          apiKeyTextComp.inputEl.value = isMasked && currentKey
            ? maskApiKey(currentKey)
            : currentKey;
          apiKeyTextComp.inputEl.type = isMasked && currentKey ? "password" : "text";
        });
      return btn;
    });

    // Clear 按钮
    apiKeySetting.addExtraButton((btn) => {
      btn.setIcon("trash")
        .setTooltip("清除 API Key")
        .onClick(async () => {
          const updated = { ...this.currentSettings!, deepseekApiKey: "" };
          await this.saveSettings(updated);
          if (apiKeyTextComp) {
            apiKeyTextComp.inputEl.value = "";
            apiKeyTextComp.inputEl.type = "password";
          }
          isMasked = true;
        });
      return btn;
    });

    // Test Connection 按钮
    const testBtn = apiKeySetting.addExtraButton((btn) => {
      btn.setIcon("wifi")
        .setTooltip("测试连接")
        .onClick(async () => {
          const s = this.currentSettings!;
          const apiKey = s.deepseekApiKey;
          if (!apiKey) {
            alert("请先填写 API Key");
            return;
          }

          // Disable button during test
          const btnEl = (btn as { buttonEl?: HTMLElement }).buttonEl ?? btn;
          if (btnEl instanceof HTMLElement) btnEl.setAttribute("disabled", "true");

          try {
            const endpoint = s.deepseekEndpoint.replace(/\/+$/u, "");
            const url = `${endpoint}/chat/completions`;
            const response = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: s.deepseekModel,
                messages: [{ role: "system", content: "ping" }],
                max_tokens: 1,
              }),
            });

            if (response.ok) {
              alert("✅ DeepSeek V4 Pro 连接成功");
            } else {
              let errorText = "";
              try {
                const errorBody = await response.json();
                errorText = JSON.stringify(errorBody);
              } catch {
                errorText = `HTTP ${response.status}`;
              }
              const safeError = sanitizeErrorMessage(errorText);
              alert(`❌ 连接失败：${safeError}`);
            }
          } catch (err) {
            const safeError = sanitizeErrorMessage(
              err instanceof Error ? err.message : String(err)
            );
            alert(`❌ 连接失败：${safeError}`);
          } finally {
            if (btnEl instanceof HTMLElement) btnEl.removeAttribute("disabled");
          }
        });
      return btn;
    });

    // Store reference for external access (test command)
    (this as { testConnectionBtn?: unknown }).testConnectionBtn = testBtn;
  }

  // ════════════════════════════════════════════════════════════
  // Section 2：系统输出
  // ════════════════════════════════════════════════════════════

  private buildSection2(containerEl: HTMLElement): void {
    const settings = this.currentSettings!;

    containerEl.createEl("h2", { text: SECTION_SYSTEM_OUTPUT });

    // 系统输出目录
    new Setting(containerEl)
      .setName("系统输出目录")
      .setDesc("插件生成的所有 Markdown 文件将保存在此目录")
      .addText((text) =>
        text
          .setPlaceholder("_个人认知系统")
          .setValue(settings.systemOutputDir)
          .onChange(async (value) => {
            const updated = { ...this.currentSettings!, systemOutputDir: value };
            await this.saveSettings(updated);
          })
      );
  }

  // ════════════════════════════════════════════════════════════
  // Section：Wiki 输出
  // ════════════════════════════════════════════════════════════

  private buildSectionWiki(containerEl: HTMLElement): void {
    const settings = this.currentSettings!;

    containerEl.createEl("h2", { text: SECTION_WIKI });

    containerEl.createEl("p", {
      text: "对话结论将沉淀为 Wiki 页面，通过 [[wikilink]] 与源笔记双向链接。Wiki 页面保存在此目录下。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Wiki 输出目录")
      .setDesc("对话结束后生成的 Wiki 页面将保存在此目录")
      .addText((text) =>
        text
          .setPlaceholder("_Wiki")
          .setValue(settings.wikiOutputDir)
          .onChange(async (value) => {
            const updated = { ...this.currentSettings!, wikiOutputDir: value };
            await this.saveSettings(updated);
          })
      );
  }

  // ════════════════════════════════════════════════════════════
  // Section 3：主题设置
  // ════════════════════════════════════════════════════════════

  private buildSection3(containerEl: HTMLElement): void {
    const settings = this.currentSettings!;

    containerEl.createEl("h2", { text: SECTION_BUDGET_LIMITS });

    new Setting(containerEl)
      .setName("最多优先主题")
      .setDesc("每次准备时生成的最大候选主题数（推荐 5）")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "10";
        text.inputEl.step = "1";
        text.setValue(String(settings.maxPriorityTopics));

        text.onChange(async (value) => {
          const num = Number(value);
          if (!Number.isNaN(num)) {
            const clamped = Math.max(1, Math.min(10, num));
            const updated = {
              ...this.currentSettings!,
              maxPriorityTopics: clamped,
            };
            await this.saveSettings(updated);
            if (clamped !== num) {
              text.inputEl.value = String(clamped);
            }
          }
        });
        return text;
      });
  }

  // ════════════════════════════════════════════════════════════
  // Section 4：语音别名管理
  // ════════════════════════════════════════════════════════════

  private buildSection4(containerEl: HTMLElement): void {
    const settings = this.currentSettings!;

    containerEl.createEl("h2", { text: SECTION_ALIAS_MANAGEMENT });

    // 提示文字
    containerEl.createEl("p", {
      text: "别名用于将口语化表达归一化到标准说法，帮助 AI 更准确理解你的笔记",
      cls: "setting-item-description",
    });

    // autoAddUnambiguousAliases 开关
    new Setting(containerEl)
      .setName("自动加入无歧义别名")
      .setDesc("自动将无歧义的新别名加入字典")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.autoAddUnambiguousAliases)
          .onChange(async (value) => {
            const updated = {
              ...this.currentSettings!,
              autoAddUnambiguousAliases: value,
            };
            await this.saveSettings(updated);
          })
      );

    // ── 别名表格容器 ──
    const tableContainer = containerEl.createEl("div");
    const refreshTable = async () => {
      tableContainer.empty();
      await this.renderAliasTable(tableContainer, refreshTable);
    };

    // "添加别名" 按钮
    new Setting(containerEl)
      .setName("添加别名")
      .setDesc("手动添加新的语音别名映射")
      .addButton((btn) =>
        btn
          .setButtonText("添加别名")
          .setCta()
          .onClick(async () => {
            await this.showAddAliasModal(refreshTable);
          })
      );

    // 初始渲染表格
    this.loadAliasDictionary().then((dict) => {
      // 渲染到 tableContainer
      this.renderAliasTable(tableContainer, refreshTable);
    });

    // ── 导入/导出按钮 ──
    const ioContainer = containerEl.createEl("div");
    ioContainer.style.marginTop = "12px";
    ioContainer.style.display = "flex";
    ioContainer.style.gap = "8px";

    // 导出 JSON
    const exportBtn = ioContainer.createEl("button");
    exportBtn.textContent = "导出 JSON";
    exportBtn.addEventListener("click", async () => {
      const dict = await this.loadAliasDictionary();
      const json = JSON.stringify(dict, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "speech-aliases.json";
      a.click();
      URL.revokeObjectURL(url);
    });

    // 导入 JSON
    const importBtn = ioContainer.createEl("button");
    importBtn.textContent = "导入 JSON";
    importBtn.addEventListener("click", async () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          const imported: unknown = JSON.parse(text);

          // 基本类型检查
          if (
            typeof imported !== "object" ||
            imported === null ||
            Array.isArray(imported)
          ) {
            alert("导入失败：JSON 格式无效，应为对象（键值对）");
            return;
          }

          // 验证每个值都是字符串数组
          for (const [key, value] of Object.entries(
            imported as Record<string, unknown>
          )) {
            if (
              !Array.isArray(value) ||
              value.some((v) => typeof v !== "string")
            ) {
              alert(`导入失败：键 "${key}" 的值不是字符串数组`);
              return;
            }
          }

          const existing = await this.loadAliasDictionary();
          const result = mergeAliasDictionaries(
            existing,
            imported as SpeechAliasDictionary
          );
          await this.updateAliasDictionary(result.dictionary);
          await refreshTable();

          if (result.skipped > 0) {
            alert(
              `导入完成：成功添加 ${result.added} 条，跳过 ${result.skipped} 条（冲突）`
            );
          }
        } catch (err) {
          alert(`导入失败：${String(err)}`);
        }
      });
      input.click();
    });
  }

  // ── 别名表格渲染 ──

  private async renderAliasTable(
    container: HTMLElement,
    refreshTable: () => Promise<void>
  ): Promise<void> {
    const dict = await this.loadAliasDictionary();
    const entries = Object.entries(dict);

    if (entries.length === 0) {
      container.createEl("p", {
        text: "暂无别名记录",
        cls: "setting-item-description",
      });
      return;
    }

    // 表头
    const table = container.createEl("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";

    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    const headers = ["正确说法", "错误说法", "来源", "启用状态", "操作"];
    for (const h of headers) {
      const th = headerRow.createEl("th");
      th.textContent = h;
      th.style.textAlign = "left";
      th.style.padding = "6px 8px";
      th.style.borderBottom = "1px solid var(--background-modifier-border)";
    }

    // 表体
    const tbody = table.createEl("tbody");

    for (const [alias, canonicals] of entries) {
      const row = tbody.createEl("tr");
      row.style.borderBottom =
        "1px solid var(--background-modifier-border-hover)";

      // 正确说法
      const canonicalCell = row.createEl("td");
      canonicalCell.textContent = canonicals.join(" / ");
      canonicalCell.style.padding = "6px 8px";

      // 错误说法
      const aliasCell = row.createEl("td");
      aliasCell.textContent = alias;
      aliasCell.style.padding = "6px 8px";

      // 来源
      const sourceCell = row.createEl("td");
      sourceCell.textContent = "用户添加";
      sourceCell.style.padding = "6px 8px";
      sourceCell.style.color = "var(--text-muted)";
      sourceCell.style.fontSize = "0.85em";

      // 启用状态
      const enabledCell = row.createEl("td");
      enabledCell.style.padding = "6px 8px";

      // 检查是否在待删除列表中
      const isDeleted = this.pendingDeletes.has(alias);

      const toggleContainer = enabledCell.createEl("div");
      const toggle = toggleContainer.createEl("input");
      toggle.type = "checkbox";
      toggle.checked = !isDeleted;
      toggle.addEventListener("change", async () => {
        if (!toggle.checked) {
          // 用户关闭 → 标记为待删除，5 秒后可撤销
          const timeout = setTimeout(async () => {
            this.pendingDeletes.delete(alias);
            const updated = removeAliasFromDictionary(
              await this.loadAliasDictionary(),
              alias
            );
            await this.updateAliasDictionary(updated);
            await refreshTable();
          }, 5000);

          this.pendingDeletes.set(alias, {
            entry: [alias, canonicals],
            timeout,
          });

          // 更新行显示
          row.style.opacity = "0.4";
          const undoBtn = enabledCell.createEl("button");
          undoBtn.textContent = "撤销";
          undoBtn.style.marginLeft = "4px";
          undoBtn.style.fontSize = "0.8em";
          undoBtn.addEventListener("click", async () => {
            clearTimeout(timeout);
            this.pendingDeletes.delete(alias);
            await refreshTable();
          });
        }
      });

      // 操作（删除按钮）
      const actionCell = row.createEl("td");
      actionCell.style.padding = "6px 8px";

      const deleteBtn = actionCell.createEl("button");
      deleteBtn.textContent = "删除";
      deleteBtn.style.fontSize = "0.85em";
      deleteBtn.addEventListener("click", async () => {
        const updated = removeAliasFromDictionary(
          await this.loadAliasDictionary(),
          alias
        );
        await this.updateAliasDictionary(updated);
        await refreshTable();
      });
    }
  }

  // ── 添加别名弹窗 ──

  private async showAddAliasModal(
    onSaved: () => Promise<void>
  ): Promise<void> {
    // 使用简单的 prompt 替代 Obsidian Modal（避免创建额外文件）
    // Obsidian 插件环境中可以使用 Modal，但这里用更简洁的方式
    const alias = prompt("错误说法（别名）：");
    if (!alias || alias.trim().length === 0) return;

    const canonical = prompt("正确说法（标准名）：");
    if (!canonical || canonical.trim().length === 0) return;

    const current = await this.loadAliasDictionary();
    const result = addAliasToDictionary(
      current,
      alias,
      canonical,
      true // 手动添加时总是允许
    );

    if (result.added) {
      await this.updateAliasDictionary(result.dictionary);
      await onSaved();
    } else {
      alert(`添加失败：${result.reason ?? "未知原因"}`);
    }
  }
}
