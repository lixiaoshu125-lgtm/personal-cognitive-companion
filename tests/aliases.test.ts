import { describe, expect, it } from "vitest";
import { addAliasSuggestion, addUnambiguousAlias, normalizeSpeech, type SpeechAliasDictionary } from "../src/language/aliases";

describe("speech aliases", () => {
  const dictionary: SpeechAliasDictionary = {
    "帝都": ["北京"],
    "北平": ["北京", "北京大学"],
    "北大": ["北京大学"],
    "北京大学": ["北京大学"]
  };

  it("normalizes unique aliases deterministically using longest matches", () => {
    expect(normalizeSpeech("北大在帝都，北大很好。", dictionary)).toBe("北京大学在北京，北京大学很好。");
    expect(normalizeSpeech("北大在帝都，北大很好。", dictionary)).toBe("北京大学在北京，北京大学很好。");
  });

  it("refuses ambiguous aliases while normalizing unambiguous neighbors", () => {
    expect(normalizeSpeech("北平和北大", dictionary)).toBe("北平和北京大学");
  });

  it("auto-adds only explicit unambiguous suggestions and preserves ambiguous candidates", () => {
    const clearDictionary = { "帝都": ["北京"] };
    expect(addAliasSuggestion(clearDictionary, { alias: "京城", canonical: "北京", explicit: true, alternatives: [] })["京城"])
      .toEqual(["北京"]);
    expect(addAliasSuggestion(dictionary, { alias: "京", canonical: "北京", explicit: false, alternatives: [] })).toBe(dictionary);
    expect(addAliasSuggestion(dictionary, { alias: "京", canonical: "北京", explicit: true, alternatives: ["南京"] })).toBe(dictionary);
  });

  it("does not replace Latin aliases inside alphanumeric words", () => {
    const latin = { cat: ["猫"] };
    expect(normalizeSpeech("cat concatenate cat2 2cat cat!", latin)).toBe("猫 concatenate cat2 2cat 猫!");
  });

  it("avoids Chinese aliases inside obvious longer names while accepting spoken and punctuated words", () => {
    const chinese = { "北大": ["北京大学"] };
    expect(normalizeSpeech("我爱北大，报考北大，北大毕业；北大荒不替换。", chinese))
      .toBe("我爱北京大学，报考北京大学，北京大学毕业；北大荒不替换。");
  });

  it("normalizes non-Han aliases beside Han sentence context", () => {
    const aliases = { "obz点": ["Obsidian"], "北大2": ["北京大学二校区"], "北大_版": ["北京大学版"] };
    expect(normalizeSpeech("打开obz点插件，我用obz点记录，我去北大2看看，使用北大_版记录。", aliases))
      .toBe("打开Obsidian插件，我用Obsidian记录，我去北京大学二校区看看，使用北京大学版记录。");
  });

  it("does not replace mixed-script aliases embedded next to Latin letters, numbers, or underscores", () => {
    const mixed = { "obz点": ["Obsidian"] };
    expect(normalizeSpeech("xxobz点yy myobz点_版id obz点tool 2obz点 obz点_", mixed))
      .toBe("xxobz点yy myobz点_版id obz点tool 2obz点 obz点_");
  });

  it("applies Unicode identifier boundaries to non-Han aliases", () => {
    const identifiers = { "北大2": ["北京大学二校区"], "北大_版": ["北京大学版"] };
    expect(normalizeSpeech("北大2026 北大2！北大_版本 北大_版。", identifiers))
      .toBe("北大2026 北京大学二校区！北京大学版本 北京大学版。");
  });

  it("applies Unicode identifier boundaries to aliases from other letter scripts", () => {
    expect(normalizeSpeech("Жcat Жcat！catЖ cat！", { "Жcat": ["西里尔别名"], cat: ["猫"] }))
      .toBe("西里尔别名 西里尔别名！catЖ 猫！");
  });

  it("keeps pure Han aliases replaceable at natural Chinese word boundaries", () => {
    expect(normalizeSpeech("我爱北大，北大毕业。", { "北大": ["北京大学"] }))
      .toBe("我爱北京大学，北京大学毕业。");
  });

  it("matches punctuation-only aliases literally", () => {
    expect(normalizeSpeech("甲++乙 ++", { "++": ["加加"] })).toBe("甲加加乙 加加");
  });

  it("rejects trim-equivalent and ambiguous-system conflicts when adding aliases", () => {
    const existing: SpeechAliasDictionary = {
      " 京 ": ["北京"],
      "北平": ["北京", "北京大学"]
    };
    expect(addUnambiguousAlias(existing, "京", "南京")).toBe(existing);
    expect(addUnambiguousAlias(existing, "帝都", " 北京 ")).toBe(existing);
    expect(addUnambiguousAlias(existing, "北京大学", "北大")).toBe(existing);
    expect(addUnambiguousAlias(existing, "魔都", "上海")).toEqual({ ...existing, "魔都": ["上海"] });
  });
});
