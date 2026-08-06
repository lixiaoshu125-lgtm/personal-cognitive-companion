import { describe, expect, it } from "vitest";
import type { VaultAdapter, VaultFile } from "../src/vault/adapter";
import { isNoteExcluded, scanVault, VaultScanError } from "../src/vault/scanner";

class MemoryVaultAdapter implements VaultAdapter {
  readonly readPaths: string[] = [];

  constructor(
    private readonly files: Readonly<Record<string, string>>,
    private readonly failingPaths: readonly string[] = []
  ) {}

  async listFiles(): Promise<readonly VaultFile[]> {
    return Object.keys(this.files).map((path) => ({ path }));
  }

  async readText(path: string): Promise<string> {
    this.readPaths.push(path);
    const body = this.files[path];
    if (this.failingPaths.includes(path)) {
      throw new Error(`provider leaked: ${body}`);
    }
    if (body === undefined) throw new Error("missing synthetic file");
    return body;
  }
}

describe("scanVault", () => {
  it("scans only Markdown outside protected and configured output folders", async () => {
    const adapter = new MemoryVaultAdapter({
      "notes/keep.md": "keep",
      "notes/uppercase.MD": "also keep",
      "notes/ignore.txt": "not markdown",
      ".obsidian/plugins/example/settings.md": "protected",
      "小说/chapter.md": "protected",
      "_个人认知系统/generated.md": "protected",
      "plugin-output/cache.md": "configured output"
    });

    const notes = await scanVault(adapter, ["plugin-output"]);

    expect(notes.map((note) => note.path)).toEqual(["notes/keep.md", "notes/uppercase.MD"]);
  });

  it("normalizes paths and derives stable SHA-256 ids and content hashes", async () => {
    const adapter = new MemoryVaultAdapter({ "notes\\alpha.md": "alpha body" });

    const first = await scanVault(adapter);
    const second = await scanVault(adapter);

    expect(first).toEqual(second);
    expect(first).toEqual([{
      id: "sha256:9e4b4aaecba0bd22e3efb92dba583a1f598439ca6f005bdcd6bd573d3286336a",
      path: "notes/alpha.md",
      content_hash: "sha256:8be52585779d628b1925d0b8494cc568aa1be5f51542f07862c6a0e9a9b60b80"
    }]);
  });

  it("excludes Windows-style folder names case-insensitively without reading their bodies", async () => {
    const protectedPaths = [
      ".OBSIDIAN\\plugins\\example\\settings.md",
      "Plugin-Output\\cache.md"
    ];
    const adapter = new MemoryVaultAdapter({
      [protectedPaths[0]!]: "must never be read one",
      [protectedPaths[1]!]: "must never be read two",
      "Notes\\Kept.MD": "safe synthetic body"
    }, protectedPaths);

    const notes = await scanVault(adapter, ["plugin-output"]);

    expect(notes.map((note) => note.path)).toEqual(["Notes/Kept.MD"]);
    expect(adapter.readPaths).toEqual(["Notes\\Kept.MD"]);
  });

  it("never includes a note body or provider error details in scan errors", async () => {
    const secretBody = "SYNTHETIC_PRIVATE_BODY_7429";
    const adapter = new MemoryVaultAdapter({ "notes/private.md": secretBody }, ["notes/private.md"]);

    const error = await scanVault(adapter).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VaultScanError);
    expect(String(error)).toContain("notes/private.md");
    expect(String(error)).not.toContain(secretBody);
    expect(String(error)).not.toContain("provider leaked");
  });

  it("skips notes with cc-exclude: true and includes non-excluded notes", async () => {
    const adapter = new MemoryVaultAdapter({
      "notes/keep.md": "# Public\npublic content",
      "notes/excluded.md": [
        "---",
        "cc-exclude: true",
        "---",
        "",
        "# Private",
        "secret thoughts",
      ].join("\n"),
      "notes/excluded-quoted.md": [
        "---",
        'cc-exclude: "true"',
        "---",
        "",
        "also secret",
      ].join("\n"),
      "notes/not-excluded-false.md": [
        "---",
        "cc-exclude: false",
        "---",
        "",
        "visible content",
      ].join("\n"),
    });

    const notes = await scanVault(adapter);

    expect(notes.map((n) => n.path)).toEqual([
      "notes/keep.md",
      "notes/not-excluded-false.md",
    ]);
  });

  it("reports ordered Markdown scan progress without exposing note bodies", async () => {
    const firstBody = "SYNTHETIC_PRIVATE_ALPHA_9041";
    const secondBody = "SYNTHETIC_PRIVATE_BETA_9042";
    const adapter = new MemoryVaultAdapter({
      "notes/beta.md": secondBody,
      "notes/ignore.txt": "not scanned",
      "notes/alpha.md": firstBody,
      ".obsidian/private.md": "protected",
    });
    const progress: Array<{ current: number; total: number; path: string }> = [];

    await scanVault(adapter, [], (event) => progress.push(event));

    expect(progress).toEqual([
      { current: 1, total: 2, path: "notes/alpha.md" },
      { current: 2, total: 2, path: "notes/beta.md" },
    ]);
    expect(JSON.stringify(progress)).not.toContain(firstBody);
    expect(JSON.stringify(progress)).not.toContain(secondBody);
  });
});

describe("isNoteExcluded", () => {
  it("returns false for content without frontmatter", () => {
    expect(isNoteExcluded("# Just a note\n\nSome content.")).toBe(false);
    expect(isNoteExcluded("")).toBe(false);
    expect(isNoteExcluded("not frontmatter\n---\nstill not")).toBe(false);
  });

  it("returns false for frontmatter without cc-exclude", () => {
    const content = [
      "---",
      "title: My Note",
      "tags: [personal, journal]",
      "---",
      "",
      "# Body",
    ].join("\n");
    expect(isNoteExcluded(content)).toBe(false);
  });

  it("returns true for cc-exclude: true", () => {
    const content = [
      "---",
      "cc-exclude: true",
      "---",
      "",
      "private content",
    ].join("\n");
    expect(isNoteExcluded(content)).toBe(true);
  });

  it("returns true for cc-exclude: \"true\" (quoted)", () => {
    const content = [
      "---",
      'cc-exclude: "true"',
      "---",
      "",
      "private content",
    ].join("\n");
    expect(isNoteExcluded(content)).toBe(true);
  });

  it("returns false for cc-exclude: false", () => {
    const content = [
      "---",
      "cc-exclude: false",
      "---",
      "",
      "public content",
    ].join("\n");
    expect(isNoteExcluded(content)).toBe(false);
  });

  it("returns false for frontmatter with other fields but no cc-exclude", () => {
    const content = [
      "---",
      "title: Diary",
      "date: 2026-07-27",
      "mood: contemplative",
      "---",
      "",
      "Today I thought about...",
    ].join("\n");
    expect(isNoteExcluded(content)).toBe(false);
  });

  it("returns false for malformed frontmatter (no closing ---)", () => {
    const content = [
      "---",
      "cc-exclude: true",
      "",
      "# This looks like frontmatter but never closes",
    ].join("\n");
    expect(isNoteExcluded(content)).toBe(false);
  });

  it("returns false when cc-exclude appears in body text, not frontmatter", () => {
    const content = [
      "---",
      "title: Public Note",
      "---",
      "",
      "Here is some text.",
      "cc-exclude: true  <-- this is in the body, not frontmatter",
    ].join("\n");
    expect(isNoteExcluded(content)).toBe(false);
  });
});
