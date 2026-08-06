export interface VaultFile {
  readonly path: string;
}

/** Read-only boundary used by the scanner. Implementations must not mutate source files. */
export interface VaultAdapter {
  /** List all .md files in the vault (recursive). */
  listFiles(): Promise<readonly VaultFile[]>;
  /** List all files directly in a directory (non-recursive). Returns paths relative to vault root. */
  listDir(dirPath: string): Promise<readonly VaultFile[]>;
  readText(path: string): Promise<string>;
}
