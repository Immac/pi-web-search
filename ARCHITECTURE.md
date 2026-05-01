# Web Search Extension Architecture

## Purpose

This project provides a small pi extension that lets the agent perform browser-backed web search and page browsing through **Lightpanda**, with fallback browser/content-extraction ideas borrowed from **pi-web-browse** and a tightly scoped feature set inspired by **pi-web-access**.

The goal is not to build a general browser automation framework, an API-search product, or a scraper. The goal is a focused, low-surface-area research toolchain that can:

- search the web from the agent
- open known URLs directly when search is not enough
- return rendered or extracted page content as markdown
- stay predictable and easy to validate
- teach the agent when to use it through matching skill(s)

## Package Shape

- **Package name:** `web-search`
- **Extension entrypoint:** `src/extensions/web-search/index.ts`
- **Implementation:** `src/extensions/web-search/web-search.ts`
- **Matching skill:** `skills/web-search/SKILL.md`
- **Supporting tool:** `install-lightpanda`
- **Supporting tool:** `install-playwright`
- **Configuration tool:** `set-browser-fallback`
- **Tools:** `web-search`, `open-url`
- **Final browser fallback:** Playwright (with Chromium)
- **Reference inspiration:** pi-web-access for keeping the package shape small but extensible

The named entrypoint keeps the package discoverable and avoids legacy `index.ts`-only layouts at the implementation level.

## Core Behavior

The extension currently registers **five** custom tools:

- `web-search` - Search the web using Lightpanda
- `open-url` - Open a specific URL and return rendered content
- `install-lightpanda` - Download and install Lightpanda binary
- `install-playwright` - Install Playwright in the extension runtime (with Chromium browser)
- `set-browser-fallback` - Configure path to Chromium-based browser for CDP fallback

`web-search` accepts one input:

- `query: string`

It searches a configured search URL template, renders the page with Lightpanda, and returns the resulting markdown to the agent.

`open-url` accepts one input:

- `url: string`

It opens a specific URL and returns the rendered page content as markdown.

`install-lightpanda` installs the Lightpanda binary for the current platform into the managed user bin directory (`~/.pi/agent/bin/lightpanda`).

`install-playwright` installs Playwright in the extension's package runtime and downloads the Chromium browser (not Brave) for use as the final fallback.

`set-browser-fallback` saves a user-provided path to a Chromium-based browser binary (e.g., `/usr/bin/brave-browser-stable`) for use in the CDP fallback.

### Fallback Chain

Current fallback policy (in order):

1. **Lightpanda** - Primary renderer
2. **CDP Browser Fallback** - Uses configured browser via Chrome DevTools Protocol (e.g., Brave, Chrome, Chromium)
3. **Playwright Fallback** - Uses Playwright with system browser or its own Chromium

The extension automatically tries each fallback in sequence without exposing extra user steps, keeping the LLM-facing interface simple.

**Important:** Brave browser CDP may not work on all systems. If `BRAVE_BIN` or `BRAVE_BROWSER_BIN` is set but CDP fails, the extension falls through to Playwright.

### When Fallbacks Fail

- If Lightpanda is unavailable, return guidance to call `install-lightpanda`
- If CDP browser is unavailable or fails, automatically try Playwright
- If Playwright is unavailable, return guidance to call `install-playwright`
- If all fallbacks fail, return a detailed error with suggestions

## Backend Strategy

The toolchain uses the local Lightpanda binary for the first pass.

### Backend resolution

1. Read `LIGHTPANDA_BIN` if present
2. Otherwise fall back to `lightpanda` in PATH
3. Probe availability before executing search or browse actions
4. If unavailable, return guidance instead of failing silently

### Why this approach

- keeps the search/browse toolchain simple and explicit
- moves browser installation into separate, callable tools
- works well for local development and reproducible environments
- provides a clean fallback path for pages that are accessible directly but not searchable
- makes backend failures easy to explain to the user
- allows future browser backends to be introduced only when needed
- **designed for single page calls, not scraping**: robots.txt compliance removed since this tool makes targeted requests, not bulk scraping
- **Playwright with Chromium**: Primary fallback implementation (not Brave) for reliability
- **CDP fallback**: Optional intermediate step using user-configured Chromium-based browsers

## Missing Backend Handling

When Lightpanda is missing, the extension does two things:

1. Shows a warning to the user in the UI when available
2. Returns actionable setup guidance to the tool caller

The guidance points users toward:

- calling `install-lightpanda`
- setting `LIGHTPANDA_BIN` to the binary path after installation
- using `set-browser-fallback` when a browser path must be supplied manually
- reviewing the upstream Lightpanda project for current install instructions
- using `open-url` for direct page access
- escalating to browser backends only when Lightpanda cannot handle the page
- keeping the LLM on a single tool call path (`web-search` / `open-url`) while the extension handles all fallback escalation internally

### Why installation is a separate tool

- installation must be explicit and user-visible
- the agent can choose between guided manual setup and automated setup
- the user should only be asked for a browser path when auto-detection fails
- browser binaries are external dependencies and should be isolated from search behavior
- the tool boundary keeps failure handling simple and testable
- fallback retries should be automatic and invisible to the LLM until a terminal failure occurs
- when the final fallback dependency is missing, surface a clear warning instead of crashing

## Skill Relationship

The matching skill teaches the model when to use the tool and how to interpret the output.

It exists to reinforce:

- precise query formulation
- result refinement with `site:` or quoted terms
- opening a known URL when search is not enough
- checking linked sources before making claims
- handling backend-missing cases by guiding the user

## Command Surface

The extension intentionally exposes only the minimum tool surface needed:

- `web-search` for research
- `open-url` for direct page browsing/extraction
- `install-lightpanda` for backend setup
- `install-playwright` for final-fallback runtime/browser setup
- `set-browser-fallback` for manually providing the browser binary path

This keeps the user-facing API small while still giving the LLM an explicit path to recover when search results are blocked or insufficient.

## Validation Philosophy

This project is designed to remain:

- TypeScript-first
- code-validated
- small and explicit
- easy to review
- easy to keep installed without hidden dependencies

## Environment Variables

- `LIGHTPANDA_BIN` — path to the Lightpanda binary (overrides default `~/.pi/agent/bin/lightpanda`)
- `WEBSEARCH_URL_TEMPLATE` — optional search URL template, defaulting to DuckDuckGo HTML search
- `WEBSEARCH_CDP_PORT` — port for CDP browser fallback (default: 9222)
- `BROWSER_FALLBACK_BIN` — explicit path to browser for CDP/Playwright fallback
- `BRAVE_BIN` — path to Brave browser (legacy, use `BROWSER_FALLBACK_BIN` instead)
- `BRAVE_BROWSER_BIN` — path to Brave browser (legacy, use `BROWSER_FALLBACK_BIN` instead)
- `CHROME_BIN` — path to Chrome browser
- `GOOGLE_CHROME_BIN` — path to Google Chrome browser

## Discrepancies Between Documentation and Code

| **Aspect** | **ARCHITECTURE.md (Old)** | **Actual Code** | **Status** |
|---|---|---|---|
| **Number of tools** | "four custom tools" | 5 tools (`web-search`, `open-url`, `install-lightpanda`, `install-playwright`, `set-browser-fallback`) | ✅ Fixed in this update |
| **open-url status** | "Planned fallback browse tool: `open-url`" | Fully implemented and working | ✅ Fixed in this update |
| **Brave CDP** | "Future generic fallback: Brave via CDP only if..." | Already in `BROWSER_FALLBACK_CANDIDATES` array | ✅ Fixed in this update |
| **Primary fallback** | "uses Brave browser (Chromium-based) as the primary fallback" | Playwright with Chromium (Brave CDP may fail on some systems) | ✅ Fixed in this update |
| **Fallback order** | "Lightpanda → browser fallback → Playwright" | Lightpanda → CDP (with system browser) → Playwright (with system browser or its own Chromium) | ✅ Fixed in this update |
| **robots.txt** | "robots.txt compliance removed" | Completely removed: no `--obey-robots` flag, no `"robotsblocked"` check | ✅ Fixed in this update |
| **Environment variables** | Lists only `LIGHTPANDA_BIN`, `WEBSEARCH_URL_TEMPLATE` | Also uses `WEBSEARCH_CDP_PORT`, `BROWSER_FALLBACK_BIN`, `BRAVE_BIN`, etc. | ✅ Fixed in this update |
| **Install Playwright behavior** | "download the Chromium browser used by the final fallback" | Actually downloads Chromium via `npx playwright install chromium` | ✅ Fixed in this update |
| **CDP browser path** | Not clearly documented | Configured via `set-browser-fallback` tool, stored in `~/.pi/agent/web-search-browser-path.txt` | ✅ Fixed in this update |

## Next Steps

1. **Test `open-url` tool** with various sites (Wikipedia works, Touhou Wiki has Cloudflare protection)
2. **Test fallback chain** - verify Lightpanda → CDP → Playwright works correctly
3. **Handle protected sites** - Cloudflare/DDOS protection may block Lightpanda and some fallbacks
4. **Add result caching** - avoid repeated fetches to same URL
5. **Improve error messages** - already added browser path suggestions to error output
