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

// Ordered most-specific-first: the first category whose pattern matches wins.
const CATEGORY_RULES = [
  {
    name: "People & Leadership",
    pattern:
      /\b(CEO|CTO|CFO|co-founder|cofounder|founder|chief executive|chief scientist|steps down|stepping down|resigns?|resignation|departs?|departure|ousted|fired|hires?|hiring|hired|appoints?|appointed|joins as|names? .* as|promotes?|promoted|succeeds|board member|executive team|leadership shake-?up|Demis Hassabis|Sam Altman|Dario Amodei|Daniela Amodei|Sundar Pichai|Satya Nadella|Mark Zuckerberg|Elon Musk|Jensen Huang|Mustafa Suleyman|Yann LeCun|Ilya Sutskever|Greg Brockman|Mira Murati|Clement Delangue|Arthur Mensch|Jack Dorsey|Reid Hoffman)\b/i,
  },
  {
    name: "Policy & Safety",
    pattern:
      /\b(regulat\w*|lawsuit|sues?|sued|legal battle|ban(?:s|ned)?|antitrust|copyright|lawmakers?|congress|senate|EU AI Act|court(?:s)?\b|fined|penalty|child safety|privacy law|compliance|safety (?:concerns?|risk|threshold)|ethics|misinformation|deepfake|jailbreak|watchdog|FTC|European Commission)\b/i,
  },
  {
    name: "Business & Funding",
    pattern:
      /\b(raises?|raised|funding round|series [A-E]\b|valuation|valued at|IPO|acqui(?:res?|sition|red)|merger|invest(?:s|ment|ing)?|venture capital|VC firm|stake in|revenue|earnings|profit|layoffs?|job cuts|billion|million in \w+|market cap|shares? (?:rise|fall|jump))\b/i,
  },
  {
    name: "Open Source",
    pattern:
      /\b(open[- ]?source|open[- ]?weights?|open[- ]?model|MIT licen[cs]e|apache licen[cs]e|GitHub repo|weights (?:are )?(?:now )?available|dataset release|releases? the (?:model|weights|code))\b/i,
  },
  {
    name: "Hardware & Infra",
    pattern:
      /\b(chip|GPU|TPU|NPU|data ?center|datacentre|server cluster|silicon(?!\s+valley)|semiconductor|processor|accelerator|supercomputer|cloud infrastructure|compute capacity)\b/i,
  },
  {
    name: "Research",
    pattern:
      /\b(paper|research(?:ers)?|study finds|arxiv|benchmark|architecture|training data|fine-?tun\w*|breakthrough|algorithm|neural network|reasoning model|model card)\b/i,
  },
  {
    name: "Product",
    pattern:
      /\b(launches?|launch(?:ed|ing)?|unveils?|introduces?|announc\w*|rolls? out|rolling out|now available|new feature|update to|beta|preview|integrat\w*)\b/i,
  },
];

function categorize(title, summary) {
  const text = `${title} ${summary}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.name;
  }
  return "News";
}

// Ordered most-specific-first: company names are stronger signals than
// generic country words, so they're checked first within each region.
const REGION_RULES = [
  {
    name: "India",
    pattern:
      /\b(India|Indian|Bengaluru|Bangalore|Mumbai|New Delhi|Hyderabad|Krutrim|Sarvam|Ola Krutrim|Reliance Jio|Infosys|Wipro|TCS|HCLTech|Zoho)\b/i,
  },
  {
    name: "China",
    pattern:
      /\b(China|Chinese|Beijing|Shenzhen|Hangzhou|Alibaba|Baidu|Tencent|Huawei|SenseTime|iFlytek|Zhipu|Moonshot AI|DeepSeek|ByteDance|ByteDance's|Xiaomi|Qwen)\b/i,
  },
  {
    name: "Europe",
    pattern:
      /\b(Europe|European|EU\b|Germany|German|France|French|United Kingdom|\bUK\b|Britain|British|London|Berlin|Paris|Mistral|Aleph Alpha|Stability AI|DeepL)\b/i,
  },
  {
    name: "Japan",
    pattern: /\b(Japan|Japanese|Tokyo|SoftBank|Sakana AI|Preferred Networks|Sony|NTT)\b/i,
  },
  {
    name: "South Korea",
    pattern: /\b(South Korea|Korean?|Seoul|Samsung|Naver|Kakao|LG (?:AI|Electronics))\b/i,
  },
  {
    name: "Middle East",
    pattern: /\b(UAE|United Arab Emirates|Saudi(?: Arabia)?|Abu Dhabi|Dubai|Qatar|G42|Falcon LLM)\b/i,
  },
  {
    name: "United States",
    pattern:
      /\b(United States|U\.S\.|\bUS\b|America|American|Washington|California|Silicon Valley|OpenAI|Anthropic|Microsoft|Meta\b|Amazon|Apple\b)\b/,
  },
];

function detectRegion(title, summary) {
  const text = `${title} ${summary}`;
  for (const rule of REGION_RULES) {
    if (rule.pattern.test(text)) return rule.name;
  }
  return "Global";
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
  const category = categorize(title, summary);
  const region = detectRegion(title, summary);
  return { source: sourceName, title, summary, link, date, category, region };
}

function normalizeAtomEntry(entry, sourceName, runIso) {
  const title = stripHtml(entry.title?.["#text"] ?? entry.title ?? "");
  const link = extractAtomLink(entry.link);
  const rawSummary =
    entry.summary?.["#text"] ?? entry.summary ?? entry.content?.["#text"] ?? entry.content ?? "";
  const summary = truncate(stripHtml(rawSummary), SUMMARY_MAX_LEN);
  const date = toIso(entry.updated ?? entry.published, runIso);
  const category = categorize(title, summary);
  const region = detectRegion(title, summary);
  return { source: sourceName, title, summary, link, date, category, region };
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

// General (non-AI-scoped) publications — e.g. a country's whole tech section —
// get an extra relevance pass so phone launches and unrelated stories don't
// dilute the wire. Feeds already scoped to AI at the source (category/tag
// URLs) skip this and are trusted as-is.
const AI_RELEVANCE_PATTERN =
  /\b(AI\b|A\.I\.|artificial intelligence|machine learning|\bLLM\b|large language model|chatbot|generative AI|neural network|deep learning|GPT-?\d|ChatGPT|Copilot\b|Gemini\b|Claude\b|Llama\b|Mistral\b|Qwen\b|DeepSeek\b|OpenAI|Anthropic|DeepMind|Hugging Face|NVIDIA|Sarvam|Krutrim|robotics?\b|autonomous\b|algorithm(?:s|ic)?\b)/i;

function fetchScopedItems(rawItems, feed, runIso, normalizeFn) {
  const isBroad = feed.scope === "broad";
  const cap = isBroad ? MAX_ITEMS_PER_FEED * 6 : MAX_ITEMS_PER_FEED;
  return asArray(rawItems)
    .slice(0, cap)
    .map((raw) => normalizeFn(raw, feed.name, runIso))
    .filter((it) => it.title && it.link)
    .filter((it) => !isBroad || AI_RELEVANCE_PATTERN.test(`${it.title} ${it.summary}`))
    .slice(0, MAX_ITEMS_PER_FEED);
}

async function fetchFeed(feed, runIso) {
  const res = await fetchWithTimeout(feed.url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const xml = await res.text();
  const doc = parser.parse(xml);

  if (doc.rss?.channel) {
    return fetchScopedItems(doc.rss.channel.item, feed, runIso, normalizeRssItem);
  }

  if (doc["rdf:RDF"]?.item) {
    // RSS 1.0 (RDF) — rare, but handle it
    return fetchScopedItems(doc["rdf:RDF"].item, feed, runIso, normalizeRssItem);
  }

  if (doc.feed) {
    return fetchScopedItems(doc.feed.entry, feed, runIso, normalizeAtomEntry);
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
  const categories = CATEGORY_RULES.map((r) => r.name).filter((name) =>
    allItems.some((it) => it.category === name)
  );
  if (allItems.some((it) => it.category === "News")) categories.push("News");
  const regions = [...REGION_RULES.map((r) => r.name), "Global"].filter((name) =>
    allItems.some((it) => it.region === name)
  );

  const output = {
    updated: runIso,
    count: allItems.length,
    sources,
    categories,
    regions,
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
