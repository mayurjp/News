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

// Identify honestly by default — this is a feed reader fetching public RSS,
// not a browser. A few publishers 403 unrecognized bots regardless, so as a
// last resort we retry those specific requests with a browser UA rather than
// leading with a spoofed identity.
const BOT_USER_AGENT = "SignalNewsBot/1.0 (+https://github.com/mayurjp/News)";
const BROWSER_USER_AGENT_FALLBACK =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  // Some legitimate feeds (e.g. long academic blog posts with heavily
  // HTML-entity-encoded content) exceed fast-xml-parser's default entity
  // count guard. Raise the count ceiling but keep depth/size limits at their
  // safe defaults, so a genuine entity-expansion attack is still blocked.
  processEntities: { maxTotalExpansions: 20_000 },
});

const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…",
};

function decodeEntitiesOnce(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(nbsp|amp|lt|gt|quot|apos|rsquo|lsquo|rdquo|ldquo|mdash|ndash|hellip);/g,
      (_, name) => NAMED_ENTITIES[name]);
}

function stripHtml(str) {
  if (!str) return "";
  let text = String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ");
  // Run twice: some CMSes double-encode (e.g. "&amp;nbsp;" unwraps to a
  // fresh "&nbsp;" after one pass), so a single pass can leave literal
  // entities behind.
  text = decodeEntitiesOnce(decodeEntitiesOnce(text));
  return text.replace(/\s+/g, " ").trim();
}

function truncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max - 1).trimEnd() + "…";
}

// Ordered most-specific-first: the first category whose pattern matches wins.
const CATEGORY_RULES = [
  {
    name: "Security & Cyber Risk",
    pattern:
      /\b(hack(?:ed|ers?|ing)?|breach(?:ed|es)?|cyber\s?(?:risk|attack|security)?|vulnerab\w+|exploit(?:ed|s)?|malware|ransomware|phishing|zero-day|rogue (?:AI|model|agent)|went rogue|security (?:test|risk|threshold|platform|concerns?|breach))\b/i,
  },
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
      /\b(raises?|raised|funding round|series [A-E]\b|valuation|valued at|IPO|acqui(?:res?|sition|red)|merger|invest(?:s|ment|ing)?|venture capital|VC firm|stake in|revenue|earnings|profit|layoffs?|job cuts|billion|million in \w+|market cap|shares? (?:rise|fall|jump)|bubble|stock market)\b/i,
  },
  {
    name: "Enterprise & Deployment",
    pattern:
      /\b(case study|partners? with|partnership with|deploys?|deployment|rolled out internally|adopts? AI|adopting AI|uses? AI to|customer story|in production)\b/i,
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
      /\b(India|Indian|Bengaluru|Bangalore|Mumbai|New Delhi|Hyderabad|Pune|Chennai|Gurugram|Gurgaon|Krutrim|Sarvam|Ola Krutrim|Reliance(?: Jio| Industries)?|Adani|Tata(?: Group| Consultancy| Sons)?|TCS|Infosys|Wipro|HCLTech|Zoho|Jio\b|Airtel|Flipkart|Paytm|Byju'?s|Freshworks|MeitY|RBI\b)\b/i,
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

// Cross-source duplicate detection: the same wire story often runs on
// multiple outlets with near-identical (sometimes verbatim) headlines. We
// merge those into one card with the others listed as relatedSources,
// rather than showing the same story 2-3 times in the wire.
const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "is", "are",
  "its", "it", "at", "as", "with", "by", "from", "says", "said", "new",
  "after", "over", "will",
]);
const DUPLICATE_SIMILARITY_THRESHOLD = 0.35;
const DUPLICATE_WINDOW_MS = 48 * 60 * 60 * 1000;

function titleWords(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// items must already be sorted newest-first.
function dedupeItems(items) {
  const enriched = items.map((it) => ({ it, words: titleWords(it.title) }));
  const used = new Array(items.length).fill(false);
  const result = [];

  for (let i = 0; i < enriched.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const group = [enriched[i].it];

    for (let j = i + 1; j < enriched.length; j++) {
      if (used[j] || enriched[i].it.source === enriched[j].it.source) continue;
      const dt = Math.abs(new Date(enriched[i].it.date) - new Date(enriched[j].it.date));
      if (dt > DUPLICATE_WINDOW_MS) continue;
      if (jaccard(enriched[i].words, enriched[j].words) >= DUPLICATE_SIMILARITY_THRESHOLD) {
        used[j] = true;
        group.push(enriched[j].it);
      }
    }

    if (group.length > 1) {
      const [primary, ...rest] = group;
      result.push({
        ...primary,
        relatedSources: rest.map((r) => ({ source: r.source, link: r.link })),
      });
    } else {
      result.push(group[0]);
    }
  }

  return result;
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

const IMAGE_TYPE_PATTERN = /^image\//i;

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// Only pulls images the feed itself offers for syndication (media:thumbnail,
// media:content, RSS enclosures, Atom enclosure links) — never scrapes the
// publisher's full article page. Falls back to the first <img> embedded in
// the feed's own description/content HTML, since many WordPress-style feeds
// put the lead image there instead of a structured media tag.
function extractImage(node, rawHtmlForFallback) {
  const thumb = asArray(node["media:thumbnail"])[0];
  if (thumb?.["@_url"] && isHttpUrl(thumb["@_url"])) return thumb["@_url"];

  const mediaContents = asArray(node["media:content"]);
  const mediaImage = mediaContents.find(
    (m) => m && (m["@_medium"] === "image" || IMAGE_TYPE_PATTERN.test(m["@_type"] ?? ""))
  );
  if (mediaImage?.["@_url"] && isHttpUrl(mediaImage["@_url"])) return mediaImage["@_url"];

  const enclosures = asArray(node.enclosure);
  const enclosureImage = enclosures.find((e) => e && IMAGE_TYPE_PATTERN.test(e["@_type"] ?? ""));
  if (enclosureImage?.["@_url"] && isHttpUrl(enclosureImage["@_url"])) return enclosureImage["@_url"];

  const linkEnclosures = asArray(node.link).filter((l) => l && typeof l === "object");
  const linkImage = linkEnclosures.find(
    (l) => l["@_rel"] === "enclosure" && IMAGE_TYPE_PATTERN.test(l["@_type"] ?? "")
  );
  if (linkImage?.["@_href"] && isHttpUrl(linkImage["@_href"])) return linkImage["@_href"];

  if (rawHtmlForFallback) {
    const match = String(rawHtmlForFallback).match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match && isHttpUrl(match[1])) return match[1];
  }

  return null;
}

// Some feeds (e.g. The Register) emit a present-but-blank <description/>
// with the real text only in <content:encoded> — a plain ?? chain never
// falls through to it since "" is neither null nor undefined.
function firstNonBlank(...candidates) {
  for (const c of candidates) {
    if (c && stripHtml(c).length > 0) return c;
  }
  return "";
}

function normalizeRssItem(item, sourceName, runIso) {
  const title = stripHtml(item.title?.["#text"] ?? item.title ?? "");
  const link =
    typeof item.link === "string"
      ? item.link
      : item.link?.["#text"] ?? item.link?.["@_href"] ?? "";
  const rawSummary = firstNonBlank(
    item.description?.["#text"] ?? item.description,
    item["content:encoded"]
  );
  const summary = truncate(stripHtml(rawSummary), SUMMARY_MAX_LEN);
  const date = toIso(item.pubDate ?? item.date, runIso);
  const category = categorize(title, summary);
  const region = detectRegion(title, summary);
  const image = extractImage(item, rawSummary);
  return { source: sourceName, title, summary, link, date, category, region, image };
}

function normalizeAtomEntry(entry, sourceName, runIso) {
  const title = stripHtml(entry.title?.["#text"] ?? entry.title ?? "");
  const link = extractAtomLink(entry.link);
  const rawSummary = firstNonBlank(
    entry.summary?.["#text"] ?? entry.summary,
    entry.content?.["#text"] ?? entry.content
  );
  const summary = truncate(stripHtml(rawSummary), SUMMARY_MAX_LEN);
  const date = toIso(entry.updated ?? entry.published, runIso);
  const category = categorize(title, summary);
  const region = detectRegion(title, summary);
  const image = extractImage(entry, rawSummary);
  return { source: sourceName, title, summary, link, date, category, region, image };
}

async function fetchWithTimeout(url, userAgent, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        ...(opts.headers ?? {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Leads with an honest bot identity; only falls back to a browser UA for
// the specific feeds that reject it (non-2xx or the request failing outright).
async function fetchWithUserAgentFallback(url) {
  try {
    const botRes = await fetchWithTimeout(url, BOT_USER_AGENT);
    if (botRes.ok) return { res: botRes, usedFallback: false };
  } catch {
    // fall through to the browser-UA retry below
  }
  const browserRes = await fetchWithTimeout(url, BROWSER_USER_AGENT_FALLBACK);
  return { res: browserRes, usedFallback: true };
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
  const { res, usedFallback } = await fetchWithUserAgentFallback(feed.url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const xml = await res.text();
  const doc = parser.parse(xml);

  let items;
  if (doc.rss?.channel) {
    items = fetchScopedItems(doc.rss.channel.item, feed, runIso, normalizeRssItem);
  } else if (doc["rdf:RDF"]?.item) {
    // RSS 1.0 (RDF) — rare, but handle it
    items = fetchScopedItems(doc["rdf:RDF"].item, feed, runIso, normalizeRssItem);
  } else if (doc.feed) {
    items = fetchScopedItems(doc.feed.entry, feed, runIso, normalizeAtomEntry);
  } else {
    throw new Error("unrecognized feed format");
  }

  return { items, usedFallback };
}

async function main() {
  const runIso = new Date().toISOString();
  const feeds = JSON.parse(await readFile(FEEDS_PATH, "utf8"));

  const results = await Promise.all(
    feeds.map(async (feed) => {
      try {
        const { items, usedFallback } = await fetchFeed(feed, runIso);
        const note = usedFallback ? " (browser-UA fallback)" : "";
        console.log(`${feed.name}: ${items.length} items${note}`);
        return { feed, items };
      } catch (err) {
        const reason = err.name === "AbortError" ? "timeout" : err.message;
        console.log(`${feed.name}: FAILED (${reason})`);
        return { feed, items: [] };
      }
    })
  );

  const fetchedItems = results.flatMap((r) => r.items);
  fetchedItems.sort((a, b) => new Date(b.date) - new Date(a.date));

  const allItems = dedupeItems(fetchedItems);
  const mergedCount = fetchedItems.length - allItems.length;
  console.log(`Deduped ${fetchedItems.length} → ${allItems.length} items (${mergedCount} merged)`);

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
