# Web-Search Extension — Crash Analysis & Fix Plan

> Source file: `src/extensions/web-search/web-search.ts`
> Analyzed: 2026-05-30

## Architecture Overview

The extension uses a **3-tier fallback chain**:

```
web-search/open-url execute()
  → fetchWithFallback()
    → Lightpanda (run() → fetchMarkdown)
    → CDP Browser Fallback (runBrowserCdpFallback)
    → Playwright Fallback (runPlaywrightFallback)
    → Error result
```

The `run()` function at the heart of the extension is a wrapper around `child_process.spawn()` that resolves/rejects on process close. It has 12 call sites.

---

## 🔴 Crash Cause #1: `run()` has no timeout and no AbortSignal (INESCAPABLE HANG)

**`run()` function (~line 142):**

```typescript
function run(command, args): Promise<{stdout, stderr}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ... });
    child.on("close", (code) => {
      if (code === 0) resolve(...);
      else reject(...);
    });
  });
  // No timeout. No abort listener. No child.kill() on cancel.
}
```

**Problem:** When Lightpanda hangs (complex JS page, deadlock, segfault without clean exit):
1. The promise never resolves or rejects
2. ESC/Ctrl+C sets `signal.aborted = true`, but execution is stuck inside `await run(...)` — the scattered `signal?.aborted` checks **never execute** because we never return to the event loop
3. The tool call is deadlocked forever — **un-escape-able**
4. The Lightpanda process orphans into the background

**Pi has `pi.exec()` that solves this** — it accepts `{ signal, timeout }` and properly kills the child process on abort or timeout. The extension built its own `run()` from scratch instead.

**All `await run()` call sites (12 total):**

| Call site | Location | Purpose |
|-----------|----------|---------|
| `fetchMarkdown()` | ~378 | Lightpanda fetch (primary render path) |
| `httpGetJson()` | ~398 | cURL for CDP version endpoint |
| `isLightpandaAvailable()` | ~322 | Binary check |
| `isBrowserFallbackAvailable()` | ~332 | Binary check |
| `resolveBrowserFallbackBinaries()` | ~369 | `which` command |
| `installLightpanda()` | ~710-713 | mkdir, curl download, chmod, version check |
| `setBrowserFallbackPath()` | ~776-777 | mkdir, bash write |
| `runBrowserCdpFallback()` | ~810 | mkdir for CDP profile dir |
| `runPlaywrightFallback()` | ~990 | mkdir for Playwright profile dir |

---

## 🔴 Crash Cause #2: AbortSignal doesn't kill subprocesses

The `signal` parameter from `execute()` is **passed around but only polled** — never used to actually terminate anything:

| Call site | Passes signal? | Kills process on abort? |
|-----------|---------------|-------------------------|
| `execute()` → `fetchWithFallback()` | ✅ Passed | ❌ Only `signal?.aborted` checks |
| `fetchMarkdown()` → `run()` | ❌ Not passed | ❌ No signal param in `run()` |
| `runBrowserCdpFallback()` | ✅ Passed | ❌ Only checks at entry |
| `runPlaywrightFallback()` | ✅ Passed | ❌ Only checks at entry |

Result: multiple aborted web-search calls orphan Lightpanda processes → memory/port exhaustion → actual crash.

---

## 🔴 Crash Cause #3: CDP port collision

`runBrowserCdpFallback()` always binds to port **9222** (`BROWSER_FALLBACK_PORT`). No randomization. On concurrent calls:

1. First call spawns browser on 9222
2. Second call fails to bind → 5-second wasted poll loop
3. First call's `finally` block sends `SIGTERM`, which may not kill headless Chrome cleanly
4. Both browsers potentially orphaned

Only 1 place to fix: the `port` variable at ~807.

---

## ⚠️ Crash Cause #4: Profile directory leak

Each CDP and Playwright fallback creates a temp profile dir:
- `~/.pi/agent/tmp/browser-cdp-{ts}-{random}`
- `~/.pi/agent/tmp/browser-playwright-{ts}-{random}`

The `finally` block only kills the process — **never `rm -rf`s the directory**. Accumulates indefinitely.

---

## ⚠️ Crash Cause #5: `onclose` doesn't drain event waiters

In `createCdpSocket()` (~line 430):

```typescript
socket.onclose = () => {
  for (const record of pending.values()) {
    record.reject(new Error(`CDP websocket closed: ...`));
  }
  pending.clear();
  // ↑ Does NOT drain eventWaiters or sessionEventWaiters!
};
```

Event waiters (e.g., `waitForSessionEvent("Page.loadEventFired", 20000)`) are left dangling — they won't resolve until their 20-second timeout. The timeout's `reject` and the waiter's `resolve` race on the same promise.

---

## ✅ What's Handled Well

- Error catching in `fetchWithFallback` — both the `try` and catch-block paths try CDP → Playwright → error result
- `runBrowserCdpFallback` wraps everything in try/catch/finally
- `isMissingModuleError` catches Playwright module-not-found correctly
- Fallback chain logic (Lightpanda → CDP → Playwright → error) is sound
- Most error paths return a `ToolOutput` instead of throwing

---

## 📋 Fix Plan (Priority Order)

### P1 — Make hangs escape-able (replace `run()` with abort-aware helper)

Replace all `await run(...)` with a new helper or `pi.exec()` that:

1. Accepts `AbortSignal` — calls `child.kill('SIGTERM')` when abort fires, then `SIGKILL` after a grace period
2. Accepts a timeout — same kill behavior if process exceeds limit
3. Properly cleans up signal listeners (removeEventListener after resolution)
4. Returns the same `{ stdout, stderr }` shape

**Option A** (simplest): Use `pi.exec(command, args, { signal, timeout })` — pi's built-in API already handles both.
**Option B** (more control): Add `signal` and `timeout` parameters to `run()`.

Either way, wire the `signal` from `execute()` → `fetchWithFallback()` → `fetchMarkdown()` → `run()`.

**Files to change:** `web-search.ts`
- `run()` function signature and implementation
- `execute()` handler passes `signal` to `fetchWithFallback()`
- All 12 call sites (add signal param where appropriate, timeout for user-facing calls)

### P1 — Add AbortSignal termination to `spawnDetached`

In `runBrowserCdpFallback`, add `signal.addEventListener('abort', () => browserProcess.child.kill('SIGKILL'))` so cancellation actually terminates the CDP browser.

### P2 — Add AbortSignal to Playwright

In `runPlaywrightFallback`, wire `signal` into `page.goto()` timeout and context cleanup.

### P2 — Randomize CDP port

Generate a random available high port instead of hardcoded 9222. Try a random port in range 49152-65535.

**Where:** ~line 807, the `port = BROWSER_FALLBACK_PORT` constant.

### P3 — Clean up profile directories

In `runBrowserCdpFallback`'s `finally` block and `runPlaywrightFallback`'s cleanup, add:
```typescript
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
```

### P3 — Drain event waiters on socket close

In `createCdpSocket`'s `onclose`, iterate all `eventWaiters` and `sessionEventWaiters` and reject every pending waiter:
```typescript
for (const [method, waiters] of eventWaiters) {
  for (const waiter of waiters) waiter(undefined);
}
eventWaiters.clear();
// same for sessionEventWaiters
```

### P4 — Add tests

Create `__tests__/` with vitest:
- `run()` with abort signal → child kills
- `run()` with timeout → child kills, rejection
- `isBlockedOrChallenge()` edge cases
- `createCdpSocket()` event dispatching
- `getSearchUrl()` / `normalizeUrl()` input handling

---

## Code Index

| Symbol | Line (approx) | Purpose |
|--------|---------------|---------|
| `run()` | 142 | Core subprocess runner — no timeout, no abort |
| `fetchMarkdown()` | 378 | Calls `run()` with Lightpanda fetch args |
| `httpGetJson()` | 398 | Calls `run()` with curl |
| `createCdpSocket()` | 405 | WebSocket CDP client — event/timeout race |
| `dispatchEvent()` | 440 | Event dispatching for CDP messages |
| `waitForEvent()` | 505 | Event waiter with timeout — race with resolve |
| `waitForSessionEvent()` | 515 | Session-scoped event waiter — same race |
| `runBrowserCdpFallback()` | 801 | CDP browser — port 9222 hardcoded |
| `runPlaywrightFallback()` | 967 | Playwright — profile dir leak |
| `fetchWithFallback()` | 1091 | Main orchestration — scattered signal checks |
| `spawnDetached()` | 185 | Detached process spawn — no abort support |
