// Vitest configuration for obsidian-cognitive-companion
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: resolve(__dirname, "tests/__mocks__/obsidian.ts"),
    },
  },
});
