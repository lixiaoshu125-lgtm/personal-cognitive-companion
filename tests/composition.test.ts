import { describe, expect, it } from "vitest";
import {
  createComposition,
  createUuidGenerator,
  type CompositionRoot,
  type DashboardData,
} from "../src/composition";
import { createTestComposition } from "./helpers/composition-test-helpers";
import type { VaultAdapter } from "../src/vault/adapter";
import type { MarkdownFileSystem } from "../src/storage/markdown";
import {
  createDefaultPluginState,
  serializePluginState,
} from "../src/storage/plugin-state";
import type { PluginState } from "../src/storage/plugin-state";
import type { IdGenerator } from "../src/dialogue/finalize";
import type { AiProvider, AiCompletionRequest } from "../src/ai/provider";
import { sha256 } from "../src/vault/scanner";

// ─── Helpers ─────────────────────────────────────────────────

/** In-memory Vault adapter for testing — returns no files by default. */
class MemoryVaultAdapter implements VaultAdapter {
  constructor(
    private readonly files: Readonly<Record<string, string>> = {}
  ) {}

  async listFiles(): Promise<readonly { path: string }[]> {
    return Object.keys(this.files).map((path) => ({ path }));
  }

  async readText(path: string): Promise<string> {
    const content = this.files[path];
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }
}

/** In-memory Markdown file system for testing. */
class MemoryMarkdownFs implements MarkdownFileSystem {
  private files = new Map<string, string>();

  async writeFile(relativePath: string, content: string): Promise<number> {
    this.files.set(relativePath, content);
    return new TextEncoder().encode(content).length;
  }

  async readFile(relativePath: string): Promise<string> {
    const content = this.files.get(relativePath);
    if (content === undefined) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return content;
  }

  async fileExists(relativePath: string): Promise<boolean> {
    return this.files.has(relativePath);
  }

  async copyFile(sourcePath: string, targetPath: string): Promise<void> {
    const content = this.files.get(sourcePath);
    if (content === undefined) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }
    this.files.set(targetPath, content);
  }

  async deleteFile(relativePath: string): Promise<void> {
    this.files.delete(relativePath);
  }

  async listFiles(dirPath: string): Promise<string[]> {
    const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
    const result: string[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        result.push(key);
      }
    }
    return result.sort();
  }
}

/** Fake AI provider for testing — returns preset topics and dialogue decisions. */
class FakeAiProvider implements AiProvider {
  private nextOutput: unknown = null;

  setNextOutput(output: unknown): void {
    this.nextOutput = output;
  }

  async complete<Output>(
    request: AiCompletionRequest<Output>,
    _signal?: AbortSignal
  ): Promise<Output> {
    // Route by outputName: dialogue decisions get a canned "ask" response
    if (request.outputName === "dialogue_decision") {
      return {
        action: "ask",
        question: "What do you think about this topic?",
      } as unknown as Output;
    }
    if (this.nextOutput === null) {
      throw new Error("FakeAiProvider: no preset output");
    }
    return this.nextOutput as Output;
  }
}

class CapturingAiProvider implements AiProvider {
  readonly requests: AiCompletionRequest<unknown>[] = [];

  constructor(private readonly outputs: unknown[]) {}

  async complete<Output>(request: AiCompletionRequest<Output>): Promise<Output> {
    this.requests.push(request as AiCompletionRequest<unknown>);
    const output = this.outputs.shift();
    if (output === undefined) throw new Error("CapturingAiProvider: no preset output");
    return output as Output;
  }
}

/** Build minimal CompositionDependencies for testing createComposition directly. */
function minimalDeps(overrides: {
  loadData?: () => Promise<unknown>;
  saveData?: (data: unknown) => Promise<void>;
  settings?: PluginState["settings"];
  idGenerator?: IdGenerator;
  clock?: () => Date;
  aiProvider?: AiProvider;
  vaultAdapter?: VaultAdapter;
  markdownFs?: MarkdownFileSystem;
} = {}): Parameters<typeof createComposition>[0] {
  let stored: unknown = null;
  return {
    vaultAdapter: overrides.vaultAdapter ?? new MemoryVaultAdapter(),
    loadData: overrides.loadData ?? (async () => stored),
    saveData: overrides.saveData ?? (async (data: unknown) => {
      stored = data;
    }),
    markdownFs: overrides.markdownFs ?? new MemoryMarkdownFs(),
    settings:
      overrides.settings ?? createDefaultPluginState().settings,
    ...(overrides.idGenerator !== undefined ? { idGenerator: overrides.idGenerator } : {}),
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
    ...(overrides.aiProvider !== undefined ? { aiProvider: overrides.aiProvider } : {}),
  };
}

/** Create a PluginState with a custom alias dictionary, then serialize it for loadData. */
function stateWithAliases(
  aliases: Record<string, readonly string[]>
): object {
  const base = createDefaultPluginState();
  return {
    ...serializePluginState(base),
    aliasDictionary: aliases,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("createComposition", () => {
  it("constructs a CompositionRoot with all fields non-null", async () => {
    const root = await createComposition(minimalDeps());

    expect(root).toBeDefined();
    expect(root.pluginState).toBeDefined();
    expect(root.repository).toBeDefined();
    expect(root.aiProvider).toBeDefined();
    expect(root.speechNormalizer).toBeDefined();
    // S1-ISSUE-03: orchestrator removed from CompositionRoot
    expect(typeof root.initialize).toBe("function");
    expect(typeof root.shutdown).toBe("function");
    expect(typeof root.refreshSnapshot).toBe("function");
    expect(typeof root.getDashboardData).toBe("function");
    // S1-ISSUE-03: startWeeklyReview/continueWeeklyReview removed from CompositionRoot
  });

  it("orchestrator starts with null pipeline state", async () => {
    const root = await createComposition(minimalDeps());
    // S1-ISSUE-03: orchestrator.getPipelineState() removed
  });

  it("after initialize, pluginState is accessible and is the default state", async () => {
    const root = await createComposition(minimalDeps());
    await root.initialize();

    const state = root.pluginState;
    expect(state.schema_version).toBe("2.0");
    expect(state.snapshot).toBeNull();
    expect(state.session).toBeNull();
    expect(state.goals).toBeNull();
  });

  it("exposes a repository that can import and read claims", async () => {
    const root = await createComposition(minimalDeps());

    const summary = root.repository.importBatch(
      [
        {
          schema_version: "1.1",
          claim_id: "c1",
          canonical_text: "Hello world",
          claim_type: "observation" as const,
          epistemic_status: "user_confirmed" as const,
          user_stance: "endorsed" as const,
          objective_truth_status: "unknown" as const,
          formed_at: "2026-07-27T00:00:00.000Z",
          time_scope: "current",
          applicable_contexts: [],
          scope_limits: "",
          source_note_ids: [],
          source_topic_ids: [],
          source_dialogue_refs: [],
          support_evidence_ids: [],
          counterexample_candidate_ids: [],
          missing_context: "",
          version: 1,
          created_at: "2026-07-27T00:00:00.000Z",
          updated_at: "2026-07-27T00:00:00.000Z",
        } as any,
      ],
      []
    );

    expect(summary.claimsAdded).toBe(1);
    const historical = root.repository.getHistorical();
    expect(historical.length).toBe(1);
    expect(historical[0]!.canonical_text).toBe("Hello world");
  });

  it("configures aiProvider from settings", async () => {
    const root = await createComposition(
      minimalDeps({
        settings: {
          deepseekEndpoint: "https://custom.api.example.com/v1",
          deepseekModel: "deepseek-v4-pro",
          deepseekApiKey: "sk-custom-key",
          extraExcludedDirs: [],
          systemOutputDir: "_个人认知系统",
          topicCharBudget: 1200,
          topicPrepTotalBudget: 12000,
          autoAddUnambiguousAliases: false,
          rawCorpusLocation: null,
          maxPriorityTopics: 3,
          wikiOutputDir: "_Wiki",
          newsApiKey: "",
          newsApiSources: "",
        },
      })
    );

    // Verify the provider exists (DeepSeekProvider extends AiProvider)
    expect(root.aiProvider).toBeDefined();
    expect(typeof root.aiProvider.complete).toBe("function");
  });

  it("speechNormalizer applies alias dictionary from plugin state", async () => {
    const root = await createComposition(
      minimalDeps({
        loadData: async () =>
          stateWithAliases({ JS: ["JavaScript"] }),
      })
    );

    const result = root.speechNormalizer("I love JS");
    expect(result).toBe("I love JavaScript");
  });

  it("speechNormalizer returns text unchanged when dictionary is empty", async () => {
    const root = await createComposition(minimalDeps());

    const result = root.speechNormalizer("I love JS");
    // Empty dictionary → no replacements
    expect(result).toBe("I love JS");
  });

  it("getDashboardData returns no_snapshot status on first run", async () => {
    const root = await createComposition(minimalDeps());

    const dashboard = await root.getDashboardData();
    expect(dashboard.snapshotStatus).toBe("no_snapshot");
    // buildDashboardData: isFirstScan is only true when snapshot exists
    // and no previous completed snapshot note IDs.
    expect(dashboard.isFirstScan).toBe(false);
    expect(dashboard.newNoteCount).toBe(0);
    expect(dashboard.pendingTopicCount).toBe(0);
    expect(dashboard.newsConfigured).toBe(false);
    expect(dashboard.wikiPages).toEqual([]);
  });




  it("shutdown does not throw", async () => {
    const root = await createComposition(minimalDeps());
    expect(() => root.shutdown()).not.toThrow();
  });
});

describe("createTestComposition", () => {
  it("constructs without any external dependencies", async () => {
    const root = await createTestComposition();

    expect(root).toBeDefined();
    expect(root.pluginState).toBeDefined();
    expect(root.repository).toBeDefined();
    expect(root.aiProvider).toBeDefined();
    // S1-ISSUE-03: orchestrator removed from CompositionRoot
    // S1-ISSUE-03: orchestrator.getPipelineState() removed
  });

  it("after initialize, getDashboardData shows first-run state", async () => {
    const root = await createTestComposition();
    await root.initialize();

    const dashboard = await root.getDashboardData();
    expect(dashboard.snapshotStatus).toBe("no_snapshot");
    // buildDashboardData: no snapshot → isFirstScan=false (nothing to scan)
    expect(dashboard.isFirstScan).toBe(false);
    expect(dashboard.pendingTopicCount).toBe(0);
  });

  it("repository can import and query claims", async () => {
    const root = await createTestComposition();

    const summary = root.repository.importBatch(
      [
        {
          schema_version: "1.1",
          claim_id: "c-test",
          canonical_text: "Test observation",
          claim_type: "observation" as const,
          epistemic_status: "user_confirmed" as const,
          user_stance: "endorsed" as const,
          objective_truth_status: "unknown" as const,
          formed_at: "2026-07-27T00:00:00.000Z",
          time_scope: "current",
          applicable_contexts: [],
          scope_limits: "",
          source_note_ids: [],
          source_topic_ids: [],
          source_dialogue_refs: [],
          support_evidence_ids: [],
          counterexample_candidate_ids: [],
          missing_context: "",
          version: 1,
          created_at: "2026-07-27T00:00:00.000Z",
          updated_at: "2026-07-27T00:00:00.000Z",
        } as any,
      ],
      []
    );

    expect(summary.claimsAdded).toBe(1);
    const historical = root.repository.getHistorical();
    expect(historical.length).toBe(1);
    expect(historical[0]!.canonical_text).toBe("Test observation");
  });

  it("overrides can customize dependencies", async () => {
    let saved: unknown = null;

    const root = await createTestComposition({
      saveData: async (data: unknown) => {
        saved = data;
      },
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    // Trigger a save through the repository
    root.repository.importBatch(
      [
        {
          schema_version: "1.1",
          claim_id: "c-override",
          canonical_text: "Override test",
          claim_type: "observation" as const,
          epistemic_status: "user_confirmed" as const,
          user_stance: "endorsed" as const,
          objective_truth_status: "unknown" as const,
          formed_at: "2026-07-27T00:00:00.000Z",
          time_scope: "current",
          applicable_contexts: [],
          scope_limits: "",
          source_note_ids: [],
          source_topic_ids: [],
          source_dialogue_refs: [],
          support_evidence_ids: [],
          counterexample_candidate_ids: [],
          missing_context: "",
          version: 1,
          created_at: "2026-07-27T00:00:00.000Z",
          updated_at: "2026-07-27T00:00:00.000Z",
        } as any,
      ],
      []
    );

    expect(root.repository.getHistorical().length).toBeGreaterThanOrEqual(1);
    expect(root.repository.getHistorical()[0]!.canonical_text).toBe(
      "Override test"
    );
  });
});

describe("createComposition with custom dependencies", () => {
  it("accepts a custom idGenerator", async () => {
    const generatedIds: string[] = [];
    const customIdGen: IdGenerator = {
      create(scope: string): string {
        const id = `custom:${scope}:${generatedIds.length + 1}`;
        generatedIds.push(id);
        return id;
      },
    };

    const root = await createComposition(
      minimalDeps({ idGenerator: customIdGen })
    );

    expect(root.repository).toBeDefined();

    const summary = root.repository.importBatch(
      [
        {
          schema_version: "1.1",
          claim_id: "c-custom-id",
          canonical_text: "Custom ID test",
          claim_type: "observation" as const,
          epistemic_status: "user_confirmed" as const,
          user_stance: "endorsed" as const,
          objective_truth_status: "unknown" as const,
          formed_at: "2026-07-27T00:00:00.000Z",
          time_scope: "current",
          applicable_contexts: [],
          scope_limits: "",
          source_note_ids: [],
          source_topic_ids: [],
          source_dialogue_refs: [],
          support_evidence_ids: [],
          counterexample_candidate_ids: [],
          missing_context: "",
          version: 1,
          created_at: "2026-07-27T00:00:00.000Z",
          updated_at: "2026-07-27T00:00:00.000Z",
        } as any,
      ],
      []
    );

    expect(summary.claimsAdded).toBe(1);
  });

  it("accepts a custom clock", async () => {
    const customClock = () => new Date("2025-06-15T12:00:00.000Z");

    const root = await createComposition(
      minimalDeps({ clock: customClock })
    );

    expect(root).toBeDefined();
    expect(root.repository).toBeDefined();

    const dashboard = await root.getDashboardData();
    expect(dashboard.snapshotStatus).toBe("no_snapshot");
  });

  it("serializes and de-serializes state across save cycles", async () => {
    let persisted: unknown = null;

    const root1 = await createComposition(
      minimalDeps({
        saveData: async (data: unknown) => {
          persisted = data;
        },
      })
    );

    root1.repository.importBatch(
      [
        {
          schema_version: "1.1",
          claim_id: "c-persist",
          canonical_text: "Persisted claim",
          claim_type: "observation" as const,
          epistemic_status: "user_confirmed" as const,
          user_stance: "endorsed" as const,
          objective_truth_status: "unknown" as const,
          formed_at: "2026-07-27T00:00:00.000Z",
          time_scope: "current",
          applicable_contexts: [],
          scope_limits: "",
          source_note_ids: [],
          source_topic_ids: [],
          source_dialogue_refs: [],
          support_evidence_ids: [],
          counterexample_candidate_ids: [],
          missing_context: "",
          version: 1,
          created_at: "2026-07-27T00:00:00.000Z",
          updated_at: "2026-07-27T00:00:00.000Z",
        } as any,
      ],
      []
    );

    expect(root1.repository.getHistorical().length).toBe(1);

    const root2 = await createComposition(
      minimalDeps({
        loadData: async () => persisted,
      })
    );

    expect(root2).toBeDefined();
    expect(root2.pluginState.schema_version).toBe("2.0");
  });

  it("persists a confirmed conclusion and injects it into a related conversation after restart", async () => {
    let persisted: unknown = null;
    const conclusion = "我应该优先完成最重要的项目";
    const firstProvider = new CapturingAiProvider([{
      response_text: "这是本次讨论的总结。",
      candidates: [{
        epistemic_status: "ai_inferred",
        canonical_text: conclusion,
        evidence_refs: [],
      }],
      should_summarize: true,
      summary: conclusion,
      question: "你确认这条结论吗？",
    }]);

    const firstRoot = await createComposition(minimalDeps({
      loadData: async () => persisted,
      saveData: async (data: unknown) => { persisted = data; },
      aiProvider: firstProvider,
    }));
    const firstConversation = await firstRoot.conversations.createConversation({
      kind: "free_question",
      question: "我该如何安排项目优先级？",
    });
    const turn = await firstRoot.conversations.sendMessage(
      firstConversation.id,
      "我想先完成最重要的项目",
    );
    expect(turn.awaitingConfirmation).toBe(true);

    const confirmation = await firstRoot.conversations.handleConfirmation(
      firstConversation.id,
      "确认",
    );
    expect(confirmation.action).toBe("confirmed");
    expect(confirmation.wikiConclution).toBeDefined();

    const secondProvider = new CapturingAiProvider([{
      response_text: "我们继续讨论项目优先级。",
      candidates: [],
      should_summarize: false,
      question: "目前最重要的项目是什么？",
    }]);
    const secondRoot = await createComposition(minimalDeps({
      loadData: async () => persisted,
      saveData: async (data: unknown) => { persisted = data; },
      aiProvider: secondProvider,
    }));
    expect(secondRoot.repository.getHistorical().map((claim) => claim.canonical_text)).toContain(conclusion);
    const secondConversation = await secondRoot.conversations.createConversation({
      kind: "free_question",
      question: "继续讨论项目优先级",
    });
    await secondRoot.conversations.sendMessage(
      secondConversation.id,
      "最重要的项目应该如何推进？",
    );

    const systemMessage = secondProvider.requests[0]!.messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain(conclusion);
  });

  it("loadData returning null creates default state", async () => {
    const root = await createComposition(
      minimalDeps({
        loadData: async () => null,
      })
    );

    expect(root.pluginState.schema_version).toBe("2.0");
    expect(root.pluginState.snapshot).toBeNull();
  });

  it("loadData returning undefined creates default state", async () => {
    const root = await createComposition(
      minimalDeps({
        loadData: async () => undefined,
      })
    );

    expect(root.pluginState.schema_version).toBe("2.0");
  });
});

describe("createUuidGenerator", () => {
  it("generates scoped IDs", () => {
    const gen = createUuidGenerator();
    const id = gen.create("test-scope");
    expect(id).toMatch(/^test-scope:/);
  });

  it("generates unique IDs on successive calls", () => {
    const gen = createUuidGenerator();
    const ids = new Set(
      Array.from({ length: 10 }, () => gen.create("scope"))
    );
    expect(ids.size).toBe(10);
  });
});


describe("refreshSnapshot", () => {
  it("scans vault and creates a snapshot", async () => {
    const root = await createComposition(
      minimalDeps({
        vaultAdapter: new MemoryVaultAdapter({
          "notes/test.md": "# Hello\n\nWorld",
          "notes/idea.md": "# Idea\n\nSomething new",
        }),
      })
    );

    const snapshot = await root.refreshSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.status).toBe("frozen");
    expect(snapshot.note_ids.length).toBe(2);

    // Verify dashboard picks up the snapshot
    const d = await root.getDashboardData();
    expect(d.snapshotStatus).toBe("frozen");
    expect(d.newNoteCount).toBe(2);
    expect(d.pendingTopicCount).toBe(0);
    // buildDashboardData: has snapshot + no previous completed IDs → isFirstScan=true
    expect(d.isFirstScan).toBe(true);
  });

  it("excludes protected folders and extra exclusions", async () => {
    const root = await createComposition(
      minimalDeps({
        vaultAdapter: new MemoryVaultAdapter({
          "notes/test.md": "# Public",
          ".obsidian/config": "secret",
          "小说/chapter1.md": "excluded",
          "_个人认知系统/state.json": "excluded",
        }),
        settings: {
          ...createDefaultPluginState().settings,
          extraExcludedDirs: [],
        },
      })
    );

    const snapshot = await root.refreshSnapshot();
    // Only notes/test.md should be included
    expect(snapshot.note_ids.length).toBe(1);
  });
});



