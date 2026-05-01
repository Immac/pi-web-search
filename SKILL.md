---
name: web-search
description: Browser-backed web search using the web-search tool and Lightpanda. Use when you need current facts, source-backed results, or a quick search/refinement loop.
---

# Web Search Extension Skill

## Overview

This extension provides 5 tools for browser-backed web research:

1. **`web-search`** - Search the web via Lightpanda
2. **`open-url`** - Open specific URLs directly
3. **`install-lightpanda`** - Install Lightpanda backend
4. **`install-playwright`** - Install Playwright/Chromium fallback
5. **`set-browser-fallback`** - Configure browser path for CDP fallback

## Quick Start

### Basic Search
```bash
web-search --query "Yasaka Kanako"
```

### Direct URL Access
```bash
open-url --url "https://en.wikipedia.org/wiki/Touhou_Project"
```

### Fallback Chain
Tools automatically try: **Lightpanda → CDP Browser → Playwright/Chromium**

## Detailed Tool Usage

### 1. web-search
**When to use:**
- Current or rapidly changing facts
- Documentation lookup
- Source-backed verification
- Refining a query after noisy results

**Workflow:**
1. Start with a precise query
2. Call `web-search` with the query
3. Read the returned markdown results page
4. If noisy, narrow with quoted phrases or `site:` filters
5. Prefer checking linked sources before answering with high confidence

**Example queries:**
- `"Touhou Project" release dates`
- `Yasaka Kanako site:en.touhouwiki.net`
- `Playwright vs Selenium comparison 2024`

### 2. open-url
**When to use:**
- You already know the page URL
- Search results point to a specific page
- Need to inspect page content directly

**Note:** If Lightpanda cannot render the page, automatically tries browser fallbacks.

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
- Final fallback reports Playwright is missing
- Need Chromium browser for difficult pages

**What it does:**
- Installs Playwright in the extension's package runtime
- Downloads Chromium browser
- Used as the final fallback when Lightpanda and CDP fail

### 5. set-browser-fallback
**When to use:**
- Automatic browser detection fails
- You want to use a specific Chromium-based browser (Brave, Chrome, etc.)

**Example:**
```bash
set-browser-fallback --browserPath /usr/bin/brave-browser-stable
```

## Backend Configuration

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `LIGHTPANDA_BIN` | Path to Lightpanda binary | `~/.pi/agent/bin/lightpanda` |
| `WEBSEARCH_URL_TEMPLATE` | Search URL template | DuckDuckGo HTML |
| `WEBSEARCH_CDP_PORT` | CDP browser port | `9222` |
| `BROWSER_FALLBACK_BIN` | Browser for CDP/Playwright | Auto-detected |

### Search URL Template

Default: `https://html.duckduckgo.com/html/?q={query}`

Custom: `export WEBSEARCH_URL_TEMPLATE="https://google.com/search?q={query}"`

## Advanced Patterns

### Query Refinement Loop
```
1. web-search "Touhou Project"
2. Results too broad → web-search "Touhou Project site:en.wikipedia.org"
3. Need specific info → open-url "https://en.wikipedia.org/wiki/Mountain_of_Faith"
```

### Handling Protected Sites (Cloudflare, etc.)
- Lightpanda may fail on protected sites
- CDP fallback may fail if browser doesn't support headless
- Playwright with Chromium is most reliable for protected sites
- Wikipedia works well with all backends
- Some wikis (Touhou Wiki) may block automated access

### Troubleshooting

**"Lightpanda is not available":**
1. Run `install-lightpanda`
2. Or set `LIGHTPANDA_BIN` manually
3. Verify: `/path/to/lightpanda version`

**"Playwright is not available":**
1. Run `install-playwright`
2. Check: `cd ~/.pi-extensions/web-search && npm list playwright`

**"CDP fallback failed":**
1. Configure browser: `set-browser-fallback --browserPath /path/to/browser`
2. Verify browser supports CDP: `/path/to/browser --headless --remote-debugging-port=9222`

**All fallbacks failed:**
- Site may have strong anti-bot protection
- Try different User-Agent or wait before retrying
- Check if site allows automated access

## Notes

- Tools return browser-rendered pages as markdown, not curated answers
- Use as a research step, then synthesize the result
- No robots.txt compliance (designed for single targeted requests)
- Lightpanda is fast but may not handle JavaScript-heavy pages
- Playwright/Chromium handles JavaScript but is slower
- For bulk scraping, use dedicated tools (this extension is for targeted research)
