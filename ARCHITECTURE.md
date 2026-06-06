# Web Search Extension Architecture

## Purpose

Provides a small pi extension for browser-backed web search and page browsing with **SearXNG** as the preferred search backend, **Lightpanda** as the primary renderer, and **Playwright** as the final browser fallback.

The goal is a focused, low-surface-area research toolchain that can:

- search the web from the agent (preferring SearXNG when available)
- open known URLs directly when search is not enough
- return rendered page content as markdown (or parsed results from SearXNG)
- cache results to avoid repeated fetches
- stay predictable, easy to validate, and teach the agent when to use it

## Removal Rationale

### CDP Fallback removed (~200 lines)

The raw CDP browser fallback (hand-rolled WebSocket/Chrome DevTools Protocol client) was removed because it duplicated what Playwright already does — headless Chromium automation — with more surface area for bugs. Playwright is maintained, handles timeouts properly, manages profiles, and has a clean API. The extra tier wasn't earning its keep.

### Legacy env vars removed

The `BRAVE_BIN`, `BRAVE_BROWSER_BIN`, `CHROME_BIN`, `GOOGLE_CHROME_BIN`, and `WEBSEARCH_CDP_PORT` environment variables were consolidated into:
- `BROWSER_FALLBACK_BIN` (single browser path)
- `WEBSEARCH_BACKEND` (search backend selection)
- `WEBSEARCH_SEARXNG_URL` (SearXNG instance URL)

#### New API backend env vars added

- `WEBSEARCH_BRAVE_KEY` — Brave Search API (2,000 free queries/month)
- `WEBSEARCH_GOOGLE_KEY` + `WEBSEARCH_GOOGLE_CX` — Google CSE (100 free queries/day)
- `WEBSEARCH_TAVILY_KEY` — Tavily (1,000 free queries/month)

## Package Shape

- **Package name:** `web-search`
- **Extension entrypoint:** `src/extensions/web-search/index.ts`
- **Implementation:** `src/extensions/web-search/web-search.ts`
- **Matching skill:** `skills/SKILL.md`
- **Supporting tool:** `install-lightpanda`
- **Supporting tool:** `install-playwright`
- **Configuration tool:** `set-browser-fallback`
- **Tools:** `web-search`, `open-url`
- **Final browser fallback:** Playwright (with Chromium or configured browser)

## Core Behavior

The extension registers **five** custom tools:

- `web-search` — Search the web: tries Brave API → Google CSE → Tavily → SearXNG → Lightpanda → Playwright
- `open-url` — Open a specific URL: tries Lightpanda, then Playwright
- `install-lightpanda` — Download and install Lightpanda binary
- `install-playwright` — Install Playwright in the extension runtime
- `set-browser-fallback` — Configure path to Chromium-based browser for Playwright

### Fallback Chain

```
web-search:   Brave API → Google CSE → Tavily → SearXNG → Lightpanda → Playwright → Error
open-url:     Lightpanda → Playwright → Error
```

**Brave Search API** (2,000 free queries/month), **Google CSE** (100 free queries/day), and **Tavily** (1,000 free queries/month) are tried first — clean JSON, no blocking, purpose-built for LLM/programmatic access. Each is skipped if its env var is unset.

**SearXNG** aggregates across 70+ engines — if one blocks, others still work. Auto-detects at `http://localhost:8888`, or configured via `WEBSEARCH_BACKEND=searxng` + `WEBSEARCH_SEARXNG_URL`.

**Lightpanda** is the primary page renderer: fast, lightweight, no JS.

**Playwright** is the final browser fallback for JavaScript-heavy or bot-protected sites.

### When Fallbacks Fail

- If all API backends are unconfigured, silently fall through to SearXNG
- If SearXNG is unreachable, silently fall through to Lightpanda
- If Lightpanda is unavailable, return guidance to call `install-lightpanda`
- If Playwright is missing, return guidance to call `install-playwright`
- If all fallbacks fail, return a terminal error

## Backend Strategy

### Search resolution (`web-search`)

1. Try official search APIs in order if configured (Brave → Google CSE → Tavily)
2. Check SearXNG availability (if `auto` or `searxng` backend)
3. If available, send query via SearXNG JSON API → parse structured results
4. On failure, fall through to Lightpanda → Playwright

### Page resolution (`open-url`)

1. Lightpanda binary (set `LIGHTPANDA_BIN` or default path)
2. Playwright with system browser or Chromium

### Why this approach

- Official APIs are the most reliable path: clean JSON, no anti-bot measures, generous free tiers
- SearXNG provides engine diversity as a fallback when no API keys are configured
- Lightpanda handles simple pages fast
- Playwright handles complex pages when needed
- Caching avoids repeated fetches to the same URL
- Removes the redundant CDP WebSocket tier (~200 lines)

## Caching

Simple file-based cache at `~/.pi/agent/cache/web-search/<hash>.json`:
- Search results: 5-minute TTL
- Page content: 1-hour TTL
- Cache key is a hash of the URL
- Silently falls through on cache read/write errors

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `WEBSEARCH_BRAVE_KEY` | Brave Search API key (2,000 free queries/mo) | — |
| `WEBSEARCH_GOOGLE_KEY` | Google CSE API key (100 free queries/day) | — |
| `WEBSEARCH_GOOGLE_CX` | Google CSE search engine ID | — |
| `WEBSEARCH_TAVILY_KEY` | Tavily API key (1,000 free queries/mo) | — |
| `LIGHTPANDA_BIN` | Path to Lightpanda binary | `~/.pi/agent/bin/lightpanda` |
| `WEBSEARCH_URL_TEMPLATE` | Fallback search URL template | Bing HTML search |
| `WEBSEARCH_BACKEND` | Search backend: `auto`, `searxng`, or `bing` | `auto` |
| `WEBSEARCH_SEARXNG_URL` | SearXNG instance URL | `http://localhost:8888` |
| `BROWSER_FALLBACK_BIN` | Browser path for Playwright fallback | Auto-detected |

## Skill Relationship

The matching skill teaches the agent when to use the tools and how to interpret the output:

- precise query formulation
- result refinement with `site:` or quoted terms
- opening a known URL when search is not enough
- checking linked sources before making claims

## Next Steps

1. **Stealth patches** — Add `navigator.webdriver=false`, canvas fingerprint randomization, fake plugins to Playwright fallback
2. **Search result parsing** — Extract `{title, snippet, url}` from Bing/Lightpanda HTML (currently only SearXNG returns parsed results)
3. **Stagehand tier** — AI-driven browser for Turnstile/hCaptcha challenges
4. **Proxy support** — For high-volume or residential-IP-needed use
5. **Tests** — Add `__tests__/` with vitest for fallback chain, error handling, caching
