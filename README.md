# 🌐 Web Search Pi Extension

A lightweight pi extension that provides browser-backed web search and page browsing, with **SearXNG** as the preferred search backend, **Lightpanda** as the primary renderer, and **Playwright** as the final browser fallback.

![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)
![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Pi Extension](https://img.shields.io/badge/pi--extension-orange?style=flat-square)

## ✨ Features

- 🔍 **Web Search** — Exa → Parallel → keyed APIs (Brave/Google CSE/Tavily) → SearXNG → Lightpanda → Playwright; **Exa & Parallel need no API key**
- 🌐 **Open URL** — Directly open and render specific web pages via Lightpanda → Playwright
- 🔄 **Automatic Fallbacks** — SearXNG → Lightpanda → Playwright/Chromium
- 📄 **Markdown Output** — Clean markdown from rendered pages (SearXNG returns structured results)
- ⚡ **Result Caching** — 5 min TTL for search, 1 hour for pages; repeated queries are instant
- 🚫 **Negative Caching** — URLs that just failed all backends won't retry for 60 seconds
- 🔌 **Native Fetch** — All HTTP via native `fetch` (Node 18+), no curl subprocesses
- 📏 **Result Caps** — Configurable max results and snippet length limits
- 🪶 **Trimmed Code** — No raw CDP WebSocket layer (~200 lines removed), 3 env vars consolidated

## 📦 Tools

| Tool | Description |
|---|---|
| `web-search` | Search the web — Exa → Parallel → keyed APIs → SearXNG → renderers |
| `open-url` | Open a specific URL — Lightpanda, then Playwright |
| `install-lightpanda` | Download and install the Lightpanda browser binary |
| `install-playwright` | Install Playwright in the extension runtime |
| `set-browser-fallback` | Configure a Chromium-based browser path for Playwright fallback |

## 🚀 Quick Start

### Installation

```bash
pi install /path/to/web-search
```

### Search Backend Options

The extension auto-detects SearXNG at `http://localhost:8888`. For best results, run SearXNG in Docker:

```bash
docker run -d -p 8888:8080 --name searxng searxng/searxng
```

Or use environment variables to configure:

```bash
export WEBSEARCH_BACKEND=searxng
export WEBSEARCH_SEARXNG_URL=http://localhost:8888
```

### Backend Ordering

The order in which search backends are tried depends on `WEBSEARCH_BACKEND`:

| `WEBSEARCH_BACKEND` | Order |
|---|---|
| `auto` (default) | Exa → Parallel → Brave → Google CSE → Tavily → SearXNG → Lightpanda → Playwright |
| `searxng` | **SearXNG first** → API backends (Exa → …) → static → Lightpanda → Playwright |
| unset | Same as `auto` |

When set to `searxng`, the availability probe is skipped entirely — SearXNG is tried immediately, and on failure **or empty results** it falls through to the API backends, then the renderer chain.

### Result Limits

Control the number of results returned per search backend:

```bash
export WEBSEARCH_MAX_RESULTS=20  # default: 15, min: 1, max: 50
```

Each snippet/content field is capped at **300 characters**. Page-dump text (from Lightpanda/Playwright/static-fetch) is capped at **50,000 characters** with a truncated marker.

## 💡 Usage Examples

### Basic Web Search

```bash
web-search --query "Yasaka Kanako Touhou"
# → Results via SearXNG (parsed {title, snippet, url}) or Lightpanda/Bing
```

### Open Specific URL

```bash
open-url --url "https://en.wikipedia.org/wiki/Touhou_Project"
# → Lightpanda → Playwright if needed
```

### Handle Protected Sites

Some sites (like Cloudflare-protected wikis) may block automated access:

```bash
# The extension automatically tries:
# 1. SearXNG (for search queries, 70+ engines to route around blocks)
# 2. Lightpanda (fast, but may be blocked)
# 3. Playwright/Chromium (most reliable for protected sites)
```

## ⚙️ Configuration

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `WEBSEARCH_EXA_KEY` | Exa MCP key (optional — anonymous access works) | — |
| `WEBSEARCH_PARALLEL_KEY` | Parallel MCP key (optional — anonymous access works) | — |
| `WEBSEARCH_BRAVE_KEY` | Brave Search API key (2,000 free queries/mo) | — |
| `WEBSEARCH_GOOGLE_KEY` | Google CSE API key (100 free queries/day) | — |
| `WEBSEARCH_GOOGLE_CX` | Google CSE search engine ID | — |
| `WEBSEARCH_TAVILY_KEY` | Tavily API key (1,000 free queries/mo) | — |
| `LIGHTPANDA_BIN` | Path to Lightpanda binary | `~/.pi/agent/bin/lightpanda` |
| `WEBSEARCH_URL_TEMPLATE` | Fallback search URL template | Bing HTML |
| `WEBSEARCH_BACKEND` | Search backend: `auto`, `searxng`, or `bing` | `auto` |
| `WEBSEARCH_SEARXNG_URL` | SearXNG instance URL | `http://localhost:8888` |
| `WEBSEARCH_MAX_RESULTS` | Max results per search backend (1–50) | `15` |
| `BROWSER_FALLBACK_BIN` | Browser path for Playwright fallback | Auto-detected |

### Configure Browser Fallback

If automatic detection fails, manually configure a Chromium-based browser:

```bash
set-browser-fallback --browserPath /usr/bin/brave-browser-stable
```

## 🔧 Fallback Chain

```
web-search:   Exa → Parallel → Brave API → Google CSE → Tavily → SearXNG → static-fetch → Lightpanda → Playwright → Error
open-url:     static-fetch → Lightpanda → Playwright → Error
```

1. **Exa / Parallel** (search only, **no key needed**) — hosted MCP search endpoints (opencode-style); HTTP 429 cools a backend down per `Retry-After` and the chain moves on
2. **Brave / Google CSE / Tavily** — official APIs, tried when configured
3. **SearXNG** (search only) — Aggregates 70+ engines, parses structured results
4. **Static fetch** — Plain native HTTP GET with browser-like User-Agent
5. **Lightpanda** — Fast, lightweight, no-JS renderer
6. **Playwright/Chromium** — Full browser automation for JS-heavy and protected sites

## What Was Removed

- **Raw CDP WebSocket fallback** (~200 lines) — Duplicated Playwright's functionality; Playwright is maintained, has a clean API, and handles timeouts/profiles natively
- **Legacy env vars** — `BRAVE_BIN`, `BRAVE_BROWSER_BIN`, `CHROME_BIN`, `GOOGLE_CHROME_BIN`, `WEBSEARCH_CDP_PORT` all consolidated into `BROWSER_FALLBACK_BIN` + auto-detection

## 📂 Project Structure

```
web-search/
├── src/
│   ├── extensions/
│   │   └── web-search/
│   │       ├── index.ts          # Extension entrypoint
│   │       └── web-search.ts    # Main implementation
│   └── types/
│       ├── node-shims.d.ts
│       ├── pi-coding-agent.d.ts
│       └── playwright.d.ts
├── skills/
│   └── SKILL.md              # Pi skill file (on-demand loading)
├── ARCHITECTURE.md            # Detailed architecture docs
├── CRASH-ANALYSIS.md          # Post-mortem & fix record
├── package.json
├── tsconfig.json
└── README.md                  # This file
```

## 🛠️ Development

### Prerequisites

- Node.js 18+
- npm or pnpm
- TypeScript 5.0+

### Validate

```bash
cd /path/to/web-search
npm install
npx tsc --noEmit
```

### Test Locally

```bash
pi install .
web-search --query "test query"
open-url --url "https://example.com"
```

## 📄 License

MIT — see [LICENSE](LICENSE).
