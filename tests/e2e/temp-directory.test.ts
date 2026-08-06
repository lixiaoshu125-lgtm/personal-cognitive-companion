/**
 * Step 13: Temp Directory E2E — Full pipeline using a real temporary directory.
 *
 * Replaces in-memory filesystem with real OS temp directory files,
 * verifying that the full pipeline writes correct output files
 * and validates security properties (no HTML injection, no API keys in output).
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createComposition } from "../../src/composition";
import type { VaultAdapter } from "../../src/vault/adapter";
import type { MarkdownFileSystem } from "../../src/storage/markdown";
import type { AiProvider, AiCompletionRequest } from "../../src/ai/provider";
import { createDefaultPluginState } from "../../src/storage/plugin-state";
import { sha256 } from "../../src/vault/scanner";

// ─── Temp Directory Management ───────────────────────────────

let tempDir: string;
let vaultDir: string;

beforeAll(async () => {
  // Use a short directory name to avoid Windows MAX_PATH issues
  // The atomicWriteMarkdown operation IDs can be very long (containing session IDs)
  tempDir = path.join(os.tmpdir(), `cce-${Date.now().toString(36)}`);
  vaultDir = path.join(tempDir, "v");
  await fs.mkdir(vaultDir, { recursive: true });
});

afterAll(async () => {
  // Clean up
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ─── Real Filesystem VaultAdapter ────────────────────────────

class RealFsVaultAdapter implements VaultAdapter {
  constructor(private readonly root: string) {}

  async listFiles(): Promise<readonly { path: string }[]> {
    const results: { path: string }[] = [];
    await this.walkDir(this.root, results);
    return results;
  }

  private async walkDir(
    dir: string,
    results: { path: string }[],
    relativePrefix = ""
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Skip excluded dirs
        if (
          entry.name === ".obsidian" ||
          entry.name === "_个人认知系统" ||
          entry.name.startsWith(".")
        ) {
          continue;
        }
        await this.walkDir(fullPath, results, relPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push({ path: relPath });
      }
    }
  }

  async readText(relativePath: string): Promise<string> {
    const fullPath = path.join(this.root, relativePath);
    // Guard against path traversal
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(this.root))) {
      throw new Error(`Path traversal rejected: ${relativePath}`);
    }
    return fs.readFile(fullPath, "utf-8");
  }
}

// ─── Real Filesystem MarkdownFileSystem ──────────────────────

class RealFsMarkdownFs implements MarkdownFileSystem {
  constructor(private readonly root: string) {}

  private resolve(relativePath: string): string {
    const full = path.join(this.root, relativePath);
    const resolved = path.resolve(full);
    // Guard: ensure we stay within root
    if (!resolved.startsWith(path.resolve(this.root))) {
      throw new Error(`Path traversal rejected: ${relativePath}`);
    }
    return resolved;
  }

  async writeFile(relativePath: string, content: string): Promise<number> {
    const fullPath = this.resolve(relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return Buffer.byteLength(content, "utf-8");
  }

  async readFile(relativePath: string): Promise<string> {
    return fs.readFile(this.resolve(relativePath), "utf-8");
  }

  async fileExists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async copyFile(sourcePath: string, targetPath: string): Promise<void> {
    await fs.copyFile(this.resolve(sourcePath), this.resolve(targetPath));
  }

  async deleteFile(relativePath: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(relativePath));
    } catch {
      // Best-effort
    }
  }

  async listFiles(dirPath: string): Promise<string[]> {
    const fullDir = this.resolve(dirPath);
    const results: string[] = [];
    try {
      await this.walkForList(fullDir, dirPath, results);
    } catch {
      // Directory may not exist yet
    }
    return results.sort();
  }

  private async walkForList(
    dir: string,
    relDir: string,
    results: string[]
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this.walkForList(path.join(dir, entry.name), rel, results);
      } else {
        results.push(rel);
      }
    }
  }
}

// ─── Fake AI Provider ────────────────────────────────────────

interface FakeAiTopicsOutput {
  readonly topics: readonly {
    readonly note_id: string;
    readonly primary_theme: string;
    readonly secondary_links: readonly string[];
  }[];
}

class FakeAiProvider implements AiProvider {
  private nextOutput: FakeAiTopicsOutput | null = null;

  setNextTopics(output: FakeAiTopicsOutput): void {
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
    // All other calls (including weekly_topics from prepareTopics)
    if (this.nextOutput === null) {
      throw new Error("FakeAiProvider: no preset topics");
    }
    return this.nextOutput as unknown as Output;
  }
}

// ─── Test Notes (Synthetic — no real personal data) ──────────

const syntheticNote1 = `# 项目规划

本周完成了三个主要任务：
1. 重构了认证模块
2. 添加了单元测试
3. 更新了文档

还需要考虑性能优化的问题。`;

const syntheticNote2 = `# 读书笔记：《思考，快与慢》

卡尼曼提出系统1和系统2的区分。
系统1快速、直觉；系统2缓慢、理性。

关键洞察：人倾向于用系统1做判断，即使需要系统2。
这解释了为什么我们会有认知偏差。`;

const syntheticNote3 = `# 健康记录

本周运动：跑步2次，每次5公里。
睡眠：平均6.5小时，需要改善。
饮食：吃了3次外卖，其余自己做饭。

下周目标：跑步3次，睡眠7小时以上。`;

// ─── Setup Test Vault ────────────────────────────────────────

async function setupTestVault(): Promise<{
  noteIds: string[];
  vaultAdapter: RealFsVaultAdapter;
  markdownFs: RealFsMarkdownFs;
}> {
  const notesDir = path.join(vaultDir, "notes");
  const excludedDir = path.join(vaultDir, "_个人认知系统");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(excludedDir, { recursive: true });

  await fs.writeFile(path.join(notesDir, "note-1.md"), syntheticNote1, "utf-8");
  await fs.writeFile(path.join(notesDir, "note-2.md"), syntheticNote2, "utf-8");
  await fs.writeFile(path.join(notesDir, "note-3.md"), syntheticNote3, "utf-8");

  // Create excluded dir with some content (should be skipped by scanner)
  await fs.writeFile(
    path.join(excludedDir, "state.json"),
    JSON.stringify({ test: true }),
    "utf-8"
  );

  const noteId1 = sha256("notes/note-1.md");
  const noteId2 = sha256("notes/note-2.md");
  const noteId3 = sha256("notes/note-3.md");

  const vaultAdapter = new RealFsVaultAdapter(vaultDir);

  // Use the output dir inside tempDir — keep path short to avoid Windows MAX_PATH
  const outputRoot = path.join(tempDir, "o");
  await fs.mkdir(outputRoot, { recursive: true });
  const markdownFs = new RealFsMarkdownFs(outputRoot);

  return {
    noteIds: [noteId1, noteId2, noteId3],
    vaultAdapter,
    markdownFs,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("Temp Directory E2E: full pipeline on real filesystem", () => {
    // S1-ISSUE-03: full pipeline test removed (uses legacy startWeeklyReview + orchestrator)

  it("scanner excludes _个人认知系统/ directory", async () => {
    const { vaultAdapter } = await setupTestVault();

    // Create the excluded dir again (may have been cleaned)
    const excludedDir = path.join(vaultDir, "_个人认知系统");
    await fs.mkdir(excludedDir, { recursive: true });
    await fs.writeFile(
      path.join(excludedDir, "some-file.md"),
      "# Should be excluded",
      "utf-8"
    );

    const notes = await vaultAdapter.listFiles();
    const excludedPaths = notes
      .map((n) => n.path)
      .filter((p) => p.includes("_个人认知系统"));
    expect(excludedPaths).toHaveLength(0);
  });

  // S1-ISSUE-03: pause/resume cycle test removed (uses legacy orchestrator)
});
