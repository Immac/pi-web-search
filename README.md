# 🌐 Web Search Pi Extension#

A lightweight pi extension that provides browser-backed web search and page browsing through **Lightpanda**, with automatic fallbacks to **Playwright/Chromium** and **CDP browser sessions**.

![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)
![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Pi Extension](https://img.shields.io/badge/pi--extension-orange?style=flat-square)

## ✨ Features#

- 🔍 **Web Search** - Search the web using DuckDuckGo with Lightpanda rendering
- 🌐 **Open URL** - Directly open and render specific web pages
- 🔄 **Automatic Fallbacks** - Lightpanda → CDP Browser → Playwright/Chromium
- 📄 **Markdown Output** - Returns clean markdown from rendered pages
- 🛠️ **Self-Contained** - All 5 tools in one extension
- 🚀 **No Robots.txt** - Designed for single targeted requests, not bulk scraping#

## 📦 Tools#

| Tool | Description |
|---|---|
| `web-search` | Search the web and return rendered results as markdown |
| `open-url` | Open a specific URL and return page content as markdown |
| `install-lightpanda` | Download and install the Lightpanda browser binary |
| `install-playwright` | Install Playwright and Chromium browser in the extension runtime |
| `set-browser-fallback` | Configure a Chromium-based browser path for CDP fallback |

## 🚀 Quick Start#

### Installation#

```bash
# Install the extension (from this repository)
pi install /path/to/web-search

# Or install from GitHub (once published)
pi install github:Immac/pi-web-search
```

### First Use#

```bash
# The extension will guide you through setup:
# 1. Lightpanda is installed automatically on first use
# 2. Optionally configure a browser fallback for protected sites
```

## 💡 Usage Examples#

### Basic Web Search#

```bash
# Search for information
web-search --query "Yasaka Kanako Touhou"

# Results are returned as markdown from the rendered search page
```

### Open Specific URL#

```bash
# Open a known page directly
open-url --url "https://en.wikipedia.org/wiki/Touhou_Project"

# Works great for documentation, wikis, and specific resources
```

### Handle Protected Sites#

Some sites (like Cloudflare-protected wikis) may block automated access:

```bash
# The extension automatically tries:
# 1. Lightpanda (fast, but may be blocked)
# 2. CDP Browser (if configured)
# 3. Playwright/Chromium (most reliable for protected sites)
```

## ⚙️ Configuration#

### Environment Variables#

| Variable | Purpose | Default |
|---|---|---|
| `LIGHTPANDA_BIN` | Path to Lightpanda binary | `~/.pi/agent/bin/lightpanda` |
| `WEBSEARCH_URL_TEMPLATE` | Search URL template | DuckDuckGo HTML |
| `WEBSEARCH_CDP_PORT` | CDP browser port | `9222` |
| `BROWSER_FALLBACK_BIN` | Browser path for CDP/Playwright | Auto-detected |

### Configure Browser Fallback#

If automatic detection fails, manually configure a Chromium-based browser:

```bash
set-browser-fallback --browserPath /usr/bin/brave-browser-stable
```

## 🔧 Fallback Chain#

The extension uses a three-tier fallback system for maximum reliability:

```
1. Lightpanda (Primary)
   └─ Fast, lightweight, no-js support

2. CDP Browser (Secondary)
   └─ Uses configured browser via Chrome DevTools Protocol#

3. Playwright/Chromium (Final)
   └─ Full browser automation, handles JS-heavy and protected sites
```

## 📂 Project Structure#

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
├── package.json
├── tsconfig.json
└── README.md                  # This file
```

## 🛠️ Development#

### Prerequisites#

- Node.js 18+
- npm or pnpm
- TypeScript 5.0+

### Build#

```bash
cd /home/immac/Repositories/ai_generation/tools/pi-extensions/web-search
npm install
npx tsc
```

### Test Locally#

```bash
# Install the local development version
pi install .

# Test tools
web-search --query "test query"
open-url --url "https://example.com"
```

## 📄 License#

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
