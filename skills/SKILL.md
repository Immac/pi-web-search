---
name: web-search
description: Browser-backed web search using the web-search tool and Lightpanda. Use when you need current facts, source-backed results, or a quick search/refinement loop.
---

# Web Search Extension Skill

## Overview

This extension provides 5 tools for web research, with a priority chain:

```
web-search:   SearXNG (if available) → Lightpanda → Playwright (fallback)
open-url:     Lightpanda → Playwright (fallback)
```

- **SearXNG** is preferred for search — aggregates across 70+ engines, so if one blocks others still work. Auto-detects at `http://localhost:8888`.
- **Lightpanda** is the primary renderer: fast, lightweight, no JavaScript.
- **Playwright** is the final fallback for JavaScript-heavy or bot-protected sites.
- **Results are cached** (5 min for search, 1 hour for pages) — repeated queries are instant.

## Quick Start

### Basic Search
```bash
web-search --query "Yasaka Kanako"
# → Tries SearXNG → falls through to Lightpanda/Bing → falls through to Playwright
```

### Direct URL Access
```bash
open-url --url "https://en.wikipedia.org/wiki/Touhou_Project"
# → Lightpanda → Playwright if needed
```

### Fallback Chain
Tools automatically try: **SearXNG (search only) → Lightpanda → Playwright**

## Detailed Tool Usage

### 1. web-search
**When to use:**
- Current or rapidly changing facts
- Documentation lookup
- Source-backed verification
- Refining a query after noisy results

**Fallback chain:**
1. **SearXNG** — Returns parsed `{title, snippet, url}` results. Fast, structured, engine-diverse.
2. **Lightpanda** — Renders Bing HTML search as markdown. Works for most queries.
3. **Playwright** — Full browser automation. Handles JS-heavy or protected sites.

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

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `LIGHTPANDA_BIN` | Path to Lightpanda binary | `~/.pi/agent/bin/lightpanda` |
| `WEBSEARCH_URL_TEMPLATE` | Fallback search URL (when SearXNG is unavailable) | Bing HTML |
| `WEBSEARCH_BACKEND` | Search backend: `auto`, `searxng`, or `bing` | `auto` |
| `WEBSEARCH_SEARXNG_URL` | SearXNG instance URL | `http://localhost:8888` |
| `BROWSER_FALLBACK_BIN` | Browser path for Playwright fallback | Auto-detected |

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
```
1. web-search "Touhou Project"
2. Results too broad → web-search "Touhou Project site:en.wikipedia.org"
3. Need specific info → open-url "https://en.wikipedia.org/wiki/Mountain_of_Faith"
```

### Handling Protected Sites (Cloudflare, etc.)
- Lightpanda may fail on protected sites
- Playwright is more reliable but still detectable
- Truly locked-down sites (Turnstile) may need Stagehand (not yet implemented)
- Wikipedia works well with all backends
- SearXNG handles search queries without ever hitting protected search pages

### Understanding Cache
- Results are cached automatically for 5 minutes (search) or 1 hour (pages)
- Repeated queries to the same URL return instantly from cache
- Cache location: `~/.pi/agent/cache/web-search/`
- Clear by deleting the directory to force fresh fetches

### SearXNG Setup (Docker)
```bash
docker run -d -p 8888:8080 --name searxng searxng/searxng
```
Point `WEBSEARCH_SEARXNG_URL=http://localhost:8888` and the extension will auto-detect it.

## Troubleshooting

### "Lightpanda is not available"
1. Run `install-lightpanda`
2. Or set `LIGHTPANDA_BIN` manually
3. Verify: `/path/to/lightpanda version`

### "Playwright is not available"
1. Run `install-playwright`
2. Check: `cd ~/.pi-extensions/web-search && npm list playwright`

### All fallbacks failed
- Site may have strong anti-bot protection
- Try waiting before retrying
- Consider setting up SearXNG for search queries
- For particularly locked-down sites, manual browsing may be needed

## Notes

- Tools return rendered pages as markdown, not curated answers
- SearXNG returns structured `{title, snippet, url}` results from 70+ engines
- Use as a research step, then synthesize the result
- No robots.txt compliance (designed for single targeted requests)
- Lightpanda is fast but may not handle JavaScript-heavy pages
- Playwright handles JavaScript but is slower
- For bulk scraping, use dedicated tools (this extension is for targeted research)
