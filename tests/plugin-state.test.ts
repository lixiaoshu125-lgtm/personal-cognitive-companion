import { describe, expect, it } from "vitest";
import {
  createDefaultPluginState,
  freezePluginState,
  loadPluginState,
  pluginSettingsSchema,
  serializePluginState,
} from "../src/storage/plugin-state";
import type { PluginState } from "../src/storage/plugin-state";

// ─── Helpers ─────────────────────────────────────────────────

function validPluginStateData(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema_version: "2.0",
    settings: {
      deepseekEndpoint: "https://api.deepseek.com/v1",
      deepseekModel: "deepseek-v4-pro",
      deepseekApiKey: "sk-test-key",
      extraExcludedDirs: ["node_modules"],
      systemOutputDir: "_个人认知系统",
      topicCharBudget: 800,
      topicPrepTotalBudget: 8000,
      autoAddUnambiguousAliases: true,
      rawCorpusLocation: "/some/path",
      maxPriorityTopics: 5,
      wikiOutputDir: "_Wiki",
      newsApiKey: "",
      newsApiSources: "",
    },
    snapshot: null,
    session: null,
    goals: null,
    validations: [],
    modelImportMetadata: null,
    corpusPath: null,
    aliasDictionary: {},
    idempotencyPointers: {
      lastCommitKey: null,
      lastZeroResultKeys: {},
      committedKeys: {},
    },
    claims: {},
    modelEvents: {},
    sealedTurns: {},
    operationRefs: {},
    zeroResults: {},
    turnRequests: {},
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("createDefaultPluginState", () => {
  it("returns a complete default state with all fields non-null/non-undefined", () => {
    const state = createDefaultPluginState();

    expect(state.schema_version).toBe("2.0");
    expect(state.settings).toBeDefined();
    expect(state.snapshot).toBeNull();
    expect(state.session).toBeNull();
    expect(state.goals).toBeNull();
    expect(state.validations).toEqual([]);
    expect(state.modelImportMetadata).toBeNull();
    expect(state.corpusPath).toBeNull();
    expect(state.aliasDictionary).toEqual({});
    expect(state.idempotencyPointers).toBeDefined();
    expect(state.idempotencyPointers.lastCommitKey).toBeNull();
    expect(state.idempotencyPointers.lastZeroResultKeys).toEqual({});
    expect(state.idempotencyPointers.committedKeys).toEqual({});

    expect(state.claims).toEqual({});
    expect(state.modelEvents).toEqual({});
    expect(state.sealedTurns).toEqual({});
    expect(state.operationRefs).toEqual({});
    expect(state.zeroResults).toEqual({});
    expect(state.turnRequests).toEqual({});

    // No field should be undefined
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("undefined");
  });

  it("returns default settings matching the specification table", () => {
    const settings = createDefaultPluginState().settings;

    expect(settings.deepseekEndpoint).toBe("https://api.deepseek.com/v1");
    expect(settings.deepseekModel).toBe("deepseek-v4-pro");
    expect(settings.deepseekApiKey).toBe("");
    expect(settings.extraExcludedDirs).toEqual([]);
    expect(settings.systemOutputDir).toBe("_个人认知系统");
    expect(settings.topicCharBudget).toBe(1200);
    expect(settings.topicPrepTotalBudget).toBe(12000);
    expect(settings.autoAddUnambiguousAliases).toBe(false);
    expect(settings.rawCorpusLocation).toBeNull();
    expect(settings.maxPriorityTopics).toBe(3);
    expect(settings.maxPriorityTopics).toBe(5);
    expect(settings.wikiOutputDir).toBe("_Wiki");
  });

  it("returns a deeply frozen object", () => {
    const state = createDefaultPluginState();

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.settings)).toBe(true);
    expect(Object.isFrozen(state.validations)).toBe(true);
    expect(Object.isFrozen(state.idempotencyPointers)).toBe(true);
    expect(Object.isFrozen(state.idempotencyPointers.lastZeroResultKeys)).toBe(true);
  });
});

describe("pluginSettingsSchema", () => {
  it("fills all defaults when parsing an empty object", () => {
    const parsed = pluginSettingsSchema.parse({});

    expect(parsed.deepseekEndpoint).toBe("https://api.deepseek.com/v1");
    expect(parsed.deepseekModel).toBe("deepseek-v4-pro");
    expect(parsed.deepseekApiKey).toBe("");
    expect(parsed.extraExcludedDirs).toEqual([]);
    expect(parsed.systemOutputDir).toBe("_个人认知系统");
    expect(parsed.topicCharBudget).toBe(1200);
    expect(parsed.topicPrepTotalBudget).toBe(12000);
    expect(parsed.autoAddUnambiguousAliases).toBe(false);
    expect(parsed.rawCorpusLocation).toBeNull();
    expect(parsed.maxPriorityTopics).toBe(3);
    expect(parsed.maxPriorityTopics).toBe(5);
    expect(parsed.wikiOutputDir).toBe("_Wiki");
  });

  it("accepts partial overrides", () => {
    const parsed = pluginSettingsSchema.parse({
      deepseekEndpoint: "https://custom.api/v1",
      topicCharBudget: 500,
    });

    expect(parsed.deepseekEndpoint).toBe("https://custom.api/v1");
    expect(parsed.topicCharBudget).toBe(500);
    // Other fields should still have defaults
    expect(parsed.deepseekModel).toBe("deepseek-v4-pro");
    expect(parsed.maxPriorityTopics).toBe(3);
  });
});

describe("loadPluginState", () => {
  it("returns default state when data is null", () => {
    const state = loadPluginState(null);
    expect(state).toEqual(createDefaultPluginState());
  });

  it("returns default state when data is undefined", () => {
    const state = loadPluginState(undefined);
    expect(state).toEqual(createDefaultPluginState());
  });

  it("correctly parses valid data with non-default settings", () => {
    const data = validPluginStateData();
    const state = loadPluginState(data);

    expect(state.schema_version).toBe("2.0");
    expect(state.settings.deepseekEndpoint).toBe("https://api.deepseek.com/v1");
    expect(state.settings.deepseekApiKey).toBe("sk-test-key");
    expect(state.settings.topicCharBudget).toBe(800);
    expect(state.settings.maxPriorityTopics).toBe(5);
    expect(state.snapshot).toBeNull();
    expect(state.session).toBeNull();
    expect(state.goals).toBeNull();
  });

  it("throws on invalid data (Zod validation failure)", () => {
    expect(() => loadPluginState({ schema_version: "2.0" }))
      .toThrow(/validation failed/i);

    expect(() => loadPluginState({ schema_version: "2.0", settings: null }))
      .toThrow(/validation failed/i);

    expect(() => loadPluginState({
      schema_version: "2.0",
      settings: { topicCharBudget: "not-a-number" },
    })).toThrow(/validation failed/i);
  });

  it("throws a descriptive error on wrong schema version", () => {
    expect(() =>
      loadPluginState({ ...validPluginStateData(), schema_version: "1.0" })
    ).toThrow(/version mismatch.*expected "2\.0".*got "1\.0"/i);

    expect(() =>
      loadPluginState({ ...validPluginStateData(), schema_version: "3.0" })
    ).toThrow(/version mismatch.*expected "2\.0".*got "3\.0"/i);

    // Missing schema_version entirely
    expect(() =>
      loadPluginState({ settings: validPluginStateData().settings })
    ).toThrow(/validation failed/i);
  });

  it("returns a deeply frozen state", () => {
    const state = loadPluginState(validPluginStateData());

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.settings)).toBe(true);
    expect(Object.isFrozen(state.idempotencyPointers)).toBe(true);
  });
});

describe("serializePluginState", () => {
  it("round-trips through loadPluginState preserving equality", () => {
    const original = loadPluginState(validPluginStateData());
    const serialized = serializePluginState(original);
    const reloaded = loadPluginState(serialized);

    // Compare structured clones (strip freeze) for deep equality
    expect(structuredClone(original)).toEqual(structuredClone(reloaded));
  });

  it("output contains no undefined values", () => {
    const state = createDefaultPluginState();
    const serialized = serializePluginState(state);
    const json = JSON.stringify(serialized);

    expect(json).not.toContain("undefined");

    // Verify it's valid JSON
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("preserves the API key in serialized output", () => {
    const defaultSettings = validPluginStateData().settings as Record<string, unknown>;
    const data = validPluginStateData({
      settings: {
        ...defaultSettings,
        deepseekApiKey: "sk-my-secret-key",
      },
    });
    const state = loadPluginState(data);
    const serialized = serializePluginState(state);

    const json = JSON.stringify(serialized);
    expect(json).toContain("sk-my-secret-key");
  });

  it("handles null snapshot/session/goals correctly", () => {
    const state = createDefaultPluginState();
    const serialized = serializePluginState(state) as Record<string, unknown>;

    expect(serialized.snapshot).toBeNull();
    expect(serialized.session).toBeNull();
    expect(serialized.goals).toBeNull();
  });

  it("returns a plain mutable object (not frozen, not readonly-wrapped)", () => {
    const state = createDefaultPluginState();
    const serialized = serializePluginState(state);

    // Should be a plain object, not frozen
    expect(Object.isFrozen(serialized)).toBe(false);

    // Should be assignable (mutable)
    const obj = serialized as Record<string, unknown>;
    expect(() => {
      obj._test = "mutable";
    }).not.toThrow();
  });
});

describe("freezePluginState", () => {
  it("returns a deeply frozen object whose nested properties throw on mutation", () => {
    const state = createDefaultPluginState();
    const frozen = freezePluginState(state);

    expect(Object.isFrozen(frozen)).toBe(true);

    // Top-level mutation should throw in strict mode
    expect(() => {
      (frozen as unknown as Record<string, unknown>).corpusPath = "/hack";
    }).toThrow();

    // Nested object mutation should throw
    expect(() => {
      (frozen.settings as unknown as Record<string, unknown>).topicCharBudget = 99999;
    }).toThrow();

    // Nested array mutation should throw
    expect(() => {
      (frozen.validations as unknown[]).push({});
    }).toThrow();
  });

  it("produces a state that equals the input (structural equality)", () => {
    const state = createDefaultPluginState();
    const frozen = freezePluginState(state);

    // structuredClone strips freeze wrappers for comparison
    expect(structuredClone(frozen)).toEqual(structuredClone(state));
  });

  it("freezes the idempotency pointers record", () => {
    const state = createDefaultPluginState();
    const frozen = freezePluginState(state);

    expect(Object.isFrozen(frozen.idempotencyPointers)).toBe(true);
    expect(Object.isFrozen(frozen.idempotencyPointers.lastZeroResultKeys)).toBe(true);
  });

  it("freezes the alias dictionary", () => {
    const state = createDefaultPluginState();
    const frozen = freezePluginState(state);

    expect(Object.isFrozen(frozen.aliasDictionary)).toBe(true);
  });
});

describe("integration: full lifecycle", () => {
  it("default → serialize → load → modify → serialize produces correct state", () => {
    // Start with default
    const defaultState = createDefaultPluginState();

    // Simulate user changing settings via the settings UI
    const data = validPluginStateData({
      settings: {
        deepseekEndpoint: "https://custom.endpoint/v1",
        deepseekModel: "deepseek-v4-pro",
        deepseekApiKey: "sk-custom-key",
        extraExcludedDirs: ["private/"],
        systemOutputDir: "_认知系统",
        topicCharBudget: 2000,
        topicPrepTotalBudget: 20000,
        autoAddUnambiguousAliases: true,
        rawCorpusLocation: null,
        maxPriorityTopics: 4,
        wikiOutputDir: "_认知系统",
        newsApiKey: "",
        newsApiSources: "",
      },
    });

    const loaded = loadPluginState(data);

    // Settings should reflect the custom data
    expect(loaded.settings.deepseekEndpoint).toBe("https://custom.endpoint/v1");
    expect(loaded.settings.deepseekModel).toBe("deepseek-v4-pro");
    expect(loaded.settings.deepseekApiKey).toBe("sk-custom-key");

    // Serialize and reload
    const serialized = serializePluginState(loaded);
    const reloaded = loadPluginState(serialized);

    expect(structuredClone(reloaded.settings)).toEqual(structuredClone(loaded.settings));
  });

  it("preserves modelImportMetadata through round-trip", () => {
    const data = validPluginStateData({
      modelImportMetadata: {
        importedAt: "2026-07-26T12:00:00.000Z",
        sourcePath: "/models/v1.1/cognitive-model.jsonl",
        claimsCount: 150,
        eventsCount: 200,
        sourceFormat: "jsonl",
      },
    });

    const state = loadPluginState(data);
    expect(state.modelImportMetadata).not.toBeNull();
    expect(state.modelImportMetadata!.claimsCount).toBe(150);
    expect(state.modelImportMetadata!.sourceFormat).toBe("jsonl");

    const serialized = serializePluginState(state);
    const reloaded = loadPluginState(serialized);

    expect(reloaded.modelImportMetadata).toEqual(state.modelImportMetadata);
  });

  it("preserves idempotency pointers through round-trip", () => {
    const data = validPluginStateData({
      idempotencyPointers: {
        lastCommitKey: "commit-abc-123",
        lastZeroResultKeys: {
          "sess1\ttopicA\t0": "zero-key-1",
          "sess1\ttopicB\t2": "zero-key-2",
        },
        committedKeys: { "commit-abc-123": true as const },
      },
    });

    const state = loadPluginState(data);
    expect(state.idempotencyPointers.lastCommitKey).toBe("commit-abc-123");
    expect(
      state.idempotencyPointers.lastZeroResultKeys["sess1\ttopicA\t0"]
    ).toBe("zero-key-1");

    const serialized = serializePluginState(state);
    const reloaded = loadPluginState(serialized);

    expect(reloaded.idempotencyPointers).toEqual(
      state.idempotencyPointers
    );
  });
});
