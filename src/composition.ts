import type { VaultAdapter } from "./vault/adapter";
import type { MarkdownFileSystem } from "./storage/markdown";
import type { PluginSettings, PluginState } from "./storage/plugin-state";
import {
  createDefaultPluginState,
  loadPluginState,
  freezePluginState,
  serializePluginState,
} from "./storage/plugin-state";
import { PluginCognitiveRepository } from "./storage/repository";
import type { AiProvider, AiCompletionRequest } from "./ai/provider";
import { DeepSeekProvider, type DeepSeekTransport } from "./ai/deepseek";
import { normalizeSpeech } from "./language/aliases";
import type { IdGenerator } from "./dialogue/finalize";
import type { WeeklySnapshot, Claim } from "./domain/types";
import { scanVault } from "./vault/scanner";
import { refreshSnapshot as rebuildSnapshot } from "./weekly/snapshot";
import { getWeekId } from "./weekly/orchestrator";
import { buildDashboardData } from "./ui/dashboard";
import type { ConversationComposition } from "./conversation/composition-conversation";
import { createConversationComposition } from "./conversation/composition-conversation";
import { ConversationEngine } from "./conversation/engine";
import type { CognitiveContext, CognitiveContextRequest, ActiveGoalSummary, PendingFeedbackSummary } from "./context/cognitive-context";
import { buildCognitiveContext } from "./context/cognitive-context";
import { createExcludeRules } from "./context/exclusion";
import { pruneCovered, markCovered } from "./coverage/note-coverage";
import { PluginDataConversationStore } from "./conversation/store";
import { createWeeklyPreparationService, type WeeklyPreparationService } from "./weekly/preparation-service";
import type { WeeklyPreparationStore } from "./weekly/preparation-store";
import { buildNoteIndex, type NoteIndex } from "./vault/note-index";

// ─── Dashboard Data ────────────────────────────────────────────

export interface WikiPageSummary {
  readonly path: string;
  readonly title: string;
  /** ISO date string from frontmatter, or empty if not available. */
  readonly created: string;
}

export interface DashboardData {
  readonly snapshotStatus:
    | "no_snapshot"
    | "frozen"
    | "active"
    | "paused"
    | "completed";
  readonly newNoteCount: number;
  readonly isFirstScan: boolean;
  /** Count of pending + snoozed topics ready for discussion. */
  readonly pendingTopicCount: number;
  /** Whether news API is configured (affects topic generation quality). */
  readonly newsConfigured: boolean;
  /** Recently generated Wiki pages (from _Wiki/ directory). */
  readonly wikiPages: readonly WikiPageSummary[];
}

// ─── Composition Dependencies ──────────────────────────────────

export interface CompositionDependencies {
  readonly vaultAdapter: VaultAdapter;
  readonly loadData: () => Promise<unknown>;
  readonly saveData: (data: unknown) => Promise<void>;
  readonly markdownFs: MarkdownFileSystem;
  readonly settings: PluginSettings;
  readonly idGenerator?: IdGenerator;
  readonly clock?: () => Date;
  /** Optional: inject an AI provider for testing. Falls back to DeepSeek. */
  readonly aiProvider?: AiProvider;
}

// ─── Composition Root ──────────────────────────────────────────

export interface CompositionRoot {
  readonly pluginState: PluginState;
  readonly repository: PluginCognitiveRepository;
  readonly aiProvider: AiProvider;
  readonly speechNormalizer: (text: string) => string;
  readonly initialize: () => Promise<void>;
  readonly shutdown: () => void;
  readonly refreshSnapshot: () => Promise<WeeklySnapshot>;
  readonly getDashboardData: () => Promise<DashboardData>;

  /** Conversation-first composition (Task 07). Fully wired — non-optional. */
  readonly conversations: ConversationComposition;

  /** Weekly preparation service (Task 08). */
  readonly weeklyPreparation?: WeeklyPreparationService;

  /** Mark note IDs as covered in the coverage tracker (Phase 10). */
  readonly markNotesCovered: (noteIds: readonly string[]) => Promise<void>;

  /** Rebuild the vault note index (Phase 11). Call after major note changes. */
  readonly rebuildNoteIndex: (
    onProgress?: (current: number, total: number, path: string) => void,
  ) => Promise<NoteIndex>;
}

// ─── UUID Generator ────────────────────────────────────────────

export function createUuidGenerator(): IdGenerator {
  return {
    create(scope: string): string {
      if (
        typeof crypto !== "undefined" &&
        typeof (crypto as { randomUUID?: () => string }).randomUUID ===
          "function"
      ) {
        return `${scope}:${(crypto as { randomUUID: () => string }).randomUUID()}`;
      }
      // Fallback: simple UUID v4 generation for environments without crypto
      const hex = "0123456789abcdef";
      const segments = [8, 4, 4, 4, 12];
      const uuid = segments
        .map((len) =>
          Array.from({ length: len }, () =>
            hex[Math.floor(Math.random() * 16)]
          ).join("")
        )
        .join("-");
      return `${scope}:${uuid}`;
    },
  };
}

// ─── Default Fetch Transport ───────────────────────────────────

function createFetchTransport(): DeepSeekTransport {
  return async (request) => {
    const init: RequestInit = {
      method: "POST",
      headers: { ...request.headers } as Record<string, string>,
      body: JSON.stringify(request.body),
    };
    if (request.signal !== undefined) {
      init.signal = request.signal;
    }
    const response = await fetch(request.url, init);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    return { status: response.status, body };
  };
}

// ─── createComposition ─────────────────────────────────────────

export async function createComposition(
  deps: CompositionDependencies
): Promise<CompositionRoot> {
  // Step 1: Load state from persistent storage
  const rawData = await deps.loadData();
  let pluginState = freezePluginState(loadPluginState(rawData));

  // Step 2: Create IdGenerator (use injected or default UUID v4)
  const idGenerator = deps.idGenerator ?? createUuidGenerator();
  const _clock = deps.clock ?? (() => new Date());

  // Step 3: Create PluginCognitiveRepository
  // The repository reads/writes pluginState via the loadState/saveState callbacks.
  // When saveState is invoked, we update the closure's pluginState reference
  // so that getDashboardData() and speechNormalizer always read fresh data.
  const repository = new PluginCognitiveRepository({
    loadState: () => pluginState,
    saveState: async (state: PluginState) => {
      pluginState = freezePluginState(state);
      await deps.saveData(serializePluginState(pluginState));
    },
    idGenerator,
  });

  // Step 4: Create AI provider from settings (or injected override)
  const aiProvider: AiProvider =
    deps.aiProvider ??
    new DeepSeekProvider({
      endpoint: deps.settings.deepseekEndpoint,
      apiKey: deps.settings.deepseekApiKey,
      model: deps.settings.deepseekModel,
      transport: createFetchTransport(),
    });

  // Step 5: Build speech normalizer (reads aliasDictionary from latest pluginState)
  const speechNormalizer = (text: string): string =>
    normalizeSpeech(text, pluginState.aliasDictionary);

  // ── Closure state ────────────────────────────────────────────

  // noteId (sha256) → vault path, populated during refreshSnapshot
  let noteIdToPath = new Map<string, string>();

  // Track previous completed snapshot's note IDs for incremental counts
  let lastCompletedSnapshotNoteIds: string[] = [];

  // Cache wiki page list, refreshed during refreshSnapshot
  let cachedWikiPages: WikiPageSummary[] = [];

  // ── Wiki page scanner ────────────────────────────────────────

  /**
   * Fallback when filesystem scan fails to find wiki pages.
   * Returns empty — the workaround for vault.adapter.list() not seeing
   * externally-created files on some platforms is no longer needed.
   */
  function getFallbackWikiPages(): WikiPageSummary[] {
    return [];
  }

  async function scanWikiPages(): Promise<WikiPageSummary[]> {
    const wikiDir = deps.settings.wikiOutputDir.replace(/^\/+|\/+$/g, "");
    if (!wikiDir) return [];

    let files: readonly { path: string }[];
    try {
      // Use listDir to scan ONLY the wiki directory — much faster and
      // avoids path-matching issues with listFiles() on Windows
      files = await deps.vaultAdapter.listDir(wikiDir);
    } catch {
      // Directory might not exist yet — return empty
      return [];
    }

    const pages: WikiPageSummary[] = [];
    for (const file of files) {
      if (!/\.md$/iu.test(file.path)) continue;
      // Skip PCC readme placeholder
      if (file.path.endsWith("/.pcc-readme.md") || file.path === ".pcc-readme.md") continue;

      let content: string;
      try {
        // Build full path: wikiDir + "/" + filename
        const fullPath = wikiDir + "/" + file.path;
        content = await deps.vaultAdapter.readText(fullPath);
      } catch {
        continue;
      }

      let title = file.path.replace(/\.md$/i, "");
      let created = "";
      const fmMatch = content.match(/^---\s*\n(.*?)\n---/s);
      if (fmMatch?.[1]) {
        const fm = fmMatch[1];
        const titleMatch = fm.match(/^(?:title|topic):\s*(.+)$/m);
        if (titleMatch?.[1]) title = titleMatch[1].trim().replace(/^["']|["']$/g, "");
        const dateMatch = fm.match(/^(?:created|date):\s*(.+)$/m);
        if (dateMatch?.[1]) created = dateMatch[1].trim();
      }

      pages.push({ path: wikiDir + "/" + file.path, title, created });
    }

    pages.sort((a, b) => b.path.localeCompare(a.path, "en"));
    return pages.slice(0, 10);
  }

  // ── Step 5.5: Migrate old-format topics ─────────────────────

  function needsMigration(): boolean {
    const topics = pluginState.weeklyPreparation?.topics ?? [];
    return topics.some((t) => /^topic-\d{3}$/.test(t.topic_id));
  }

  async function migrateOldTopics(): Promise<void> {
    const wpState = pluginState.weeklyPreparation;
    if (!wpState) return;

    const oldTopics = wpState.topics;
    const now = _clock().toISOString();
    const weekId = getWeekId(_clock());
    let seq = 0;

    const migrated = oldTopics.map((t) => {
      // Generate new-format ID
      const newId = `topic:${t.created_week_id ?? weekId}:${(seq++).toString(36)}:${Math.floor(Math.random() * 46656).toString(36)}`;
      // Fix stuck in_progress topics: if no valid conversation, mark as discussed
      let newStatus = t.status;
      if (t.status === "in_progress" && !t.conversation_id) {
        newStatus = "discussed" as typeof t.status;
      }
      return {
        ...t,
        topic_id: newId,
        status: newStatus,
        last_status_change: now,
      };
    });

    const newWpState = { ...wpState, topics: migrated };
    pluginState = freezePluginState({ ...pluginState, weeklyPreparation: newWpState });
    await deps.saveData(serializePluginState(pluginState));

    console.log(`[PCC] Migrated ${migrated.length} topics from old format to new format.`);
  }

  // ── Note Index Builder ──────────────────────────────────────

  async function buildAndPersistNoteIndex(
    onProgress?: (current: number, total: number, path: string) => void,
  ): Promise<NoteIndex> {
    const sysOutputDir = deps.settings.systemOutputDir.replace(/^\/+|\/+$/g, "");
    const wikiDir = deps.settings.wikiOutputDir.replace(/^\/+|\/+$/g, "");

    const index = await buildNoteIndex(deps.vaultAdapter, {
      excludedPaths: [
        // Exclude system/PCC output dirs from index
        ...([".obsidian", ".trash", ".git", sysOutputDir, wikiDir]
          .filter(Boolean)
          .map((d) => `${d}/`)),
      ],
      onProgress,
    });

    // Persist immediately
    pluginState = freezePluginState({ ...pluginState, noteIndex: index });
    await deps.saveData(serializePluginState(pluginState));

    return index;
  }

  // ── Step 6: initialize ──────────────────────────────────────

  async function initialize(): Promise<void> {
    // Migrate old-format topics if needed (before anything else)
    if (needsMigration()) {
      await migrateOldTopics();
    }

    // Ensure output directories exist (writeFile auto-creates parent dirs now)
    for (const dir of [deps.settings.systemOutputDir, deps.settings.wikiOutputDir]) {
      if (dir) {
        const normalized = dir.replace(/^\/+|\/+$/g, "");
        try {
          await deps.markdownFs.writeFile(
            `${normalized}/.pcc-readme.md`,
            `# PCC 系统输出目录\n此目录由个人认知伴侣插件自动管理。\n`,
          );
        } catch {
          // Non-critical — directory creation can fail gracefully
        }
      }
    }

    // Note index is built lazily (on first "刷新话题" click) to avoid
    // blocking plugin startup with 7000+ file reads. Until then, context
    // search falls back to empty results (graceful degradation).

    // Scan wiki pages on startup
    cachedWikiPages = await scanWikiPages();
  }

  // ── getDashboardData (using buildDashboardData) ─────────────

  async function getDashboardData(): Promise<DashboardData> {
    const topics = pluginState.weeklyPreparation?.topics ?? [];
    const pendingCount = topics.filter(
      (t) => t.status === "pending" || t.status === "snoozed" || t.status === "in_progress",
    ).length;

    // Always rescan wikis so dashboard stays in sync with filesystem
    try {
      cachedWikiPages = await scanWikiPages();
    } catch (err) {
      console.error("[PCC] Wiki scan failed:", err);
    }
    // Fallback: if filesystem scan returns empty (e.g. on Windows where
    // adapter.list may miss externally-created files), hardcode known pages
    if (cachedWikiPages.length === 0) {
      cachedWikiPages = getFallbackWikiPages();
    }

    return buildDashboardData({
      snapshot: pluginState.snapshot,
      previousCompletedNoteIds:
        lastCompletedSnapshotNoteIds.length > 0
          ? lastCompletedSnapshotNoteIds
          : undefined,
      pendingTopicCount: pendingCount,
      newsConfigured: true,
      wikiPages: cachedWikiPages,
    });
  }

  // ── refreshSnapshot ─────────────────────────────────────────

  async function doRefreshSnapshot(): Promise<WeeklySnapshot> {
    const notes = await scanVault(
      deps.vaultAdapter,
      deps.settings.extraExcludedDirs
    );

    // Update noteId → path mapping for readNoteBody
    noteIdToPath.clear();
    for (const note of notes) {
      noteIdToPath.set(note.id, note.path);
    }

    const snapshot = rebuildSnapshot(notes, pluginState.snapshot, _clock());

    // Prune coverage state: remove IDs of deleted notes
    const prunedCoverage = pruneCovered(pluginState.noteCoverage, snapshot.note_ids);

    // Update pluginState and persist
    pluginState = freezePluginState({ ...pluginState, snapshot, noteCoverage: prunedCoverage });
    await deps.saveData(serializePluginState(pluginState));

    // Refresh wiki page cache
    cachedWikiPages = await scanWikiPages();

    return snapshot;
  }

  // ── shutdown ──────────────────────────────────────────────────

  function shutdown(): void {
    // No persistent resources to clean up yet.
    // Future: abort pending AI requests, close file handles, etc.
  }

  // ── Assemble ──────────────────────────────────────────────────

  // ── Conversation-first wiring (Task 07/10) ─────────────────

  // ConversationStore: PluginData-backed, survives Obsidian restart
  const conversationStore = new PluginDataConversationStore(
    () => pluginState,
    async (state) => {
      pluginState = freezePluginState(state);
      await deps.saveData(serializePluginState(pluginState));
    },
  );

  const excludeRules = createExcludeRules([...deps.settings.extraExcludedDirs]);
  const cognitiveContextService = {
    async buildContext(request: CognitiveContextRequest): Promise<CognitiveContext> {
      return buildCognitiveContext(
        request,
        deps.vaultAdapter,
        excludeRules,
        pluginState.noteIndex,
        deps.settings.wikiOutputDir,
      );
    },
  };

  // ConversationEngine — wiki generation is handled by the composition layer
  const conversationEngine = new ConversationEngine(aiProvider, { now: _clock });

  // ConversationComposition
  const conversations: ConversationComposition = createConversationComposition({
    store: conversationStore,
    engine: conversationEngine,
    contextService: cognitiveContextService,
    // goalIntegration and validationIntegration default to no-ops in createConversationComposition
    aiProvider,
    clock: _clock,
    markdownFs: deps.markdownFs,
    wikiOutputDir: deps.settings.wikiOutputDir,
    onWikiGenerated: async (newPage?: WikiPageSummary) => {
      // If caller provides the new page details, add directly (avoids
      // filesystem scan issues on Windows)
      if (newPage) {
        cachedWikiPages = [newPage, ...cachedWikiPages].slice(0, 10);
      } else {
        cachedWikiPages = await scanWikiPages();
      }
      if (cachedWikiPages.length === 0) {
        cachedWikiPages = getFallbackWikiPages();
      }
    },
  });

  // ── Weekly Preparation wiring (Task 08/10) ───────────────────

  // WeeklyPreparationStore backed by unified PluginState (NOT direct data.json manipulation)
  const weeklyPreparationStore: WeeklyPreparationStore = {
    async save(state) {
      pluginState = freezePluginState({ ...pluginState, weeklyPreparation: state });
      await deps.saveData(serializePluginState(pluginState));
    },
    async load() {
      return pluginState.weeklyPreparation ?? null;
    },
    async updateTopic(topicId, update) {
      const wpState = pluginState.weeklyPreparation;
      if (!wpState) throw new Error(`Cannot update topic: no state loaded. Topic: ${topicId}`);
      const index = wpState.topics.findIndex((t) => t.topic_id === topicId);
      if (index === -1) throw new Error(`Topic not found: ${topicId}`);
      const existing = wpState.topics[index]!;
      const updated = { ...existing, ...update, topic_id: existing.topic_id } as import("./weekly/preparation-service").PreparedTopic;
      const newTopics = [...wpState.topics];
      newTopics[index] = updated;
      const newWpState = { ...wpState, topics: newTopics };
      pluginState = freezePluginState({ ...pluginState, weeklyPreparation: newWpState });
      await deps.saveData(serializePluginState(pluginState));
      return updated;
    },
  };

  let weeklyPreparation: WeeklyPreparationService | undefined;
  try {
    weeklyPreparation = await createWeeklyPreparationService({
      vaultAdapter: deps.vaultAdapter,
      aiProvider,
      store: weeklyPreparationStore,
      excludedDirs: [...deps.settings.extraExcludedDirs],
      maxTopics: deps.settings.maxPriorityTopics,
      clock: _clock,
      newsApiKey: deps.settings.newsApiKey,
      newsApiSources: deps.settings.newsApiSources,
    });
  } catch {
    // WeeklyPreparation creation failure is non-fatal:
    // it requires a working store; if data is corrupt, leave undefined
  }

  // ── Coverage tracking (Phase 10) ──────────────────────────────

  async function doMarkNotesCovered(noteIds: readonly string[]): Promise<void> {
    if (noteIds.length === 0) return;
    const updated = markCovered(pluginState.noteCoverage, noteIds, _clock());
    pluginState = freezePluginState({ ...pluginState, noteCoverage: updated });
    await deps.saveData(serializePluginState(pluginState));
  }

  // ── Root ──────────────────────────────────────────────────────

  const root: CompositionRoot = {
    get pluginState() {
      return pluginState;
    },
    repository,
    aiProvider,
    speechNormalizer,
    initialize,
    shutdown,
    getDashboardData,
    refreshSnapshot: doRefreshSnapshot,
    conversations,
    markNotesCovered: doMarkNotesCovered,
    rebuildNoteIndex: buildAndPersistNoteIndex,
    ...(weeklyPreparation !== undefined ? { weeklyPreparation } : {}),
  } as CompositionRoot;

  return root;
}
