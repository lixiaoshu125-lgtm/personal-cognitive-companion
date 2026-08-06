/**
 * News Headline Fetcher — Phase 4 (revised 2026-08-06)
 *
 * Fetches recent news headlines for cross-referencing with user notes
 * during topic generation.
 *
 * Two-tier strategy:
 *   1. If NewsAPI key is configured → use NewsAPI (fast, structured)
 *   2. Otherwise → free RSS fallback (no API key required)
 *
 * Key rules:
 *  - Network failure is non-fatal → returns [] (topic generation
 *    degrades gracefully without news).
 *  - Truncates results to `maxItems`.
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface NewsHeadline {
  readonly title: string;
  readonly summary: string;
  readonly source: string;
  readonly url: string;
}

export interface NewsFetchConfig {
  readonly apiKey: string;
  /** Comma-separated source domains (e.g. "zhihu.com,36kr.com") or empty for all. */
  readonly sources?: string | undefined;
  /** Max headlines to return. Default: 10. */
  readonly maxItems?: number | undefined;
}

/**
 * Pluggable news provider interface.
 */
export interface NewsProvider {
  fetchHeadlines(config: NewsFetchConfig): Promise<NewsHeadline[]>;
}

// ═══════════════════════════════════════════════════════════════
// NewsAPI.org Provider (when API key is configured)
// ═══════════════════════════════════════════════════════════════

const NEWSAPI_BASE = "https://newsapi.org/v2/top-headlines";

interface NewsApiArticle {
  title: string;
  description: string | null;
  source: { name: string };
  url: string;
}

function toHeadline(article: NewsApiArticle): NewsHeadline {
  return {
    title: article.title ?? "",
    summary: article.description ?? "",
    source: article.source?.name ?? "unknown",
    url: article.url ?? "",
  };
}

async function fetchFromNewsApi(config: NewsFetchConfig): Promise<NewsHeadline[]> {
  const params = new URLSearchParams();
  params.set("apiKey", config.apiKey);
  params.set("pageSize", String(Math.min(config.maxItems ?? 10, 100)));
  params.set("language", "zh");

  if (config.sources && config.sources.trim().length > 0) {
    params.set("sources", config.sources.trim());
  } else {
    params.set("country", "cn");
  }

  const url = `${NEWSAPI_BASE}?${params.toString()}`;
  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`NewsAPI returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { articles?: NewsApiArticle[] };
  const articles = data.articles ?? [];

  return articles
    .filter((a) => a.title && a.title.trim().length > 0)
    .map(toHeadline)
    .slice(0, config.maxItems ?? 10);
}

// ═══════════════════════════════════════════════════════════════
// Free RSS Fallback Provider (no API key needed)
// ═══════════════════════════════════════════════════════════════

/**
 * RSSHub mirror URLs — tried in order for each source.
 * rsshub.app is the primary; mirrors provide fallback when blocked.
 */
const RSSHUB_MIRRORS = [
  "https://rsshub.app",
  "https://rsshub.rssforever.com",
  "https://rsshub.pseudoyu.com",
];

/**
 * Free Chinese news RSS feeds.
 * Each entry is [displayName, routePath].
 * The route path is appended to each mirror URL to form the full RSS URL.
 */
const FREE_RSS_SOURCES: ReadonlyArray<[string, string]> = [
  ["财联社", "/cls/telegraph"],
  ["澎湃新闻", "/thepaper/featured"],
  ["少数派", "/sspai/index"],
  ["知乎热榜", "/zhihu/hotlist"],
  ["36氪", "/36kr/motif/2023013001"],
  ["人民日报", "/people/xinhua/1"],
];

/**
 * Lightweight RSS item parser.
 * Extracts <item> blocks with <title>, <description>, <link>.
 * Does NOT use a full XML parser — regex-based for zero-dependency.
 */
function parseRssItems(xml: string): Array<{ title: string; description: string; link: string }> {
  const items: Array<{ title: string; description: string; link: string }> = [];

  // Match <item>...</item> blocks (non-greedy, dotAll)
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1]!;

    const titleMatch = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/i.exec(block);
    const descMatch = /<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/i.exec(block);
    const linkMatch = /<link>(.*?)<\/link>/i.exec(block);

    const title = titleMatch?.[1] ?? titleMatch?.[2] ?? "";
    const description = descMatch?.[1] ?? descMatch?.[2] ?? "";
    const link = linkMatch?.[1] ?? "";

    if (title.trim()) {
      items.push({
        title: decodeHtmlEntities(title).trim(),
        description: decodeHtmlEntities(description).replace(/<[^>]*>/g, "").trim(),
        link: link.trim(),
      });
    }
  }

  return items;
}

/** Decode common HTML entities in RSS content. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_m, hex) =>
      String.fromCodePoint(parseInt(hex as string, 16)),
    );
}

/**
 * Fetch headlines from a single RSS source, trying each mirror in order.
 * Returns empty array if all mirrors fail.
 */
async function fetchSingleSource(
  sourceName: string,
  routePath: string,
  maxItems: number,
  timeoutMs: number,
): Promise<NewsHeadline[]> {
  for (const mirror of RSSHUB_MIRRORS) {
    const rssUrl = `${mirror}${routePath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(rssUrl, {
        signal: controller.signal,
        headers: { "Accept": "application/rss+xml, application/xml, text/xml, */*" },
      });

      if (!response.ok) continue; // Try next mirror

      const xml = await response.text();
      const items = parseRssItems(xml);

      if (items.length === 0) continue; // Empty feed — try next mirror

      return items.slice(0, maxItems).map((item) => ({
        title: item.title,
        summary: item.description.slice(0, 200),
        source: sourceName,
        url: item.link,
      }));
    } catch {
      continue; // Timeout or network error — try next mirror
    } finally {
      clearTimeout(timer);
    }
  }

  return []; // All mirrors failed for this source
}

/**
 * Fetch headlines from free RSS sources.
 * Fetches up to 3 sources in parallel, each trying multiple mirrors.
 * Aggregates results and deduplicates by title.
 */
async function fetchFromFreeRss(maxItems: number): Promise<NewsHeadline[]> {
  const headlines: NewsHeadline[] = [];
  const seenTitles = new Set<string>();

  // Shuffle sources so we don't always hit the same ones
  const shuffled = [...FREE_RSS_SOURCES].sort(() => Math.random() - 0.5);
  // Fetch from up to 3 sources, each with mirror fallback
  const sources = shuffled.slice(0, 3);

  const results = await Promise.allSettled(
    sources.map(async ([sourceName, routePath]): Promise<NewsHeadline[]> => {
      return fetchSingleSource(sourceName, routePath, Math.ceil(maxItems / sources.length), 5000);
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const h of result.value) {
        const key = h.title.toLowerCase();
        if (!seenTitles.has(key)) {
          seenTitles.add(key);
          headlines.push(h);
        }
      }
    }
  }

  return headlines.slice(0, maxItems);
}

// ═══════════════════════════════════════════════════════════════
// Unified fetch — tries NewsAPI first, falls back to free RSS
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch recent news headlines.
 *
 * Strategy:
 *  1. If apiKey is configured → try NewsAPI first, fall back to RSS on failure
 *  2. If apiKey is empty → use free RSS directly
 *
 * Returns empty array when all sources fail — topic generation degrades
 * gracefully without news.
 */
export async function fetchNewsHeadlines(config: NewsFetchConfig): Promise<NewsHeadline[]> {
  const maxItems = config.maxItems ?? 10;

  // If user has configured a NewsAPI key, try it first
  if (config.apiKey && config.apiKey.trim().length > 0) {
    try {
      return await fetchFromNewsApi(config);
    } catch (err) {
      console.warn(
        `[PCC] NewsAPI failed, falling back to free RSS: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Fall through to RSS fallback
    }
  }

  // Free RSS fallback (works without any API key)
  try {
    return await fetchFromFreeRss(maxItems);
  } catch (err) {
    console.warn(
      `[PCC] RSS fallback also failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// Provider registry (for testing / swapping)
// ═══════════════════════════════════════════════════════════════

let _provider: NewsProvider | null = null;

/** Override the news provider (for testing or swapping backends). */
export function setNewsProvider(provider: NewsProvider): void {
  _provider = provider;
}

/**
 * Create a mock provider that returns canned headlines.
 * For testing topic generation without network access.
 */
export function createMockNewsProvider(headlines: readonly NewsHeadline[]): NewsProvider {
  return {
    async fetchHeadlines(_config: NewsFetchConfig): Promise<NewsHeadline[]> {
      return [...headlines];
    },
  };
}
