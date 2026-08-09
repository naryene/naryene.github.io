import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "std/assert/mod.ts";
import {
  blogroll_entries,
  type BlogrollCache,
  cache_version,
  parse_cache,
  parse_feed_list,
  refresh_cache,
  refresh_feed,
  serialize_cache,
  update_cache,
} from "./blogroll.ts";

const atom_feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <id>https://example.com/feed.xml</id>
  <entry>
    <title>Newer post</title>
    <id>https://example.com/newer</id>
    <link rel="edit" type="application/atom+xml" href="https://example.com/edit/newer"/>
    <link rel="alternate" type="text/html" href="/posts/newer.html"/>
    <published>2026-02-01T00:00:00Z</published>
  </entry>
  <entry>
    <title>Older post</title>
    <id>https://example.com/older</id>
    <link rel="alternate" type="text/html" href="https://example.com/posts/older.html"/>
    <updated>2026-01-01T00:00:00Z</updated>
  </entry>
  <entry>
    <title>Undated post</title>
    <id>https://example.com/undated</id>
    <link rel="alternate" type="text/html" href="https://example.com/posts/undated.html"/>
    <updated>not a date</updated>
  </entry>
  <entry>
    <title>Linkless post</title>
    <id>urn:uuid:6b3a8f2e-0000-4000-8000-000000000000</id>
    <updated>2026-03-01T00:00:00Z</updated>
  </entry>
  <entry>
    <id>https://example.com/titleless</id>
    <link rel="alternate" type="text/html" href="https://example.com/posts/titleless.html"/>
    <updated>2026-04-01T00:00:00Z</updated>
  </entry>
</feed>
`;

const rss_feed = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Example RSS</title>
    <link>https://rss.example.com</link>
    <item>
      <title>RSS one</title>
      <link>https://rss.example.com/one.html</link>
      <pubDate>Mon, 05 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>RSS two</title>
      <link>https://rss.example.com/two.html</link>
      <pubDate>Sun, 04 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>RSS three</title>
      <link>https://rss.example.com/three.html</link>
      <pubDate>Sat, 03 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>RSS four</title>
      <link>https://rss.example.com/four.html</link>
      <pubDate>Fri, 02 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
`;

const far_future_feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Far future</title>
  <id>https://future.example/feed.xml</id>
  <entry>
    <title>Year 12345 post</title>
    <id>https://future.example/12345</id>
    <link rel="alternate" type="text/html" href="https://future.example/12345.html"/>
    <published>+012345-01-01T00:00:00Z</published>
  </entry>
  <entry>
    <title>Ordinary post</title>
    <id>https://future.example/ordinary</id>
    <link rel="alternate" type="text/html" href="https://future.example/ordinary.html"/>
    <published>2026-01-01T00:00:00Z</published>
  </entry>
</feed>
`;

const only_far_future_feed = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Only the far future</title>
    <link>https://future.example</link>
    <item>
      <title>Year 12345 post</title>
      <link>https://future.example/12345.html</link>
      <pubDate>Mon, 05 Jan 12345 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
`;

const empty_feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Nothing published yet</title>
  <id>https://quiet.example/feed.xml</id>
  <updated>2026-05-01T00:00:00Z</updated>
</feed>
`;

function responder(
  routes: Record<string, Response | (() => Response)>,
): typeof globalThis.fetch {
  return (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    const route = routes[url];
    if (route === undefined) {
      return Promise.reject(new Error(`no route ${url}`));
    }
    return Promise.resolve(typeof route === "function" ? route() : route);
  };
}

function xml_response(body: string, url: string): () => Response {
  return () => {
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}

const frozen_now = () => new Date("2026-05-01T12:00:00.000Z");

/**
 * Resolves to `"hung"` instead of waiting forever, so a test can assert that
 * production code bounds itself rather than relying on the test runner to be
 * killed.
 */
async function within<T>(
  ms: number,
  promise: Promise<T>,
): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

let scratch_id = 0;

/** A writable scratch directory under the gitignored `./build`. */
async function scratch_dir(): Promise<string> {
  const path = `./build/blogroll-test-${Deno.pid}-${scratch_id++}`;
  await Deno.remove(path, { recursive: true }).catch(() => {});
  await Deno.mkdir(path, { recursive: true });
  return path;
}

Deno.test("parse_feed_list keeps order and drops blanks, comments, dupes", () => {
  const urls = parse_feed_list(
    "  https://a.example/feed.xml \n\n# a comment\nhttps://b.example/feed.xml\nhttps://a.example/feed.xml\n",
  );
  assertEquals(urls, [
    "https://a.example/feed.xml",
    "https://b.example/feed.xml",
  ]);
});

Deno.test("refresh_feed normalizes atom entries and prefers html links", async () => {
  const url = "https://example.com/feed.xml";
  const result = await refresh_feed(url, {
    fetch: responder({ [url]: xml_response(atom_feed, url) }),
    now: frozen_now,
  });

  assert(result.ok, `expected success, got ${JSON.stringify(result)}`);
  assertEquals(result.feed.refreshedAt, "2026-05-01T12:00:00.000Z");
  assertEquals(result.feed.entries, [
    {
      title: "Newer post",
      url: "https://example.com/posts/newer.html",
      date: "2026-02-01T00:00:00.000Z",
    },
    {
      title: "Older post",
      url: "https://example.com/posts/older.html",
      date: "2026-01-01T00:00:00.000Z",
    },
  ]);
});

Deno.test("refresh_feed normalizes rss entries and keeps only three", async () => {
  const url = "https://rss.example.com/feed.xml";
  const result = await refresh_feed(url, {
    fetch: responder({ [url]: xml_response(rss_feed, url) }),
    now: frozen_now,
  });

  assert(result.ok, `expected success, got ${JSON.stringify(result)}`);
  assertEquals(result.feed.entries.length, 3);
  assertEquals(result.feed.entries.map((entry) => entry.title), [
    "RSS one",
    "RSS two",
    "RSS three",
  ]);
  assertEquals(
    result.feed.entries[0].url,
    "https://rss.example.com/one.html",
  );
});

Deno.test("refresh_feed fails on non-2xx responses", async () => {
  const url = "https://down.example/feed.xml";
  const result = await refresh_feed(url, {
    fetch: responder({
      [url]: () =>
        new Response("nope", { status: 504, statusText: "Gateway Timeout" }),
    }),
  });

  assert(!result.ok);
  assertEquals(result.url, url);
  assertStringIncludes(result.reason, "504");
});

Deno.test("refresh_feed fails on an html response", async () => {
  const url = "https://html.example/feed.xml";
  const result = await refresh_feed(url, {
    fetch: responder({
      [url]: () =>
        new Response("<!DOCTYPE html><html><body>hi</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    }),
  });

  assert(!result.ok);
  assertStringIncludes(result.reason, "html");
});

Deno.test("refresh_feed fails on html served with a feed content type", async () => {
  const url = "https://sneaky.example/feed.xml";
  const result = await refresh_feed(url, {
    fetch: responder({
      [url]: xml_response(
        "<!doctype html>\n<html><body>not a feed</body></html>",
        url,
      ),
    }),
  });

  assert(!result.ok);
  assertStringIncludes(result.reason, "looks like html");
});

Deno.test("refresh_feed reports a bounded parse timeout for malformed xml", async () => {
  // `parseFeed` never settles on truncated xml, so the timeout wrapper is the
  // only thing that ends this refresh. The assertions pin that down: the
  // failure must arrive as a timeout, no earlier than the budget, and well
  // before the guard below, which is what a broken wrapper would trip.
  const url = "https://broken.example/feed.xml";
  const timeout_ms = 100;
  const started = performance.now();
  const result = await within(
    10_000,
    refresh_feed(url, {
      fetch: responder({
        [url]: xml_response("<rss><channel><title>truncated", url),
      }),
      timeout_ms,
    }),
  );
  const elapsed = performance.now() - started;

  assertNotEquals(
    result,
    "hung",
    "malformed xml was not bounded by the parse timeout",
  );
  assert(result !== "hung" && !result.ok);
  assertEquals(result.reason, `feed parsing timed out after ${timeout_ms}ms`);
  assert(
    elapsed >= timeout_ms,
    `expected to wait for the ${timeout_ms}ms budget, waited ${elapsed}ms`,
  );
});

Deno.test("refresh_feed reports a plain parse error, not a timeout, for junk", async () => {
  const url = "https://junk.example/feed.xml";
  const result = await refresh_feed(url, {
    fetch: responder({
      [url]: xml_response("this is not a feed at all", url),
    }),
    timeout_ms: 10_000,
  });

  assert(!result.ok);
  assertStringIncludes(result.reason, "xml parse error");
  assert(
    !result.reason.includes("timed out"),
    `a rejected parse must not read as a timeout: ${result.reason}`,
  );
});

Deno.test("refresh_feed fails when the feed publishes only unusable entries", async () => {
  const url = "https://empty.example/feed.xml";
  const result = await refresh_feed(url, {
    fetch: responder({
      [url]: xml_response(
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Broken</title><id>x</id>` +
          `<entry><id>urn:a</id><updated>2026-01-01T00:00:00Z</updated></entry></feed>`,
        url,
      ),
    }),
  });

  assert(!result.ok);
  assertStringIncludes(result.reason, "none are usable");
});

Deno.test("refresh_feed accepts a well-formed feed that published nothing", async () => {
  const url = "https://quiet.example/feed.xml";
  const result = await refresh_feed(url, {
    fetch: responder({ [url]: xml_response(empty_feed, url) }),
    now: frozen_now,
  });

  assert(result.ok, `expected success, got ${JSON.stringify(result)}`);
  assertEquals(result.feed.entries, []);
  assertEquals(result.feed.refreshedAt, "2026-05-01T12:00:00.000Z");
});

Deno.test("refresh_feed drops entries whose date cannot be persisted", async () => {
  const url = "https://future.example/feed.xml";
  const result = await refresh_feed(url, {
    fetch: responder({ [url]: xml_response(far_future_feed, url) }),
    now: frozen_now,
  });

  assert(result.ok, `expected success, got ${JSON.stringify(result)}`);
  assertEquals(result.feed.entries, [{
    title: "Ordinary post",
    url: "https://future.example/ordinary.html",
    date: "2026-01-01T00:00:00.000Z",
  }]);
  // The refreshed feed must survive its own writer.
  assertEquals(
    parse_cache(serialize_cache(
      { version: cache_version, feeds: { [url]: result.feed } },
      [url],
    )).feeds[url],
    result.feed,
  );
});

Deno.test("refresh_feed fails when every date is out of the persisted range", async () => {
  const url = "https://future.example/rss.xml";
  const result = await refresh_feed(url, {
    fetch: responder({ [url]: xml_response(only_far_future_feed, url) }),
    now: frozen_now,
  });

  assert(!result.ok);
  assertStringIncludes(result.reason, "none are usable");
});

Deno.test("an out of range date keeps the stale cache and never reaches disk", async () => {
  const dir = await scratch_dir();
  const feeds_file = `${dir}/blogroll.txt`;
  const cache_file = `${dir}/blogroll-cache.json`;
  const url = "https://future.example/rss.xml";
  const good_cache: BlogrollCache = {
    version: cache_version,
    feeds: {
      [url]: {
        refreshedAt: "2026-04-01T00:00:00.000Z",
        entries: [{
          title: "Stale but readable",
          url: "https://future.example/stale.html",
          date: "2026-03-30T00:00:00.000Z",
        }],
      },
    },
  };

  try {
    await Deno.writeTextFile(feeds_file, `${url}\n`);
    await Deno.writeTextFile(cache_file, serialize_cache(good_cache, [url]));

    const warnings: string[] = [];
    const cache = await update_cache({
      feeds_file,
      cache_file,
      now: frozen_now,
      warn: (message) => warnings.push(message),
      fetch: responder({ [url]: xml_response(only_far_future_feed, url) }),
    });

    assertEquals(cache.feeds[url], good_cache.feeds[url]);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "keeping cached entries");

    const on_disk = await Deno.readTextFile(cache_file);
    assert(
      !on_disk.includes("+012345"),
      `an expanded year reached the cache file:\n${on_disk}`,
    );
    assertEquals(parse_cache(on_disk).feeds[url], good_cache.feeds[url]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("update_cache refuses to replace a good cache with an unreadable one", async () => {
  const dir = await scratch_dir();
  const feeds_file = `${dir}/blogroll.txt`;
  const cache_file = `${dir}/blogroll-cache.json`;
  const url = "https://future.example/rss.xml";
  const good_text = serialize_cache({
    version: cache_version,
    feeds: {
      [url]: {
        refreshedAt: "2026-04-01T00:00:00.000Z",
        entries: [{
          title: "Stale but readable",
          url: "https://future.example/stale.html",
          date: "2026-03-30T00:00:00.000Z",
        }],
      },
    },
  }, [url]);

  try {
    await Deno.writeTextFile(feeds_file, `${url}\n`);
    await Deno.writeTextFile(cache_file, good_text);

    // Simulates any producer bug that gets an unpersistable date this far: the
    // stale record handed to `update_cache` is already poisoned.
    const poisoned: BlogrollCache = {
      version: cache_version,
      feeds: {
        [url]: {
          refreshedAt: "2026-04-01T00:00:00.000Z",
          entries: [{
            title: "Year 12345 post",
            url: "https://future.example/12345.html",
            date: "+012345-01-05T00:00:00.000Z",
          }],
        },
      },
    };

    await assertRejects(
      () =>
        update_cache({
          feeds_file,
          cache_file,
          previous: poisoned,
          now: frozen_now,
          warn: () => {},
          fetch: () => Promise.reject(new TypeError("offline")),
        }),
      Error,
      "unreadable",
    );

    assertEquals(await Deno.readTextFile(cache_file), good_text);
    assertEquals(
      await Deno.readTextFile(`${cache_file}.tmp`).catch(() => "absent"),
      "absent",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("refresh_feed fails when the request rejects", async () => {
  const url = "https://offline.example/feed.xml";
  const result = await refresh_feed(url, {
    fetch: () => Promise.reject(new TypeError("connection refused")),
  });

  assert(!result.ok);
  assertStringIncludes(result.reason, "connection refused");
});

Deno.test("refresh_cache keeps stale entries for a failing feed", async () => {
  const good = "https://example.com/feed.xml";
  const bad = "https://down.example/feed.xml";
  const missing = "https://new.example/feed.xml";
  const previous: BlogrollCache = {
    version: cache_version,
    feeds: {
      [bad]: {
        refreshedAt: "2026-04-01T00:00:00.000Z",
        entries: [{
          title: "Stale but good",
          url: "https://down.example/stale.html",
          date: "2026-03-30T00:00:00.000Z",
        }],
      },
    },
  };

  const warnings: string[] = [];
  const cache = await refresh_cache([good, bad, missing], {
    previous,
    warn: (message) => warnings.push(message),
    now: frozen_now,
    fetch: responder({
      [good]: xml_response(atom_feed, good),
      [bad]: () => new Response("", { status: 500 }),
      [missing]: () => new Response("", { status: 404 }),
    }),
  });

  assertEquals(Object.keys(cache.feeds), [good, bad]);
  assertEquals(cache.feeds[good].refreshedAt, "2026-05-01T12:00:00.000Z");
  assertEquals(cache.feeds[bad], previous.feeds[bad]);
  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[0], bad);
  assertStringIncludes(warnings[0], "keeping cached entries");
  assertStringIncludes(warnings[1], missing);
  assertStringIncludes(warnings[1], "no cached entries");
});

Deno.test("blogroll_entries respects canonical list, dedupes, limits and sorts", () => {
  const cache: BlogrollCache = {
    version: cache_version,
    feeds: {
      "https://a.example/feed.xml": {
        refreshedAt: "2026-05-01T00:00:00.000Z",
        entries: [
          {
            title: "A1",
            url: "https://a.example/1",
            date: "2026-01-02T00:00:00.000Z",
          },
          {
            title: "A2",
            url: "https://a.example/2",
            date: "2026-01-04T00:00:00.000Z",
          },
          {
            title: "A3",
            url: "https://a.example/3",
            date: "2026-01-01T00:00:00.000Z",
          },
          {
            title: "A4",
            url: "https://a.example/4",
            date: "2026-01-09T00:00:00.000Z",
          },
        ],
      },
      "https://b.example/feed.xml": {
        refreshedAt: "2026-05-01T00:00:00.000Z",
        entries: [
          {
            title: "B1",
            url: "https://b.example/1",
            date: "2026-01-03T00:00:00.000Z",
          },
          {
            title: "A2 mirrored",
            url: "https://a.example/2",
            date: "2026-01-04T00:00:00.000Z",
          },
        ],
      },
      "https://removed.example/feed.xml": {
        refreshedAt: "2026-05-01T00:00:00.000Z",
        entries: [
          {
            title: "Gone",
            url: "https://removed.example/1",
            date: "2026-02-01T00:00:00.000Z",
          },
        ],
      },
    },
  };

  const entries = blogroll_entries(cache, [
    "https://a.example/feed.xml",
    "https://b.example/feed.xml",
    "https://never-cached.example/feed.xml",
  ]);

  assertEquals(entries.map((entry) => entry.title), ["A2", "B1", "A1", "A3"]);
  assertEquals(
    entries.map((entry) => entry.date.toISOString()),
    [
      "2026-01-04T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ],
  );
});

Deno.test("serialize_cache is deterministic and round-trips", () => {
  const cache: BlogrollCache = {
    version: cache_version,
    feeds: {
      "https://b.example/feed.xml": {
        refreshedAt: "2026-05-01T00:00:00.000Z",
        entries: [{
          title: "B",
          url: "https://b.example/1",
          date: "2026-01-01T00:00:00.000Z",
        }],
      },
      "https://a.example/feed.xml": {
        refreshedAt: "2026-05-01T00:00:00.000Z",
        entries: [{
          title: "A",
          url: "https://a.example/1",
          date: "2026-01-02T00:00:00.000Z",
        }],
      },
      "https://dropped.example/feed.xml": {
        refreshedAt: "2026-05-01T00:00:00.000Z",
        entries: [],
      },
    },
  };
  const urls = ["https://a.example/feed.xml", "https://b.example/feed.xml"];

  const text = serialize_cache(cache, urls);
  assert(text.endsWith("}\n"));
  assertEquals(text, serialize_cache(parse_cache(text), urls));
  assertEquals(Object.keys(parse_cache(text).feeds), urls);
});

Deno.test("parse_cache rejects malformed caches", () => {
  const cases = [
    "not json",
    `{"version": 99, "feeds": {}}`,
    `{"version": 1}`,
    `{"version": 1, "feeds": {"https://a.example/f": {"entries": []}}}`,
    `{"version": 1, "feeds": {"https://a.example/f": {"refreshedAt": "2026-05-01T00:00:00.000Z"}}}`,
    `{"version": 1, "feeds": {"https://a.example/f": {"refreshedAt": "2026-05-01T00:00:00.000Z", "entries": [{"title": "", "url": "https://a.example/1", "date": "2026-01-01T00:00:00.000Z"}]}}}`,
    `{"version": 1, "feeds": {"https://a.example/f": {"refreshedAt": "2026-05-01T00:00:00.000Z", "entries": [{"title": "t", "url": "/relative", "date": "2026-01-01T00:00:00.000Z"}]}}}`,
    `{"version": 1, "feeds": {"https://a.example/f": {"refreshedAt": "2026-05-01T00:00:00.000Z", "entries": [{"title": "t", "url": "https://a.example/1", "date": "yesterday"}]}}}`,
    // Expanded years round-trip through `Date`, but not through this cache.
    `{"version": 1, "feeds": {"https://a.example/f": {"refreshedAt": "2026-05-01T00:00:00.000Z", "entries": [{"title": "t", "url": "https://a.example/1", "date": "+012345-01-05T00:00:00.000Z"}]}}}`,
    `{"version": 1, "feeds": {"https://a.example/f": {"refreshedAt": "+012345-01-05T00:00:00.000Z", "entries": []}}}`,
  ];
  for (const text of cases) {
    let threw = false;
    try {
      parse_cache(text);
    } catch {
      threw = true;
    }
    assert(threw, `expected parse_cache to reject: ${text}`);
  }
});

Deno.test("a serialized expanded year cannot be read back", () => {
  const url = "https://future.example/feed.xml";
  const text = serialize_cache({
    version: cache_version,
    feeds: {
      [url]: {
        refreshedAt: "2026-05-01T00:00:00.000Z",
        entries: [{
          title: "Year 12345 post",
          url: "https://future.example/12345.html",
          date: new Date(Date.UTC(12345, 0, 5)).toISOString(),
        }],
      },
    },
  }, [url]);

  assertStringIncludes(text, "+012345");
  let threw = false;
  try {
    parse_cache(text);
  } catch {
    threw = true;
  }
  assert(threw, "an expanded year must not survive serialize -> parse");
});

Deno.test("the committed cache covers exactly the canonical feed list", async () => {
  const urls = parse_feed_list(
    await Deno.readTextFile("content/blogroll.txt"),
  );
  const text = await Deno.readTextFile("content/blogroll-cache.json");
  const cache = parse_cache(text);
  assertEquals(
    Object.keys(cache.feeds),
    urls,
    "content/blogroll-cache.json is out of step with content/blogroll.txt: " +
      "run `deno task update-blogroll` and commit the result",
  );
  assertEquals(serialize_cache(cache, urls), text);
  assert(blogroll_entries(cache, urls).length > 0);
});
