# Signal — a self-updating AI news wire

A static AI-news aggregator hosted on GitHub Pages. Newest headlines first, filterable by source and by topic, each card links out to the original article.

## Architecture

The browser never talks to RSS feeds or a CORS proxy — that's the deliberate design choice here, since public proxies (allorigins, corsproxy.io, rss2json, codetabs, etc.) are unreliable and get blocked on some networks. Instead, a **GitHub Actions workflow** runs `scripts/fetch-feeds.mjs` on GitHub's own servers on a schedule (plus on-demand and on every push to `main`). That script fetches and parses every feed in `feeds.json`, normalizes the items, and commits the result to `data/feed.json`. The static page, `index.html`, only ever does `fetch('./data/feed.json')` — a same-origin request to a file already sitting in the repo. Nothing in the browser touches the outside internet, so the page loads instantly and never breaks because of a blocked proxy or a CORS error.

## Setup (first time)

1. Create a GitHub repo and push these files to `main`.
2. Enable Pages: **Settings → Pages → Source = "Deploy from a branch"**, Branch = `main`, folder = `/ (root)`.
3. Let Actions commit back to the repo: **Settings → Actions → General → Workflow permissions = "Read and write permissions"**.
4. Trigger the first run: **Actions tab → "Update feeds" → "Run workflow"** (or just push — it also runs on push to `main`).
5. Visit `https://<username>.github.io/<repo>/`.

The repo ships with a real `data/feed.json` from a local test run, so the page isn't blank even before the first Action run.

## Adding or removing a source

Edit `feeds.json` — it's a flat list of `{ "name", "url" }` pairs pointing at RSS or Atom feed URLs. Commit the change; the next scheduled run (or a manual trigger) will pick it up.

The list currently mixes two kinds of sources on purpose: lab/vendor blogs (OpenAI, DeepMind, Hugging Face, NVIDIA, Google AI) for product and research announcements, and general tech press (TechCrunch AI, VentureBeat AI, Wired AI, Ars Technica AI, MIT Tech Review, AI News) for the less-technical-but-important coverage — funding, leadership moves, company strategy, policy. Lean further into either direction by adding more of that type.

Note: several major AI companies — Anthropic, Meta AI, Mistral, Cohere, Perplexity — don't publish an official RSS feed. To include them you'd need to point at a community-maintained mirror feed and add it as a normal entry here. Also note that some publishers only keep a *general* RSS feed and have dropped topic-specific ones (e.g. The Verge's `/rss/artificial-intelligence/` feed now returns zero entries) — if a URL parses but always yields 0 items, check the source's site for a working feed URL before assuming the script is at fault.

## Topic categories

Each item is auto-tagged with a topic — `People & Leadership`, `Policy & Safety`, `Business & Funding`, `Open Source`, `Hardware & Infra`, `Research`, `Product`, or a `News` catch-all — by matching keyword patterns against its title and summary (see `CATEGORY_RULES` in `scripts/fetch-feeds.mjs`; the first matching rule wins, in that priority order). This runs entirely offline in the fetch script, no API calls or LLM involved, so it's free but occasionally imprecise — a headline that just happens to mention "founder" or "billion" in passing can get misfiled. Adjust or add patterns in `CATEGORY_RULES` to tune it; the site's topic chips are generated automatically from whatever categories are present in `data/feed.json`.

## Changing the refresh frequency

Edit the `cron` line in [.github/workflows/update-feeds.yml](.github/workflows/update-feeds.yml). It currently runs hourly at `:17` (offset from the top of the hour, since GitHub's scheduler is busiest at `:00`). Cron syntax is standard 5-field UTC.

## Running the fetcher locally

```bash
npm install
node scripts/fetch-feeds.mjs
```

This writes `data/feed.json` and prints a per-feed summary (item count or failure reason). One bad feed never fails the whole run — the script only exits non-zero if *every* feed fails and nothing was written.

## Troubleshooting

- **Page shows nothing / "No signal yet"** — check that the `Update feeds` Action ran green (Actions tab) and that `data/feed.json` actually has items in it.
- **One source is always empty** — its feed URL likely changed or now requires a different endpoint; check the Action logs for that source's failure reason, and swap in a working URL (or a mirror) in `feeds.json`.
- **Workflow can't push** — re-check step 3 above (workflow permissions must be "Read and write").

## Notes

- This is an aggregator: cards show title + a short (~240 char) summary + a link out. Full article text is never reproduced.
- No secrets or API keys are needed — the workflow uses the repo's built-in `GITHUB_TOKEN`.
- The only runtime dependency is [`fast-xml-parser`](https://www.npmjs.com/package/fast-xml-parser), used to robustly parse both RSS and Atom feeds.
