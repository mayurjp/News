#!/usr/bin/env node
// Fetches every feed in feeds.json, normalizes items, and writes data/feed.json.
// Runs on GitHub Actions (server-side, no CORS) — see .github/workflows/update-feeds.yml.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FEEDS_PATH = path.join(ROOT, "feeds.json");
const OUT_PATH = path.join(ROOT, "data", "feed.json");

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ITEMS_PER_FEED = 10;
const SUMMARY_MAX_LEN = 240;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
});

function stripHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max - 1).trimEnd() + "…";
}

function toIso(dateStr, fallback) {
  if (dateStr) {
    const d = new Date(dateStr);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function extractAtomLink(linkField) {
  const links = asArray(linkField).filter((l) => l && typeof l === "object");
  if (links.length === 0) {
    // Sometimes <link> is a bare string (non-standard but seen in the wild)
    if (typeof linkField === "string") return linkField;
    return "";
  }
  const alt = links.find((l) => (l["@_rel"] ?? "alternate") === "alternate");
  const chosen = alt ?? links[0];
  return chosen["@_href"] ?? "";
}

function normalizeRssItem(item, sourceName, runIso) {
  const title = stripHtml(item.title?.["#text"] ?? item.title ?? "");
  const link =
    typeof item.link === "string"
      ? item.link
      : item.link?.["#text"] ?? item.link?.["@_href"] ?? "";
  const rawSummary =
    item.description?.["#text"] ?? item.description ?? item["content:encoded"] ?? "";
  const summary = truncate(stripHtml(rawSummary), SUMMARY_MAX_LEN);
  const date = toIso(item.pubDate ?? item.date, runIso);
  return { source: sourceName, title, summary, link, date };
}

function normalizeAtomEntry(entry, sourceName, runIso) {
  const title = stripHtml(entry.title?.["#text"] ?? entry.title ?? "");
  const link = extractAtomLink(entry.link);
  const rawSummary =
    entry.summary?.["#text"] ?? entry.summary ?? entry.content?.["#text"] ?? entry.content ?? "";
  const summary = truncate(stripHtml(rawSummary), SUMMARY_MAX_LEN);
  const date = toIso(entry.updated ?? entry.published, runIso);
  return { source: sourceName, title, summary, link, date };
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        ...(opts.headers ?? {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeed(feed, runIso) {
  const res = await fetchWithTimeout(feed.url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const xml = await res.text();
  const doc = parser.parse(xml);

  if (doc.rss?.channel) {
    const items = asArray(doc.rss.channel.item).slice(0, MAX_ITEMS_PER_FEED);
    return items
      .map((item) => normalizeRssItem(item, feed.name, runIso))
      .filter((it) => it.title && it.link);
  }

  if (doc["rdf:RDF"]?.item) {
    // RSS 1.0 (RDF) — rare, but handle it
    const items = asArray(doc["rdf:RDF"].item).slice(0, MAX_ITEMS_PER_FEED);
    return items
      .map((item) => normalizeRssItem(item, feed.name, runIso))
      .filter((it) => it.title && it.link);
  }

  if (doc.feed) {
    const entries = asArray(doc.feed.entry).slice(0, MAX_ITEMS_PER_FEED);
    return entries
      .map((entry) => normalizeAtomEntry(entry, feed.name, runIso))
      .filter((it) => it.title && it.link);
  }

  throw new Error("unrecognized feed format");
}

async function main() {
  const runIso = new Date().toISOString();
  const feeds = JSON.parse(await readFile(FEEDS_PATH, "utf8"));

  const results = await Promise.all(
    feeds.map(async (feed) => {
      try {
        const items = await fetchFeed(feed, runIso);
        console.log(`${feed.name}: ${items.length} items`);
        return { feed, items };
      } catch (err) {
        const reason = err.name === "AbortError" ? "timeout" : err.message;
        console.log(`${feed.name}: FAILED (${reason})`);
        return { feed, items: [] };
      }
    })
  );

  const allItems = results.flatMap((r) => r.items);
  allItems.sort((a, b) => new Date(b.date) - new Date(a.date));

  const sources = feeds.map((f) => f.name);

  const output = {
    updated: runIso,
    count: allItems.length,
    sources,
    items: allItems,
  };

  if (allItems.length === 0) {
    console.error("No items fetched from any feed — refusing to write empty data/feed.json");
    process.exit(1);
  }

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${allItems.length} items from ${results.filter((r) => r.items.length > 0).length}/${feeds.length} sources to ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
