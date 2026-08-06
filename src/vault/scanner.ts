import type { VaultAdapter } from "./adapter";

export interface NoteRef {
  readonly id: string;
  readonly path: string;
  readonly content_hash: string;
}

export const PROTECTED_VAULT_FOLDERS = [
  ".obsidian",
  "小说",
  "_个人认知系统"
] as const;

export class VaultScanError extends Error {
  constructor(path?: string) {
    super(path === undefined ? "Unable to scan Vault files" : `Unable to read Vault note: ${path}`);
    this.name = "VaultScanError";
  }
}

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

export function sha256(value: string): string {
  const input = new TextEncoder().encode(value);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const words = new Uint32Array(64);
  const view = paddedView;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15]!;
      const word2 = words[index - 2]!;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sum1 + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
  }

  return `sha256:${Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("")}`;
}

export function normalizeVaultPath(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new VaultScanError();
  }
  return segments.join("/");
}

function isWithinFolder(path: string, folder: string): boolean {
  const comparablePath = path.toLowerCase();
  const comparableFolder = folder.toLowerCase();
  return comparablePath === comparableFolder || comparablePath.startsWith(`${comparableFolder}/`);
}

function normalizedExclusions(exclusions: readonly string[]): readonly string[] {
  return [...PROTECTED_VAULT_FOLDERS, ...exclusions]
    .map(normalizeVaultPath)
    .filter((path) => path.length > 0);
}

/**
 * Check whether a note should be excluded from scanning based on its
 * YAML frontmatter.  Looks for `cc-exclude: true` (or `"true"`) inside
 * the frontmatter block delimited by `---`.
 *
 * Rules (in priority order):
 * - `cc-exclude: true`  → excluded
 * - `cc-exclude: "true"` → excluded
 * - Any other value (`false`, `0`, absent) → NOT excluded
 * - No frontmatter → NOT excluded
 * - Malformed frontmatter (no closing `---`) → NOT excluded
 *
 * No YAML library is used — pure string matching, zero dependencies.
 */
export function isNoteExcluded(content: string): boolean {
  // Normalise line endings so we only deal with \n
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  // Must start with "---\n" to have frontmatter
  if (!normalized.startsWith("---\n")) return false;

  // Find the closing "---" on its own line
  const lines = normalized.split("\n");
  // lines[0] === "---" (the opening delimiter)
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      fmEnd = i;
      break;
    }
  }

  // No closing delimiter → malformed → don't exclude
  if (fmEnd === -1) return false;

  // Extract frontmatter body (lines between the two "---" markers)
  const fmBody = lines.slice(1, fmEnd).join("\n");

  // Match cc-exclude: true or cc-exclude: "true" on its own line
  return /^cc-exclude:\s*(true|"true")\s*$/m.test(fmBody);
}

export async function scanVault(
  adapter: VaultAdapter,
  exclusions: readonly string[] = [],
  onProgress?: (progress: VaultScanProgress) => void,
): Promise<NoteRef[]> {
  let files;
  try {
    files = await adapter.listFiles();
  } catch {
    throw new VaultScanError();
  }

  const excludedFolders = normalizedExclusions(exclusions);
  const candidates = files
    .map((file) => ({ sourcePath: file.path, path: normalizeVaultPath(file.path) }))
    .filter(({ path }) => /\.md$/iu.test(path))
    .filter(({ path }) => !excludedFolders.some((folder) => isWithinFolder(path, folder)))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));

  const notes: NoteRef[] = [];
  for (const [index, candidate] of candidates.entries()) {
    onProgress?.({
      current: index + 1,
      total: candidates.length,
      path: candidate.path,
    });
    let body: string;
    try {
      body = await adapter.readText(candidate.sourcePath);
    } catch {
      throw new VaultScanError(candidate.path);
    }
    if (isNoteExcluded(body)) continue;
    notes.push(Object.freeze({
      id: sha256(candidate.path),
      path: candidate.path,
      content_hash: sha256(body)
    }));
  }
  return notes;
}

export interface VaultScanProgress {
  readonly current: number;
  readonly total: number;
  readonly path: string;
}
