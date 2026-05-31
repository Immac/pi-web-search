# Web-Search Extension — Crash Analysis & Fix Record

> Source file: `src/extensions/web-search/web-search.ts`
> Last updated: 2026-05-30

## Architecture Overview

The extension uses a **streamlined 2-tier fallback chain** (SearXNG for search, Lightpanda for rendering, Playwright as final browser fallback).

```
web-search:   SearXNG (auto-detect) → fetchWithFallback() → Lightpanda → Playwright
open-url:     fetchWithFallback() → Lightpanda → Playwright
```

The CDP browser fallback (hand-rolled raw WebSocket Chrome automation) was **removed** — it duplicated Playwright's functionality with more bug surface area.

---

## ✅ RESOLVED: Crash Cause #1 — `run()` had no timeout or AbortSignal

**Status: Fixed** (commit `00bb3b5`, later refined in the CDP removal rewrite)

The `run()` subprocess helper now accepts `RunOptions { signal?, timeoutMs? }`. When a signal fires or timeout expires, the child process receives `SIGTERM` → `SIGKILL` after 3s grace. The `execute()` handler in each tool registration passes `signal` through `fetchWithFallback()` → `fetchMarkdown()` → `run()`.

All `await run()` call sites are wired.

---

## ✅ RESOLVED: Crash Cause #2 — AbortSignal didn't kill subprocesses

**Status: Fixed**

The `signal` parameter from `execute()` is now forwarded to `run()` for Lightpanda calls, and the Playwright fallback registers an abort listener that closes the browser context.

Previously, abort signals were only polled at scattered checkpoints — they never actually terminated anything.

---

## ✅ REMOVED: Crash Cause #3 — CDP port collision

**Status: Removed along with CDP fallback**

The raw CDP browser fallback (`runBrowserCdpFallback`) was removed. This eliminates:
- Port collision (was hardcoded 9222, later randomized)
- Profile directory leak (was cleaned but less aggressively)
- WebSocket connection management
- Hand-rolled Chrome automation

Playwright handles all headless browser needs with proper profile management and port allocation.

---

## ✅ REMOVED: Crash Cause #4 — Profile directory leak (CDP)

**Status: Fixed (both Playwright and removed CDP)**

The CDP fallback's profile directory leak is moot (code removed). Playwright's `finally` block cleans up its profile dir with `rmSync(profileDir, { recursive: true, force: true })`.

---

## ✅ RESOLVED: Crash Cause #5 — `onclose` didn't drain event waiters

**Status: Removed along with CDP fallback**

The `createCdpSocket` WebSocket client was removed. No more event waiter drain issues.

---

## 🆕 ENHANCEMENT: SearXNG search backend

SearXNG is now the preferred search backend. Auto-detected at `http://localhost:8888` when `WEBSEARCH_BACKEND=auto` (default). Returns structured `{title, snippet, url}` results via SearXNG's JSON API.

If SearXNG is unavailable, falls through to Lightpanda (Bing HTML search), then Playwright.

## 🆕 ENHANCEMENT: Result caching

Simple file-based cache at `~/.pi/agent/cache/web-search/<hash>.json`:
- Search results: 5-minute TTL
- Page content: 1-hour TTL
- Repeated queries return instantly from cache
- Silently falls through on cache read/write errors

## ✅ What's Handled Well

- `fetchWithFallback()` orchestrator: clean SearXNG → Lightpanda → Playwright → Error flow
- `run()` has proper abort/timeout cleanup
- Error catching in all fallback stages — each tier degrades gracefully
- `isMissingModuleError` catches Playwright module-not-found correctly
- SearXNG detection is non-blocking (probe on first search, not startup)
- Caching is transparent and doesn't break on errors

## 📋 Remaining Work (Next Steps)

| Priority | Work | Notes |
|---|---|---|
| P2 | **Stealth patches** | `navigator.webdriver=false`, canvas randomization, fake plugins in Playwright |
| P2 | **Search result parsing** | Extract `{title, snippet, url}` from Bing/Lightpanda HTML |
| P3 | **Stagehand tier** | AI-driven browser for Turnstile/hCaptcha |
| P3 | **Proxy support** | For residential IP / rate-limit evasion |
| P4 | **Unit tests** | vitest for cache, error handling, fallback chain |
