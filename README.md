# 🌐 Web Search Pi Extension

A lightweight pi extension that provides browser-backed web search and page browsing, with **SearXNG** as the preferred search backend, **Lightpanda** as the primary renderer, and **Playwright** as the final browser fallback.

![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)
![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Pi Extension](https://img.shields.io/badge/pi--extension-orange?style=flat-square)

## ✨ Features

- 🔍 **Web Search** — SearXNG first (70+ engines), fallback to Lightpanda/Bing, then Playwright
- 🌐 **Open URL** — Directly open and render specific web pages via Lightpanda → Playwright
- 🔄 **Automatic Fallbacks** — SearXNG → Lightpanda → Playwright/Chromium
- 📄 **Markdown Output** — Clean markdown from rendered pages (SearXNG returns structured results)
- ⚡ **Result Caching** — 5 min TTL for search, 1 hour for pages; repeated queries are instant
- 🪶 **Trimmed Code** — No raw CDP WebSocket layer (~200 lines removed), 3 env vars consolidated

## 📦 Tools

| Tool | Description |
|---|---|
| `web-search` | Search the web — SearXNG first, then Lightpanda, then Playwright |
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
| `LIGHTPANDA_BIN` | Path to Lightpanda binary | `~/.pi/agent/bin/lightpanda` |
| `WEBSEARCH_URL_TEMPLATE` | Fallback search URL template | Bing HTML |
| `WEBSEARCH_BACKEND` | Search backend: `auto`, `searxng`, or `bing` | `auto` |
| `WEBSEARCH_SEARXNG_URL` | SearXNG instance URL | `http://localhost:8888` |
| `BROWSER_FALLBACK_BIN` | Browser path for Playwright fallback | Auto-detected |

### Configure Browser Fallback

If automatic detection fails, manually configure a Chromium-based browser:

```bash
set-browser-fallback --browserPath /usr/bin/brave-browser-stable
```

## 🔧 Fallback Chain

```
web-search:   SearXNG → Lightpanda → Playwright → Error
open-url:     Lightpanda → Playwright → Error
```

1. **SearXNG** (search only) — Aggregates 70+ engines, parses structured results
2. **Lightpanda** — Fast, lightweight, no-JS renderer
3. **Playwright/Chromium** — Full browser automation for JS-heavy and protected sites

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
