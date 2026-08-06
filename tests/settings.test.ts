import { describe, expect, it } from "vitest";
import {
  validateEndpoint,
  maskApiKey,
  validateOutputDir,
  validateNumericSetting,
  addAliasToDictionary,
  removeAliasFromDictionary,
  mergeAliasDictionaries,
} from "../src/settings";
import type { SpeechAliasDictionary } from "../src/language/aliases";

// ─── validateEndpoint ───────────────────────────────────────

describe("validateEndpoint", () => {
  it("accepts valid HTTPS URL", () => {
    expect(validateEndpoint("https://api.deepseek.com/v1")).toEqual({
      valid: true,
    });
  });

  it("accepts valid HTTP URL", () => {
    expect(validateEndpoint("http://localhost:8080/api")).toEqual({
      valid: true,
    });
  });

  it("accepts URL with port and path", () => {
    expect(validateEndpoint("https://example.com:3000/v1/chat")).toEqual({
      valid: true,
    });
  });

  it("rejects empty string", () => {
    const result = validateEndpoint("");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects URL without protocol", () => {
    const result = validateEndpoint("api.deepseek.com/v1");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects URL with spaces", () => {
    const result = validateEndpoint("https://api .example.com");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects random string that is not a URL", () => {
    const result = validateEndpoint("not-a-url");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("trims whitespace before validation", () => {
    expect(validateEndpoint("  https://api.deepseek.com/v1  ")).toEqual({
      valid: true,
    });
  });

  it("rejects ftp protocol", () => {
    const result = validateEndpoint("ftp://files.example.com");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ─── maskApiKey ─────────────────────────────────────────────

describe("maskApiKey", () => {
  it("masks a typical long API key", () => {
    const key = "sk-1234567890abcdefghij"; // 23 chars
    const masked = maskApiKey(key);
    // 前4: "sk-1", 后4: "ghij", 中间 maskLen = max(8, 23-8) = 15 个*
    expect(masked.length).toBe(23);
    expect(masked.startsWith("sk-1")).toBe(true);
    expect(masked.endsWith("ghij")).toBe(true);
    const middle = masked.slice(4, -4);
    expect(middle).toBe("*".repeat(middle.length));
    expect(middle.length).toBeGreaterThanOrEqual(8);
    expect(middle.length).toBe(15);
  });

  it("masks key shorter than 8 characters completely", () => {
    expect(maskApiKey("abc")).toBe("***");
    expect(maskApiKey("1234567")).toBe("*******");
  });

  it("returns empty string for empty key", () => {
    expect(maskApiKey("")).toBe("");
  });

  it("handles exactly 8 character key", () => {
    const masked = maskApiKey("12345678");
    // 8位: 前4 "1234", 后4 "5678", 中间至少8个* → "1234********5678"
    expect(masked).toBe("1234********5678");
    expect(masked.startsWith("1234")).toBe(true);
    expect(masked.endsWith("5678")).toBe(true);
    const middle = masked.slice(4, -4);
    expect(middle.length).toBeGreaterThanOrEqual(8);
  });

  it("handles 9 character key", () => {
    const masked = maskApiKey("123456789");
    // 9位: 前4 "1234", 后4 "6789", 中间至少8个* → "1234********6789"
    expect(masked).toBe("1234********6789");
    expect(masked.startsWith("1234")).toBe(true);
    expect(masked.endsWith("6789")).toBe(true);
  });

  it("handles key with exactly 16 characters", () => {
    const key = "abcdefghijklmnop"; // 16 chars
    const masked = maskApiKey(key);
    expect(masked).toBe("abcd********mnop");
    expect(masked.startsWith("abcd")).toBe(true);
    expect(masked.endsWith("mnop")).toBe(true);
    // 16 - 8 = 8 mask chars
    expect(masked).toBe("abcd********mnop");
  });

  it("handles very long key with many mask characters", () => {
    const key = "sk-" + "a".repeat(40); // 43 chars
    const masked = maskApiKey(key);
    expect(masked.startsWith("sk-a")).toBe(true);
    expect(masked.endsWith("aaaa")).toBe(true);
    const middle = masked.slice(4, -4);
    expect(middle.length).toBe(43 - 8); // 35 mask chars
    expect(middle).toBe("*".repeat(35));
  });
});

// ─── validateOutputDir ──────────────────────────────────────

describe("validateOutputDir", () => {
  it("accepts valid simple directory name", () => {
    expect(validateOutputDir("_个人认知系统")).toEqual({ valid: true });
  });

  it("accepts alphanumeric directory name", () => {
    expect(validateOutputDir("my_notes_2026")).toEqual({ valid: true });
  });

  it("rejects empty string", () => {
    const result = validateOutputDir("");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects whitespace-only string", () => {
    const result = validateOutputDir("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects directory name containing ..", () => {
    const result = validateOutputDir("foo..bar");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects exact .. ", () => {
    const result = validateOutputDir("..");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects directory name containing /", () => {
    const result = validateOutputDir("foo/bar");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects directory name containing \\", () => {
    const result = validateOutputDir("foo\\bar");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects directory name starting with .", () => {
    const result = validateOutputDir(".hidden");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects / as directory (root)", () => {
    const result = validateOutputDir("/");
    expect(result.valid).toBe(false);
  });

  it("rejects \\ as directory (root)", () => {
    const result = validateOutputDir("\\");
    expect(result.valid).toBe(false);
  });

  it("trims whitespace before validation", () => {
    expect(validateOutputDir("  my_dir  ")).toEqual({ valid: true });
  });
});

// ─── validateNumericSetting ─────────────────────────────────

describe("validateNumericSetting", () => {
  it("accepts value within range", () => {
    expect(validateNumericSetting(500, 200, 5000, "字符预算")).toEqual({
      valid: true,
    });
  });

  it("accepts value at minimum boundary", () => {
    expect(validateNumericSetting(200, 200, 5000, "字符预算")).toEqual({
      valid: true,
    });
  });

  it("accepts value at maximum boundary", () => {
    expect(validateNumericSetting(5000, 200, 5000, "字符预算")).toEqual({
      valid: true,
    });
  });

  it("rejects value below minimum", () => {
    const result = validateNumericSetting(100, 200, 5000, "字符预算");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("不能小于");
  });

  it("rejects value above maximum", () => {
    const result = validateNumericSetting(6000, 200, 5000, "字符预算");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("不能大于");
  });

  it("rejects non-integer value", () => {
    const result = validateNumericSetting(500.5, 200, 5000, "字符预算");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("整数");
  });

  it("rejects NaN", () => {
    const result = validateNumericSetting(NaN, 200, 5000, "字符预算");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("有效数字");
  });

  it("rejects Infinity", () => {
    const result = validateNumericSetting(Infinity, 200, 5000, "字符预算");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("有效数字");
  });

  it("includes the label in error message", () => {
    const result = validateNumericSetting(0, 1, 10, "优先主题数");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("优先主题数");
  });
});

// ─── addAliasToDictionary ───────────────────────────────────

describe("addAliasToDictionary", () => {
  const emptyDict: SpeechAliasDictionary = {};

  it("adds a new alias when autoAddUnambiguous is true", () => {
    const result = addAliasToDictionary(emptyDict, "魔都", "上海", true);
    expect(result.added).toBe(true);
    expect(result.dictionary).toHaveProperty("魔都");
    expect(result.dictionary["魔都"]).toEqual(["上海"]);
  });

  it("skips when autoAddUnambiguous is false", () => {
    const dict: SpeechAliasDictionary = { "帝都": ["北京"] };
    const result = addAliasToDictionary(dict, "魔都", "上海", false);
    expect(result.added).toBe(false);
    expect(result.reason).toContain("未开启");
    expect(result.dictionary).toBe(dict);
  });

  it("skips when alias already exists", () => {
    const dict: SpeechAliasDictionary = { "魔都": ["上海"] };
    const result = addAliasToDictionary(dict, "魔都", "上海", true);
    expect(result.added).toBe(false);
    expect(result.reason).toContain("已存在");
    expect(result.dictionary).toBe(dict);
  });

  it("skips when alias is empty after trim", () => {
    const result = addAliasToDictionary(emptyDict, "   ", "上海", true);
    expect(result.added).toBe(false);
    expect(result.reason).toContain("不能为空");
    expect(result.dictionary).toBe(emptyDict);
  });

  it("skips when canonical is empty after trim", () => {
    const result = addAliasToDictionary(emptyDict, "魔都", "", true);
    expect(result.added).toBe(false);
    expect(result.reason).toContain("不能为空");
    expect(result.dictionary).toBe(emptyDict);
  });

  it("delegates to addUnambiguousAlias for ambiguity detection", () => {
    // "北平" maps to multiple canonicals → ambiguous, can't add related alias
    const dict: SpeechAliasDictionary = { "北平": ["北京", "北京大学"] };
    const result = addAliasToDictionary(dict, "帝都", "北京", true);
    // addUnambiguousAlias will reject because "北京" is in an ambiguous entry
    expect(result.added).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("trims and normalizes inputs", () => {
    const result = addAliasToDictionary(emptyDict, "  魔都  ", " 上海 ", true);
    expect(result.added).toBe(true);
    expect(result.dictionary).toHaveProperty("魔都");
    expect(result.dictionary["魔都"]).toEqual(["上海"]);
  });
});

// ─── removeAliasFromDictionary ──────────────────────────────

describe("removeAliasFromDictionary", () => {
  const dict: SpeechAliasDictionary = {
    "帝都": ["北京"],
    "魔都": ["上海"],
    "妖都": ["广州"],
  };

  it("removes an existing alias", () => {
    const result = removeAliasFromDictionary(dict, "魔都");
    expect(result).not.toHaveProperty("魔都");
    expect(result).toHaveProperty("帝都");
    expect(result).toHaveProperty("妖都");
  });

  it("returns same dictionary when alias not found (idempotent)", () => {
    const result = removeAliasFromDictionary(dict, "不存在");
    expect(result).toBe(dict); // same reference — no change
  });

  it("trims input before matching", () => {
    const result = removeAliasFromDictionary(dict, "  帝都  ");
    expect(result).not.toHaveProperty("帝都");
    expect(result).toHaveProperty("魔都");
    expect(result).toHaveProperty("妖都");
  });

  it("returns same dictionary for empty alias input", () => {
    const result = removeAliasFromDictionary(dict, "");
    expect(result).toBe(dict);
  });

  it("returns empty dict when removing the only entry", () => {
    const single: SpeechAliasDictionary = { "帝都": ["北京"] };
    const result = removeAliasFromDictionary(single, "帝都");
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ─── mergeAliasDictionaries ─────────────────────────────────

describe("mergeAliasDictionaries", () => {
  const existing: SpeechAliasDictionary = {
    "帝都": ["北京"],
    "魔都": ["上海"],
  };

  it("merges non-conflicting entries", () => {
    const imported: SpeechAliasDictionary = {
      "妖都": ["广州"],
      "旧都": ["南京"],
    };
    const result = mergeAliasDictionaries(existing, imported);
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.dictionary).toHaveProperty("帝都");
    expect(result.dictionary).toHaveProperty("魔都");
    expect(result.dictionary).toHaveProperty("妖都");
    expect(result.dictionary).toHaveProperty("旧都");
  });

  it("skips conflicting entries and counts them", () => {
    const imported: SpeechAliasDictionary = {
      "帝都": ["北京"], // conflict — same key
      "妖都": ["广州"], // new
    };
    const result = mergeAliasDictionaries(existing, imported);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.dictionary).toHaveProperty("妖都");
    // 帝都 should still have original value
    expect(result.dictionary["帝都"]).toEqual(["北京"]);
  });

  it("returns zero added/skipped for empty import", () => {
    const result = mergeAliasDictionaries(existing, {});
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(Object.keys(result.dictionary)).toHaveLength(
      Object.keys(existing).length
    );
  });

  it("merges into empty existing dictionary", () => {
    const imported: SpeechAliasDictionary = {
      "帝都": ["北京"],
      "魔都": ["上海"],
    };
    const result = mergeAliasDictionaries({}, imported);
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.dictionary).toEqual(imported);
  });

  it("detects conflicts after trim and normalization", () => {
    const imported: SpeechAliasDictionary = {
      "  帝都  ": ["北京"], // trim → "帝都", same as existing key
      "妖都": ["广州"],
    };
    const result = mergeAliasDictionaries(existing, imported);
    expect(result.skipped).toBe(1);
    expect(result.added).toBe(1);
  });

  it("correctly reports all skipped when all conflict", () => {
    const imported: SpeechAliasDictionary = {
      "帝都": ["北京"], // same
      "魔都": ["上海"], // same
    };
    const result = mergeAliasDictionaries(existing, imported);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(2);
    expect(Object.keys(result.dictionary)).toHaveLength(
      Object.keys(existing).length
    );
  });
});
