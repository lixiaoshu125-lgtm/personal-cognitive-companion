/**
 * Test helpers extracted from src/composition.ts.
 *
 * Provides in-memory fakes for VaultAdapter, MarkdownFileSystem, AiProvider,
 * plus createTestComposition for integration-style tests without real Obsidian.
 */
import type { VaultAdapter } from "../../src/vault/adapter";
import type { MarkdownFileSystem } from "../../src/storage/markdown";
import type { AiProvider, AiCompletionRequest } from "../../src/ai/provider";
import type { CompositionDependencies, CompositionRoot } from "../../src/composition";
import { createComposition } from "../../src/composition";
import { createDefaultPluginState } from "../../src/storage/plugin-state";

// ─── Memory Vault Adapter ──────────────────────────────────────

export class MemoryVaultAdapter implements VaultAdapter {
  constructor(
    private readonly files: Readonly<Record<string, string>> = {},
  ) {}

  async listFiles(): Promise<readonly { path: string }[]> {
    return Object.keys(this.files).map((path) => ({ path }));
  }

  async listDir(dirPath: string): Promise<readonly { path: string }[]> {
    const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
    return Object.keys(this.files)
      .filter((p) => p.startsWith(prefix))
      .map((p) => ({ path: p.slice(prefix.length) }));
  }

  async readText(path: string): Promise<string> {
    const content = this.files[path];
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }
}

// ─── Memory Markdown FileSystem ────────────────────────────────

export class MemoryMarkdownFs implements MarkdownFileSystem {
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

// ─── Silent AI Provider ────────────────────────────────────────

/**
 * A no-op AI provider that throws on any call.
 * Used as the default for tests that don't exercise AI calls.
 * Tests needing AI responses should inject their own fake.
 */
export class SilentAiProvider implements AiProvider {
  async complete<Output>(_request: AiCompletionRequest<Output>, _signal?: AbortSignal): Promise<Output> {
    throw new Error(
      "SilentAiProvider: no preset output. Inject a real or fake AI provider for this test.",
    );
  }
}

// ─── createTestComposition ────────────────────────────────────

export async function createTestComposition(
  overrides?: Partial<CompositionDependencies>,
): Promise<CompositionRoot> {
  let stored: unknown = null;

  const defaultSettings = createDefaultPluginState().settings;

  let counter = 0;

  const deps: CompositionDependencies = {
    vaultAdapter: new MemoryVaultAdapter(),
    loadData: async () => stored,
    saveData: async (data: unknown) => {
      stored = data;
    },
    markdownFs: new MemoryMarkdownFs(),
    settings: defaultSettings,
    idGenerator: {
      create(scope: string): string {
        counter += 1;
        return `test-id:${scope}:${counter}`;
      },
    },
    clock: () => new Date("2026-07-27T08:00:00.000Z"),
    aiProvider: new SilentAiProvider(),
    ...overrides,
  };

  const realRoot = await createComposition(deps);

  return {
    get pluginState() {
      return realRoot.pluginState;
    },
    get repository() {
      return realRoot.repository;
    },
    get aiProvider() {
      return realRoot.aiProvider;
    },
    get speechNormalizer() {
      return realRoot.speechNormalizer;
    },
    initialize: realRoot.initialize,
    shutdown: realRoot.shutdown,
    refreshSnapshot: realRoot.refreshSnapshot,
    getDashboardData: realRoot.getDashboardData,
    conversations: realRoot.conversations,
    markNotesCovered: realRoot.markNotesCovered,
    rebuildNoteIndex: realRoot.rebuildNoteIndex,
    ...(realRoot.weeklyPreparation !== undefined ? { weeklyPreparation: realRoot.weeklyPreparation } : {}),
  };
}
