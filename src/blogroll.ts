import { type Feed, parseFeed } from "rss";

export const feeds_path = "content/blogroll.txt";
export const cache_path = "content/blogroll-cache.json";
export const cache_version = 1;
export const entries_per_feed = 3;
export const default_timeout_ms = 20_000;

/** Four-digit year ISO instant: the only date shape the cache ever stores. */
const persisted_date_pattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** A blogroll item, ready to be rendered. */
export interface FeedEntry {
  title: string;
  url: string;
  date: Date;
}

/** A single cached entry, as stored on disk. */
export interface CachedEntry {
  title: string;
  url: string;
  date: string;
}

/** Everything we remember about one feed. */
export interface CachedFeed {
  refreshedAt: string;
  entries: CachedEntry[];
}

/** The on-disk shape of `content/blogroll-cache.json`. */
export interface BlogrollCache {
  version: number;
  feeds: Record<string, CachedFeed>;
}

/** Outcome of refreshing exactly one feed. Never logs, never falls back. */
export type FeedRefresh =
  | { ok: true; url: string; feed: CachedFeed }
  | { ok: false; url: string; reason: string };

/**
 * Raised when a step of the refresh outlives its budget, so the caller can
 * report "timed out" instead of blaming the feed for a malformed document.
 */
export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

export interface RefreshOptions {
  fetch?: typeof globalThis.fetch;
  timeout_ms?: number;
  now?: () => Date;
}

export interface RefreshCacheOptions extends RefreshOptions {
  previous?: BlogrollCache;
  warn?: (message: string) => void;
}

type RawEntry = Feed["entries"][number];
type RawLink = RawEntry["links"][number];

export function parse_feed_list(text: string): string[] {
  const urls: string[] = [];
  for (const line of text.split("\n")) {
    const url = line.trim();
    if (url.length === 0 || url.startsWith("#")) continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

export async function read_feed_list(path: string = feeds_path): Promise<
  string[]
> {
  return parse_feed_list(await Deno.readTextFile(path));
}

export function parse_cache(text: string): BlogrollCache {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`blogroll cache is not valid JSON: ${message_of(error)}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("blogroll cache must be a JSON object");
  }
  const root = json as Record<string, unknown>;
  if (root.version !== cache_version) {
    throw new Error(
      `blogroll cache version ${
        JSON.stringify(root.version)
      } is unsupported, expected ${cache_version}`,
    );
  }
  const raw_feeds = root.feeds;
  if (
    typeof raw_feeds !== "object" || raw_feeds === null ||
    Array.isArray(raw_feeds)
  ) {
    throw new Error("blogroll cache is missing a `feeds` object");
  }

  const feeds: Record<string, CachedFeed> = {};
  for (const [url, raw_feed] of Object.entries(raw_feeds)) {
    feeds[url] = parse_cached_feed(url, raw_feed);
  }
  return { version: cache_version, feeds };
}

function parse_cached_feed(url: string, raw: unknown): CachedFeed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`blogroll cache entry for ${url} must be an object`);
  }
  const feed = raw as Record<string, unknown>;
  const refreshed_at = feed.refreshedAt;
  if (typeof refreshed_at !== "string" || !is_persisted_date(refreshed_at)) {
    throw new Error(
      `blogroll cache entry for ${url} has an invalid \`refreshedAt\``,
    );
  }
  if (!Array.isArray(feed.entries)) {
    throw new Error(`blogroll cache entry for ${url} has no \`entries\` array`);
  }
  const entries = feed.entries.map((raw_entry, index) => {
    if (
      typeof raw_entry !== "object" || raw_entry === null ||
      Array.isArray(raw_entry)
    ) {
      throw new Error(`blogroll cache entry ${url}#${index} must be an object`);
    }
    const entry = raw_entry as Record<string, unknown>;
    const { title, url: entry_url, date } = entry;
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new Error(`blogroll cache entry ${url}#${index} has no title`);
    }
    if (typeof entry_url !== "string" || !is_absolute_url(entry_url)) {
      throw new Error(
        `blogroll cache entry ${url}#${index} has no absolute url`,
      );
    }
    if (typeof date !== "string" || !is_persisted_date(date)) {
      throw new Error(`blogroll cache entry ${url}#${index} has no valid date`);
    }
    return { title, url: entry_url, date };
  });
  return { refreshedAt: refreshed_at, entries };
}

/**
 * Serializes the cache deterministically: feeds follow the canonical order of
 * `blogroll.txt`, keys that are no longer canonical are dropped, and the file
 * ends with a newline.
 */
export function serialize_cache(
  cache: BlogrollCache,
  urls: string[],
): string {
  const feeds: Record<string, CachedFeed> = {};
  for (const url of urls) {
    const feed = cache.feeds[url];
    if (feed === undefined) continue;
    feeds[url] = {
      refreshedAt: feed.refreshedAt,
      entries: feed.entries.map((entry) => ({
        title: entry.title,
        url: entry.url,
        date: entry.date,
      })),
    };
  }
  const ordered: BlogrollCache = { version: cache_version, feeds };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function read_cache(path: string = cache_path): Promise<
  BlogrollCache
> {
  const text = await try_read_text(path);
  if (text === undefined) {
    throw new Error(
      `blogroll cache ${path} is missing, run \`deno task update-blogroll\``,
    );
  }
  return parse_cache(text);
}

/**
 * Flattens the cache into renderable entries: canonical feeds only, at most
 * `entries_per_feed` per feed, deduplicated by article url, newest first.
 */
export function blogroll_entries(
  cache: BlogrollCache,
  urls: string[],
): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const feed = cache.feeds[url];
    if (feed === undefined) continue;
    for (const entry of feed.entries.slice(0, entries_per_feed)) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      entries.push({
        title: entry.title,
        url: entry.url,
        date: new Date(entry.date),
      });
    }
  }
  entries.sort((a, b) => b.date.getTime() - a.date.getTime());
  return entries;
}

/** Reads the canonical list plus the cache and renders-ready entries. */
export async function blogroll(
  options: { feeds?: string; cache?: string } = {},
): Promise<FeedEntry[]> {
  const urls = await read_feed_list(options.feeds ?? feeds_path);
  const cache = await read_cache(options.cache ?? cache_path);
  return blogroll_entries(cache, urls);
}

/**
 * Refreshes a single feed. Returns a typed result; the caller decides whether
 * to warn and whether to keep the stale record.
 */
export async function refresh_feed(
  url: string,
  options: RefreshOptions = {},
): Promise<FeedRefresh> {
  const do_fetch = options.fetch ?? globalThis.fetch;
  const timeout_ms = options.timeout_ms ?? default_timeout_ms;
  const now = options.now ?? (() => new Date());

  let response: Response;
  try {
    response = await do_fetch(url, {
      signal: AbortSignal.timeout(timeout_ms),
      headers: {
        accept: "application/atom+xml, application/rss+xml, text/xml",
      },
    });
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "TimeoutError"
        ? `request timed out after ${timeout_ms}ms`
        : `request failed: ${message_of(error)}`;
    return { ok: false, url, reason };
  }

  if (!response.ok) {
    await discard_body(response);
    return {
      ok: false,
      url,
      reason: `unexpected status ${response.status} ${response.statusText}`
        .trim(),
    };
  }

  const content_type = response.headers.get("content-type") ?? "";
  if (content_type.toLowerCase().includes("text/html")) {
    await discard_body(response);
    return { ok: false, url, reason: `served html (${content_type})` };
  }

  let xml: string;
  try {
    xml = await response.text();
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "TimeoutError"
        ? `body download timed out after ${timeout_ms}ms`
        : `body download failed: ${message_of(error)}`;
    return { ok: false, url, reason };
  }

  if (looks_like_html(xml)) {
    return { ok: false, url, reason: "body looks like html, not a feed" };
  }

  let feed: Feed;
  try {
    feed = await with_timeout(
      parseFeed(xml),
      timeout_ms,
      `feed parsing timed out after ${timeout_ms}ms`,
    );
  } catch (error) {
    const reason = error instanceof TimeoutError
      ? error.message
      : `xml parse error: ${message_of(error)}`;
    return { ok: false, url, reason };
  }

  const refreshed_at = to_persisted_date(now());
  if (refreshed_at === undefined) {
    return {
      ok: false,
      url,
      reason: "refresh clock produced an unusable date",
    };
  }

  const base = response.url === "" ? url : response.url;
  const raw_entries = feed.entries ?? [];
  const entries: CachedEntry[] = [];
  for (const raw_entry of raw_entries) {
    const entry = normalize_entry(raw_entry, base);
    if (entry !== undefined) entries.push(entry);
  }
  // A feed that publishes nothing yet is a legitimate, cacheable state; a feed
  // whose every item is unusable is a producer we do not understand, so it
  // fails and the caller keeps whatever it had cached.
  if (raw_entries.length > 0 && entries.length === 0) {
    return {
      ok: false,
      url,
      reason: `feed has ${raw_entries.length} entries but none are usable`,
    };
  }

  entries.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return {
    ok: true,
    url,
    feed: {
      refreshedAt: refreshed_at,
      entries: entries.slice(0, entries_per_feed),
    },
  };
}

function normalize_entry(
  entry: RawEntry,
  base: string,
): CachedEntry | undefined {
  const title = entry.title?.value?.trim();
  if (title === undefined || title.length === 0) return undefined;

  const url = pick_link(entry.links ?? [], base);
  if (url === undefined) return undefined;

  const date = normalize_date(entry);
  if (date === undefined) return undefined;

  return { title, url, date };
}

/** Prefers an html/alternate link, then falls back to the first usable one. */
function pick_link(links: RawLink[], base: string): string | undefined {
  const usable = links.filter((link): link is RawLink & { href: string } =>
    typeof link.href === "string" && link.href.trim().length > 0
  );
  const preferred = usable.find((link) =>
    link.type?.toLowerCase().includes("html") ||
    link.rel === "alternate" ||
    link.href.endsWith(".html")
  );
  const chosen = preferred ?? usable[0];
  if (chosen === undefined) return undefined;
  const resolved = (() => {
    try {
      return new URL(chosen.href.trim(), base);
    } catch {
      return undefined;
    }
  })();
  if (resolved === undefined) return undefined;
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return undefined;
  }
  return resolved.href;
}

/**
 * Picks the first date the feed offers that we can persist. Candidates outside
 * the persisted-date contract are skipped rather than trusted, so an entry
 * dated in year 12345 is dropped instead of poisoning the cache.
 */
function normalize_date(entry: RawEntry): string | undefined {
  const candidates: (Date | string | undefined)[] = [
    entry.published,
    entry.updated,
    entry.publishedRaw,
    entry.updatedRaw,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const date = candidate instanceof Date ? candidate : new Date(candidate);
    const persisted = to_persisted_date(date);
    if (persisted !== undefined) return persisted;
  }
  return undefined;
}

/**
 * Refreshes every canonical feed in parallel, keeping the previous record of
 * any feed that fails. This is the only place that warns.
 *
 * A feed that refreshes successfully but publishes nothing keeps its (empty)
 * record so the cache stays in step with `blogroll.txt`; it only warns.
 */
export async function refresh_cache(
  urls: string[],
  options: RefreshCacheOptions = {},
): Promise<BlogrollCache> {
  const previous = options.previous ?? { version: cache_version, feeds: {} };
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const results = await Promise.all(
    urls.map((url) =>
      refresh_feed(url, {
        fetch: options.fetch,
        timeout_ms: options.timeout_ms,
        now: options.now,
      })
    ),
  );

  const feeds: Record<string, CachedFeed> = {};
  for (const result of results) {
    if (result.ok) {
      if (result.feed.entries.length === 0) {
        warn(`blogroll: ${result.url} refreshed with no entries`);
      }
      feeds[result.url] = result.feed;
      continue;
    }
    const stale = previous.feeds[result.url];
    if (stale === undefined) {
      warn(
        `blogroll: dropping ${result.url}: ${result.reason} (no cached entries)`,
      );
      continue;
    }
    warn(
      `blogroll: keeping cached entries for ${result.url} from ${stale.refreshedAt}: ${result.reason}`,
    );
    feeds[result.url] = stale;
  }
  return { version: cache_version, feeds };
}

/** Refreshes the canonical feeds and rewrites the cache atomically. */
export async function update_cache(
  options: RefreshCacheOptions & { feeds_file?: string; cache_file?: string } =
    {},
): Promise<BlogrollCache> {
  const feeds_file = options.feeds_file ?? feeds_path;
  const cache_file = options.cache_file ?? cache_path;
  const urls = await read_feed_list(feeds_file);

  let previous = options.previous;
  if (previous === undefined) {
    const existing = await try_read_text(cache_file);
    if (existing === undefined) {
      console.warn(
        `blogroll: ${cache_file} does not exist yet, starting empty`,
      );
      previous = { version: cache_version, feeds: {} };
    } else {
      previous = parse_cache(existing);
    }
  }

  const cache = await refresh_cache(urls, { ...options, previous });
  const text = serialize_cache(cache, urls);
  // Defense in depth: whatever the producers did, the bytes we are about to
  // publish must be readable by `parse_cache`, or `build` and the next refresh
  // would both fail on a cache we can no longer repair from.
  try {
    parse_cache(text);
  } catch (error) {
    throw new Error(
      `refusing to rewrite ${cache_file}, the refreshed cache is unreadable: ${
        message_of(error)
      }`,
    );
  }
  const temp = `${cache_file}.tmp`;
  await Deno.writeTextFile(temp, text);
  await Deno.rename(temp, cache_file);
  return cache;
}

async function try_read_text(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

function is_persisted_date(value: string): boolean {
  return persisted_date_pattern.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The single contract for every date the cache persists: an ISO instant with a
 * four-digit year. `Date#toISOString` escapes that shape for years outside
 * 0000-9999 (`+012345-01-01T00:00:00.000Z`), and a feed is free to claim such a
 * date, so the write path validates its own output with the reader's predicate
 * instead of trusting `toISOString`.
 */
function to_persisted_date(date: Date): string | undefined {
  if (Number.isNaN(date.getTime())) return undefined;
  const iso = date.toISOString();
  return is_persisted_date(iso) ? iso : undefined;
}

function is_absolute_url(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function looks_like_html(body: string): boolean {
  const head = body.replace(/^\uFEFF/, "").trimStart().slice(0, 512)
    .toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

async function discard_body(response: Response): Promise<void> {
  await response.body?.cancel();
}

/**
 * Bounds a promise that may never settle. `parseFeed` leaves its promise
 * pending forever on truncated xml, so this is load-bearing, not belt and
 * braces: without it a single truncated feed hangs the whole refresh.
 */
function with_timeout<T>(
  promise: Promise<T>,
  timeout_ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), timeout_ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function message_of(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
