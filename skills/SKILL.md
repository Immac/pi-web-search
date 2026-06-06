---
name: web-search
description: Browser-backed web search using the web-search tool and Lightpanda. Use when you need current facts, source-backed results, or a quick search/refinement loop.
---

# Web Search Extension Skill

## Overview

This extension provides 5 tools for web research, with a priority chain:

```
web-search:   Brave API → Google CSE → Tavily → SearXNG → Lightpanda → Playwright
open-url:     Lightpanda → Playwright
```

- **Official search APIs** (Brave, Google CSE, Tavily) are tried first — clean JSON, no blocking, purpose-built for LLM/programmatic access. Configure via env vars (no key = skipped).
- **SearXNG** aggregates across 70+ engines, so if one blocks others still work. Auto-detects at `http://localhost:8888`.
- **Lightpanda** is the primary renderer: fast, lightweight, no JavaScript.
- **Playwright** is the final fallback for JavaScript-heavy or bot-protected sites.
- **Results are cached** (5 min for search, 1 hour for pages) — repeated queries are instant.

## Quick Start

### Basic Search
```bash
web-search --query "Yasaka Kanako"
# → Tries Brave API → Google CSE → Tavily → SearXNG → Lightpanda → Playwright
# If any API key is configured, that backend is tried first and falls through if it fails.
```

### Direct URL Access
```bash
open-url --url "https://en.wikipedia.org/wiki/Touhou_Project"
# → Lightpanda → Playwright if needed
```

### Fallback Chain
Tools automatically try: **Brave API → Google CSE → Tavily → SearXNG → Lightpanda → Playwright**

API backends are tried in priority order. Each is skipped if its env var is unset.

## Detailed Tool Usage

### 1. web-search
**When to use:**
- Current or rapidly changing facts
- Documentation lookup
- Source-backed verification
- Refining a query after noisy results

**Fallback chain:**
1. **Brave Search API** — 2,000 free queries/month. Clean JSON. Set `WEBSEARCH_BRAVE_KEY`.
2. **Google CSE** — 100 free queries/day. Set `WEBSEARCH_GOOGLE_KEY` + `WEBSEARCH_GOOGLE_CX`.
3. **Tavily** — 1,000 free queries/month. Purpose-built for LLM RAG. Set `WEBSEARCH_TAVILY_KEY`.
4. **SearXNG** — Returns parsed `{title, snippet, url}` results. Fast, structured, engine-diverse.
5. **Lightpanda** — Renders Bing HTML search as markdown. Works for most queries.
6. **Playwright** — Full browser automation. Handles JS-heavy or protected sites.

**Workflow:**
1. Start with a precise query
2. Call `web-search` with the query
3. Read the returned results
4. If noisy, narrow with quoted phrases or `site:` filters
5. Prefer checking linked sources before answering with high confidence

### 2. open-url
**When to use:**
- You already know the page URL
- Search results point to a specific page
- Need to inspect page content directly

**Fallback chain:**
1. **Lightpanda** — Fast rendering
2. **Playwright** — If Lightpanda is blocked or can't handle JS

### 3. install-lightpanda
**When to use:**
- `web-search` or `open-url` reports Lightpanda is missing
- Setting up the extension for the first time

**What it does:**
- Downloads Lightpanda binary for your platform
- Installs to `~/.pi/agent/bin/lightpanda`
- Auto-detects platform (Linux x64/arm64, macOS)

### 4. install-playwright
**When to use:**
- Playwright fallback reports Playwright is missing
- Need Chromium browser for difficult pages

**What it does:**
- Installs Playwright in the extension's package runtime
- Used as the final fallback when Lightpanda fails

### 5. set-browser-fallback
**When to use:**
- Automatic browser detection for Playwright fails
- You want to use a specific Chromium-based browser (Brave, Chrome, etc.)

**Example:**
```bash
set-browser-fallback --browserPath /usr/bin/brave-browser-stable
```

## Configuration

### API Key Management (via Secret Store)

API keys go in environment variables. The recommended workflow:

```bash
# Store your key in the secret store (safe, persisted in auth.json)
ask_secret --key WEBSEARCH_BRAVE_KEY --prompt "Enter your Brave Search API key"

# Then when starting pi, load it:
with_secret --key WEBSEARCH_BRAVE_KEY -- env WEBSEARCH_BRAVE_KEY=$SECRET pi
```

Alternatively, set them directly in your shell profile or pi config.

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `WEBSEARCH_BRAVE_KEY` | Brave Search API key (2,000 free queries/mo) | — |
| `WEBSEARCH_GOOGLE_KEY` | Google CSE API key (100 free queries/day) | — |
| `WEBSEARCH_GOOGLE_CX` | Google CSE search engine ID | — |
| `WEBSEARCH_TAVILY_KEY` | Tavily API key (1,000 free queries/mo) | — |
| `LIGHTPANDA_BIN` | Path to Lightpanda binary | `~/.pi/agent/bin/lightpanda` |
| `WEBSEARCH_URL_TEMPLATE` | Fallback search URL (when SearXNG is unavailable) | Bing HTML |
| `WEBSEARCH_BACKEND` | Search backend: `auto`, `searxng`, or `bing` | `auto` |
| `WEBSEARCH_SEARXNG_URL` | SearXNG instance URL | `http://localhost:8888` |
| `BROWSER_FALLBACK_BIN` | Browser path for Playwright fallback | Auto-detected |

API keys are checked at runtime. If the corresponding env var is unset, that backend is skipped entirely (no error).

### Search Backend Selection

Set `WEBSEARCH_BACKEND` to control which search source is used:

- **`auto`** (default) — Probes `http://localhost:8888` for SearXNG at search time. If found, uses it. Otherwise, falls back to the URL template.
- **`searxng`** — Always use SearXNG. Fails if unreachable.
- **`bing`** — Skip SearXNG, go straight to Lightpanda/Bing.

Example:
```bash
export WEBSEARCH_BACKEND=searxng
export WEBSEARCH_SEARXNG_URL=http://192.168.1.50:8888
```

## Advanced Patterns

### Query Refinement Loop

The fundamental research loop: search → inspect → refine → verify.

```
1. web-search "Touhou Project"
   → Broad results. Identifies topics like "Mountain of Faith", "Yasaka Kanako"
2. web-search "Yasaka Kanako site:en.wikipedia.org"
   → Narrowed to Wikipedia. Finds exact article.
3. open-url "https://en.wikipedia.org/wiki/Mountain_of_Faith"
   → Full page content. Read for details.
```

**Refinement techniques:**

| Technique | Example | Effect |
|---|---|---|
| Exact phrase | `"climate change policy"` | Match words in order |
| Exclude term | `jaguar -car` | Remove results about cars |
| Site filter | `node.js site:developer.mozilla.org` | Limit to one domain |
| File type | `report filetype:pdf` | Filter by format |
| Intitle | `intitle:"API reference"` | Match title only |
| Combine | `"Touhou" site:en.wikipedia.org -"List of"` | Narrow + exclude |

### Result Format by Backend

Knowing which backend served the result helps you interpret the output:

| Backend | Output Format | Content Quality | Speed |
|---|---|---|---|
| **SearXNG** | Structured `{title, snippet, url}` per result. Source engine noted. | Snippets may truncate. Consistently formatted. | Fastest (~1-3s) |
| **Lightpanda** | Rendered page → plain markdown. Full HTML stripped to text. | Complete page text. May lose table structures. | Fast (~3-5s) |
| **Playwright** | Full browser render → `innerText` or fallback HTML→markdown | Highest fidelity, handles JS. Slower. | Slow (~5-15s) |

SearXNG results include `*(via engine_name)` per link — this tells you which of 70+ engines contributed that result. If a specific engine is unreliable, you know which results to treat with caution.

### Handling Protected Sites (Cloudflare, etc.)
- Lightpanda may fail on protected sites
- Playwright is more reliable but still detectable
- Truly locked-down sites (Turnstile) may need manual browsing
- Wikipedia works well with all backends
- SearXNG handles search queries without ever hitting protected search pages
- If all automated backends fail on a search: try SearXNG as a backend (it aggregates across engines many of which won't trigger protections)

### Performance & Cache Strategy

- **SearXNG** is the fastest path — aim for this as your default search backend
- **Cached results** serve instantly — repeat a query you ran 2 minutes ago with no network cost
- **Cache TTL**: 5 minutes for searches, 1 hour for pages
- If you need fresh results: either wait for TTL expiry, or delete the cache directory
- **Cache location**: `~/.pi/agent/cache/web-search/`
- **Clear cache**: `rm -rf ~/.pi/agent/cache/web-search/`

### SearXNG Setup (Docker)
```bash
docker run -d -p 8888:8080 --name searxng searxng/searxng
```
Point `WEBSEARCH_SEARXNG_URL=http://localhost:8888` and the extension will auto-detect it.

### Browser Detection Cache

The extension caches the result of browser detection for Playwright fallback. If you install a new browser while pi is running, restart pi (or reload the extension) to pick it up. The cache avoids re-probing all system binaries on every Playwright attempt.

## Troubleshooting

### "Lightpanda is not available"
1. Run `install-lightpanda`
2. Or set `LIGHTPANDA_BIN` manually
3. Verify: `/path/to/lightpanda version`

### "Playwright is not available"
1. Run `install-playwright`
2. Check: `cd ~/.pi-extensions/web-search && npm list playwright`
3. Ensure browser binaries are installed: `npx playwright install chromium`

### SearXNG not detected
1. Verify SearXNG is running: `curl http://localhost:8888/search?q=test&format=json`
2. Check `WEBSEARCH_SEARXNG_URL` is correct
3. Try setting `WEBSEARCH_BACKEND=searxng` explicitly
4. Docker: `docker ps` to verify the container is running

### All fallbacks failed
- Site may have strong anti-bot protection
- Try waiting before retrying
- Consider setting up SearXNG for search queries (bypasses protected search pages entirely)
- For particularly locked-down sites, manual browsing may be needed

### "Results look stale"
- Cache TTL is 5 min for searches, 1 hour for pages
- Force a fresh fetch: `rm -rf ~/.pi/agent/cache/web-search/`

## Development Notes

- Tools return rendered pages as markdown, not curated answers
- SearXNG returns structured `{title, snippet, url}` results from 70+ engines
- Use as a research step, then synthesize the result
- No robots.txt compliance (designed for single targeted requests)
- Lightpanda is fast but may not handle JavaScript-heavy pages
- Playwright handles JavaScript but is slower
- For bulk scraping, use dedicated tools (this extension is for targeted research)
- The extension has unit tests under `__tests__/` — run them with `npm test`
- After modifying the extension, validate with `npm run validate` and `npm test`
