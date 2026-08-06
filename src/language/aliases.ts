export type SpeechAliasDictionary = Readonly<Record<string, readonly string[]>>;

export interface AliasSuggestion {
  readonly alias: string;
  readonly canonical: string;
  readonly explicit: boolean;
  readonly alternatives: readonly string[];
}

function normalized(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}

function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function isHan(value: string | undefined): boolean {
  return value !== undefined && /\p{Script=Han}/u.test(value);
}

function isNonHanIdentifierCharacter(value: string | undefined): boolean {
  return isIdentifierCharacter(value) && !isHan(value);
}

function hasValidBoundary(
  text: string,
  offset: number,
  alias: string,
  chineseWords: ReadonlySet<string>
): boolean {
  const before = offset === 0 ? undefined : Array.from(text.slice(0, offset)).at(-1);
  const after = Array.from(text.slice(offset + alias.length))[0];
  if (/^\p{Script=Han}+$/u.test(alias)) {
    return chineseWords.has(`${offset}\0${alias}`);
  }
  if (/[\p{L}\p{N}_]/u.test(alias)) {
    return !isNonHanIdentifierCharacter(before) && !isNonHanIdentifierCharacter(after);
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function normalizeSpeech(text: string, dictionary: SpeechAliasDictionary): string {
  const replacements = Object.entries(dictionary)
    .map(([alias, candidates]) => [alias.trim(), candidates.map((candidate) => candidate.trim())] as const)
    .filter(([alias, candidates]) => alias.length > 0 && candidates.length === 1 && candidates[0] !== undefined)
    .sort(([left], [right]) => right.length - left.length || left.localeCompare(right, "zh-CN"));
  if (replacements.length === 0) return text;
  const chineseWords = new Set(
    [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)]
      .filter((segment) => segment.isWordLike)
      .map((segment) => `${segment.index}\0${segment.segment}`)
  );
  const canonicalByAlias = new Map(replacements.map(([alias, candidates]) => [alias, candidates[0]!]));
  const pattern = new RegExp(replacements.map(([alias]) => escapeRegExp(alias)).join("|"), "gu");
  return text.replace(pattern, (alias, offset: number) =>
    hasValidBoundary(text, offset, alias, chineseWords) ? canonicalByAlias.get(alias)! : alias
  );
}

export function addUnambiguousAlias(
  dictionary: SpeechAliasDictionary,
  aliasInput: string,
  canonicalInput: string
): SpeechAliasDictionary {
  const alias = aliasInput.trim().normalize("NFKC");
  const canonical = canonicalInput.trim().normalize("NFKC");
  if (alias.length === 0 || canonical.length === 0) return dictionary;
  const aliasKey = normalized(alias);
  const canonicalKey = normalized(canonical);
  const normalizedEntries = Object.entries(dictionary).map(([key, candidates]) => ({
    key: normalized(key),
    candidates: candidates.map(normalized)
  }));
  const existing = normalizedEntries.find((entry) => entry.key === aliasKey);
  if (existing !== undefined) return dictionary;

  const ambiguousTokens = new Set<string>();
  for (const entry of normalizedEntries) {
    if (entry.candidates.length !== 1) {
      ambiguousTokens.add(entry.key);
      for (const candidate of entry.candidates) ambiguousTokens.add(candidate);
    }
  }
  if (ambiguousTokens.has(aliasKey) || ambiguousTokens.has(canonicalKey)) return dictionary;
  return Object.freeze({ ...dictionary, [alias]: Object.freeze([canonical]) });
}

export function addAliasSuggestion(
  dictionary: SpeechAliasDictionary,
  suggestion: AliasSuggestion
): SpeechAliasDictionary {
  if (!suggestion.explicit || suggestion.alternatives.length > 0) return dictionary;
  return addUnambiguousAlias(dictionary, suggestion.alias, suggestion.canonical);
}
