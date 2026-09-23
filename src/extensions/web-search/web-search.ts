import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type SearchParams = { query: string };
type OpenUrlParams = { url: string };
type InstallParams = { force?: boolean };
type ConfigureBrowserParams = { browserPath?: string };

type ToolOutput = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type RunOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

// ── Constants ──────────────────────────────────────────────────────────
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const LIGHTPANDA_INSTALL_URL = "https://github.com/lightpanda-io/browser";
const LIGHTPANDA_BINARY_NAME = "lightpanda";
const LIGHTPANDA_INSTALL_PATH = join(homedir(), ".pi", "agent", "bin", LIGHTPANDA_BINARY_NAME);
const BROWSER_FALLBACK_CONFIG_PATH = join(homedir(), ".pi", "agent", "web-search-browser-path.txt");
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(MODULE_DIR, "../../..");
const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "web-search");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min for search, 1 hour for pages
const MAX_SNIPPET_CHARS = 300;
const PAGE_DUMP_MAX_CHARS = 50_000;
const PAGE_DUMP_TRUNCATED_MARKER = "\n\n... [truncated]";

// ── Helpers ────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(() => resolve(), ms); });
}

function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  return parsed.toString();
}

function getLightpandaBinary(): string {
  return process.env.LIGHTPANDA_BIN?.trim() || LIGHTPANDA_INSTALL_PATH;
}

function readBrowserFallbackPath(): string | undefined {
  const configured = process.env.BROWSER_FALLBACK_BIN?.trim();
  if (configured) return configured;
  try {
    if (existsSync(BROWSER_FALLBACK_CONFIG_PATH)) {
      return readFileSync(BROWSER_FALLBACK_CONFIG_PATH, "utf8").trim() || undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}

function detectAssetName(): string | null {
  if (process.platform === "linux" && process.arch === "x64") return "lightpanda-x86_64-linux";
  if (process.platform === "linux" && process.arch === "arm64") return "lightpanda-aarch64-linux";
  if (process.platform === "darwin" && process.arch === "arm64") return "lightpanda-aarch64-macos";
  if (process.platform === "darwin" && process.arch === "x64") return "lightpanda-x86_64-macos";
  return null;
}

function buildReleaseUrl(assetName: string): string {
  return `https://github.com/lightpanda-io/browser/releases/download/nightly/${assetName}`;
}

// Simple hash for cache keys (no crypto dependency needed)
// Uses DJB2 algorithm with unsigned 32-bit cast via >>> 0
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = (hash & hash) >>> 0; // Convert to unsigned 32-bit int
  }
  return hash.toString(16);
}

// ── Result caps ────────────────────────────────────────────────────────
function getMaxResults(): number {
  const raw = parseInt(process.env.WEBSEARCH_MAX_RESULTS || "", 10);
  if (Number.isFinite(raw)) return Math.min(50, Math.max(1, raw));
  return 15;
}

function truncateSnippet(text: string): string {
  if (text.length <= MAX_SNIPPET_CHARS) return text;
  return text.slice(0, MAX_SNIPPET_CHARS) + "…";
}

function truncatePageDump(text: string): string {
  if (text.length <= PAGE_DUMP_MAX_CHARS) return text;
  return text.slice(0, PAGE_DUMP_MAX_CHARS) + PAGE_DUMP_TRUNCATED_MARKER;
}

// ── Caching ────────────────────────────────────────────────────────────
function cacheRead(url: string): ToolOutput | undefined {
  const path = join(CACHE_DIR, `${simpleHash(url)}.json`);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const data = JSON.parse(readFileSync(path, "utf8")) as { url: string; result: ToolOutput; cachedAt: number; failure?: boolean };
    const ttl = data.failure
      ? 60_000
      : (data.url.startsWith("http") && data.url.includes("/search?") ? CACHE_TTL_MS : CACHE_TTL_MS * 12);
    if (Date.now() - data.cachedAt < ttl) {
      // Return the original ToolOutput for successes; for failures, return a
      // generic "all backends failed" result so the caller sees it immediately.
      if (data.failure) {
        return {
          content: [{ type: "text", text: `# web-search failed\n\nURL: ${url}\n\nAll backends failed. Retry in 60 seconds.` }],
          details: { url, rendered: false, backend: "negative-cache" },
        };
      }
      return data.result;
    }
    rmSync(path, { force: true });
  } catch { /* ignore */ }
  return undefined;
}

function cacheWrite(url: string, result: ToolOutput): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${simpleHash(url)}.json`), JSON.stringify({ url, result, cachedAt: Date.now() }), "utf8");
  } catch { /* ignore */ }
}

function cacheWriteFailure(url: string): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      join(CACHE_DIR, `${simpleHash(url)}.json`),
      JSON.stringify({ url, result: null, cachedAt: Date.now(), failure: true }),
      "utf8",
    );
  } catch { /* ignore */ }
}

// ── SearXNG availability cache ─────────────────────────────────────────
let _searxngCache: { available: boolean; probedAt: number } | undefined;
const SEARXNG_CACHE_TTL_MS = 60_000;

// ── Subprocess ─────────────────────────────────────────────────────────
function run(
  command: string,
  args: string[],
  cwd?: string,
  options?: RunOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: unknown) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk: unknown) => { stderr += String(chunk); });

    const cleanup: Array<() => void> = [];

    const kill = () => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, 3000);
    };

    if (options?.signal) {
      if (options.signal.aborted) { kill(); } else {
        options.signal.addEventListener("abort", kill);
        cleanup.push(() => options.signal!.removeEventListener("abort", kill));
      }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timeoutId = setTimeout(kill, options.timeoutMs);
    }

    child.on("error", (error: unknown) => {
      cleanup.forEach((fn) => fn());
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("close", (code: unknown) => {
      cleanup.forEach((fn) => fn());
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (killed) { reject(new Error("Process was terminated")); return; }
      if (code === 0) { resolve({ stdout, stderr }); return; }
      reject(new Error(stderr.trim() || `Command failed with exit code ${String(code)}`));
    });
  });
}

// ── Native fetch helper ────────────────────────────────────────────────
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signals = [controller.signal];
  if (init?.signal) signals.push(init.signal);
  try {
    return await fetch(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: AbortSignal.any(signals),
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Lightpanda ─────────────────────────────────────────────────────────
async function isLightpandaAvailable(binary: string): Promise<boolean> {
  try {
    await run(binary, ["version"]);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return !(msg.includes("ENOENT") || msg.toLowerCase().includes("not found"));
  }
}

async function fetchMarkdown(
  binary: string,
  url: string,
  options?: RunOptions,
): Promise<{ stdout: string; stderr: string }> {
  return run(binary, [
    "fetch", "--dump", "markdown", "--wait-ms", "1000", "--log-level", "error", url,
  ], undefined, options);
}

// ── SearXNG ────────────────────────────────────────────────────────────
async function isSearxngAvailable(searxngUrl: string): Promise<boolean> {
  if (_searxngCache && (Date.now() - _searxngCache.probedAt) < SEARXNG_CACHE_TTL_MS) {
    return _searxngCache.available;
  }
  try {
    const res = await fetchWithTimeout(`${searxngUrl}/search?q=test&format=json`, 5000);
    const available = res.ok;
    _searxngCache = { available, probedAt: Date.now() };
    return available;
  } catch {
    _searxngCache = { available: false, probedAt: Date.now() };
    return false;
  }
}

// Safe string coercion for JSON API responses
function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function safeStrArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is string => typeof x === "string");
}

async function searchSearxng(
  query: string,
  searxngUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetchWithTimeout(url, 10_000, { signal });

  if (!res.ok) throw new Error(`SearXNG returned ${String(res.status)}`);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: Record<string, unknown> = await res.json() as Record<string, unknown>;

  const maxResults = getMaxResults();

  const rawResults = data.results;
  const results: Array<Record<string, string>> = Array.isArray(rawResults)
    ? rawResults.map((item: unknown) => {
        const obj = (item && typeof item === "object") ? item as Record<string, unknown> : {};
        return {
          title: safeStr(obj.title),
          url: safeStr(obj.url),
          content: safeStr(obj.content),
          engine: safeStr(obj.engine),
        };
      }).slice(0, maxResults)
    : [];
  const answers = safeStrArray(data.answers);
  const suggestions = safeStrArray(data.suggestions);
  const unresponsive = safeStrArray(data.unresponsive_engines);
  const rawInfoboxes = data.infoboxes;
  const infoboxes: Array<{ infobox: string; content: string }> = Array.isArray(rawInfoboxes)
    ? rawInfoboxes.map((item: unknown) => {
        const obj = (item && typeof item === "object") ? item as Record<string, unknown> : {};
        return { infobox: safeStr(obj.infobox), content: safeStr(obj.content) };
      })
    : [];
  const numResults = typeof data.number_of_results === "number" ? data.number_of_results : undefined;

  const lines: string[] = [];
  if (infoboxes.length) {
    for (const box of infoboxes) {
      lines.push(`> **${box.infobox}** — ${truncateSnippet(box.content)}`);
    }
    lines.push("");
  }
  if (numResults !== undefined) { lines.push(`**${numResults} results**`); lines.push(""); }
  if (answers.length) { for (const a of answers) { lines.push(`> ${truncateSnippet(a)}`); } lines.push(""); }
  if (suggestions.length) { lines.push(`**Suggestions:** ${suggestions.join(", ")}`); lines.push(""); }

  for (const r of results) {
    const title = r.title || "Untitled";
    const href = r.url || "";
    const snippet = truncateSnippet(r.content || "");
    const engine = r.engine || "?";
    lines.push(`- [${title}](${href}) — ${snippet} *(via ${engine})*`);
  }

  if (unresponsive.length) {
    lines.push("");
    lines.push(`_Unresponsive engines: ${unresponsive.join(", ")}_`);
  }

  return lines.join("\n") || "No results found.";
}

// ── API key resolution: auth.json → env var ──────────────────────────
// Reads from ~/.pi/agent/auth.json first (where ask_secret stores keys),
// then falls back to environment variables.
function resolveApiKey(keyName: string): string | undefined {
  const fromEnv = process.env[keyName]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(AUTH_FILE, "utf8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const entry = auth[keyName] as Record<string, unknown> | undefined;
    if (entry && typeof entry.key === "string" && entry.key.trim()) {
      return entry.key.trim();
    }
  } catch { /* auth.json missing or unreadable — try env var */ }
  return undefined;
}

// ── Official Search APIs ──────────────────────────────────────────────
// Backends purpose-built for programmatic/LLM access — clean JSON,
// no scraping, no blocking. Keys resolved via auth.json → env var.
//   WEBSEARCH_EXA_KEY      — Exa MCP endpoint (anonymous works; key = dedicated quota)
//   WEBSEARCH_PARALLEL_KEY — Parallel MCP endpoint (anonymous works; key = Bearer auth)
//   WEBSEARCH_BRAVE_KEY    — Brave Search API (2,000 free queries/month)
//   WEBSEARCH_GOOGLE_KEY   — Google CSE API key (100 free queries/day)
//   WEBSEARCH_GOOGLE_CX    — Google CSE search engine ID
//   WEBSEARCH_TAVILY_KEY   — Tavily API (1,000 free queries/month)

async function searchBrave(query: string, signal?: AbortSignal): Promise<string | undefined> {
  const key = resolveApiKey("WEBSEARCH_BRAVE_KEY");
  if (!key) return undefined;
  try {
    const maxResults = getMaxResults();
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${String(maxResults)}`;
    const res = await fetchWithTimeout(url, 10_000, {
      signal,
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": key,
      },
    });
    if (res.status === 429) { noteRateLimit("brave", res); return undefined; }
    if (!res.ok) return undefined;
    const data = await res.json() as Record<string, unknown>;
    const web = data.web as Record<string, unknown> | undefined;
    const results = ((web?.results as Array<Record<string, unknown>>) || []).slice(0, maxResults);
    const lines: string[] = [];
    for (const r of results) {
      lines.push(`- [${safeStr(r.title)}](${safeStr(r.url)}) — ${truncateSnippet(safeStr(r.description))} *(via brave-api)*`);
    }
    return lines.join("\n") || "No results found.";
  } catch { return undefined; }
}

async function searchGoogleCse(query: string, signal?: AbortSignal): Promise<string | undefined> {
  const key = resolveApiKey("WEBSEARCH_GOOGLE_KEY");
  const cx = resolveApiKey("WEBSEARCH_GOOGLE_CX");
  if (!key || !cx) return undefined;
  try {
    const maxResults = getMaxResults();
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${String(maxResults)}`;
    const res = await fetchWithTimeout(url, 10_000, { signal });
    if (res.status === 429) { noteRateLimit("google-cse", res); return undefined; }
    if (!res.ok) return undefined;
    const data = await res.json() as Record<string, unknown>;
    const items = ((data.items as Array<Record<string, unknown>>) || []).slice(0, maxResults);
    const lines: string[] = [];
    for (const item of items) {
      lines.push(`- [${safeStr(item.title)}](${safeStr(item.link)}) — ${truncateSnippet(safeStr(item.snippet))} *(via google-cse)*`);
    }
    return lines.join("\n") || "No results found.";
  } catch { return undefined; }
}

async function searchTavily(query: string, signal?: AbortSignal): Promise<string | undefined> {
  const key = resolveApiKey("WEBSEARCH_TAVILY_KEY");
  if (!key) return undefined;
  try {
    const maxResults = getMaxResults();
    const url = "https://api.tavily.com/search";
    const body = JSON.stringify({ api_key: key, query, search_depth: "basic", max_results: maxResults });
    const res = await fetchWithTimeout(url, 10_000, {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.status === 429) { noteRateLimit("tavily", res); return undefined; }
    if (!res.ok) return undefined;
    const data = await res.json() as Record<string, unknown>;
    const results = ((data.results as Array<Record<string, unknown>>) || []).slice(0, maxResults);
    const lines: string[] = [];
    for (const r of results) {
      lines.push(`- [${safeStr(r.title)}](${safeStr(r.url)}) — ${truncateSnippet(safeStr(r.content))} *(via tavily)*`);
    }
    return lines.join("\n") || "No results found.";
  } catch { return undefined; }
}

// ── MCP search backends (Exa / Parallel) ──────────────────────────────
// Hosted MCP JSON-RPC endpoints — the same ones opencode's `websearch`
// tool uses. Anonymous access works; pass a key for dedicated quota.
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const MCP_TIMEOUT_MS = 15_000;
const MCP_MAX_BODY_CHARS = 256 * 1024;
const EXA_MAX_RESULTS = 20;

// Parse an MCP `tools/call` response — either a direct JSON body or an
// SSE stream (`data: {...}` lines). Returns the first content item's
// text, or undefined when the payload can't be parsed.
export function parseMcpResponse(body: string): string | undefined {
  const extract = (payload: string): string | undefined => {
    const trimmed = payload.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as {
        result?: { content?: Array<{ type?: string; text?: string }> };
      };
      const item = parsed.result?.content?.find(
        (c) => c?.type === "text" && typeof c.text === "string" && c.text.length > 0,
      );
      return item?.text;
    } catch { return undefined; }
  };

  const direct = extract(body);
  if (direct !== undefined) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = extract(line.slice(6));
    if (data !== undefined) return data;
  }
  return undefined;
}

// ── Rate-limit cooldown (HTTP 429) ────────────────────────────────────
// Honors Retry-After, defaults to 60s, capped at 10 min — mirrors
// opencode's provider rotation: cool the backend down, keep the chain
// moving through the remaining backends.
const COOLDOWNS = new Map<string, number>();

export function isCoolingDown(name: string): boolean {
  const until = COOLDOWNS.get(name);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  COOLDOWNS.delete(name);
  return false;
}

export function noteRateLimit(name: string, res: Response): void {
  let ms = 60_000;
  const ra = res.headers.get("retry-after");
  if (ra) {
    const seconds = Number(ra);
    if (Number.isFinite(seconds) && seconds > 0) {
      ms = seconds * 1000;
    } else {
      const date = Date.parse(ra);
      if (!Number.isNaN(date)) ms = Math.max(date - Date.now(), 0) || 60_000;
    }
  }
  COOLDOWNS.set(name, Date.now() + Math.min(ms, 600_000));
}

// POST a JSON-RPC `tools/call` request to an MCP endpoint and extract
// the response text (JSON body or SSE stream), capped at 256KB.
async function callMcp(
  backend: string,
  endpoint: string,
  tool: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const res = await fetchWithTimeout(endpoint, MCP_TIMEOUT_MS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    signal,
  });
  if (res.status === 429) {
    noteRateLimit(backend, res);
    return undefined;
  }
  if (!res.ok) return undefined;
  const raw = await res.text();
  return parseMcpResponse(raw.slice(0, MCP_MAX_BODY_CHARS));
}

async function searchExa(query: string, signal?: AbortSignal): Promise<string | undefined> {
  const key = resolveApiKey("WEBSEARCH_EXA_KEY");
  try {
    const endpoint = key ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(key)}` : EXA_MCP_URL;
    const text = await callMcp(
      "exa",
      endpoint,
      "web_search_exa",
      {
        query,
        type: "auto",
        numResults: Math.min(Math.max(getMaxResults(), 1), EXA_MAX_RESULTS),
        livecrawl: "fallback",
      },
      {},
      signal,
    );
    return text ? `${text.trim()}\n\n*(via exa)*` : undefined;
  } catch { return undefined; }
}

async function searchParallel(query: string, signal?: AbortSignal): Promise<string | undefined> {
  const key = resolveApiKey("WEBSEARCH_PARALLEL_KEY");
  try {
    const headers: Record<string, string> = { "User-Agent": "pi-web-search" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const text = await callMcp(
      "parallel",
      PARALLEL_MCP_URL,
      "web_search",
      {
        objective: query,
        search_queries: [query],
        session_id: `pi-${simpleHash(query + String(Date.now()))}`,
      },
      headers,
      signal,
    );
    if (!text) return undefined;
    // Parallel wraps results in JSON: { search_id, results: [{url,title,excerpts}] }
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      try {
        const data = JSON.parse(trimmed) as {
          results?: Array<{ url?: string; title?: string; excerpts?: string[] }>;
        };
        const results = (data.results || []).slice(0, getMaxResults());
        const lines = results.map((r) => {
          const excerpt = Array.isArray(r.excerpts) && r.excerpts.length ? r.excerpts[0] : "";
          return `- [${safeStr(r.title)}](${safeStr(r.url)})${excerpt ? ` — ${truncateSnippet(excerpt)}` : ""} *(via parallel)*`;
        });
        if (lines.length) return lines.join("\n");
      } catch { /* fall through — return raw text */ }
    }
    return `${trimmed}\n\n*(via parallel)*`;
  } catch { return undefined; }
}

async function searchWithApiBackend(
  query: string,
  signal?: AbortSignal,
): Promise<{ text: string; backend: string } | undefined> {
  const backends: Array<{ name: string; fn: (q: string, s?: AbortSignal) => Promise<string | undefined> }> = [
    { name: "exa", fn: searchExa },
    { name: "parallel", fn: searchParallel },
    { name: "brave", fn: searchBrave },
    { name: "google-cse", fn: searchGoogleCse },
    { name: "tavily", fn: searchTavily },
  ];
  for (const b of backends) {
    if (isCoolingDown(b.name)) continue; // 429 cooldown — skip to the next backend
    try {
      const text = await b.fn(query, signal);
      if (text) return { text, backend: b.name };
    } catch { /* try next */ }
  }
  return undefined;
}

// ── Browser detection ──────────────────────────────────────────────────
async function isBrowserAvailable(binary: string): Promise<boolean> {
  try {
    await run(binary, ["--version"]);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return !(msg.includes("ENOENT") || msg.toLowerCase().includes("not found"));
  }
}

let _cachedBrowserBinary: string | undefined;
let _browserProbed = false;

async function resolveBrowserFallbackBinary(): Promise<string | undefined> {
  if (_browserProbed) return _cachedBrowserBinary;
  _browserProbed = true;
  const configured = readBrowserFallbackPath();
  if (configured && (await isBrowserAvailable(configured))) {
    _cachedBrowserBinary = configured;
    return _cachedBrowserBinary;
  }
  for (const name of ["brave", "brave-browser", "brave-browser-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    if (await isBrowserAvailable(name)) {
      _cachedBrowserBinary = name;
      return _cachedBrowserBinary;
    }
  }
  return undefined;
}

// ── Playwright fallback ────────────────────────────────────────────────
function isMissingModuleError(error: unknown, moduleName: string): boolean {
  if (!(error instanceof Error)) return false;
  const haystack = `${error.message} ${(error as Error & { code?: string }).code ?? ""}`.toLowerCase();
  return haystack.includes(`cannot find module '${moduleName}'`) ||
    haystack.includes(`cannot find module "${moduleName}"`) ||
    haystack.includes("module not found") ||
    haystack.includes("err_module_not_found");
}

/**
 * Detect actual anti-bot challenge pages. Avoids false positives from
 * benign mentions (e.g. "speed.cloudflare.com" in search results).
 */
function isBlockedOrChallenge(text: string): boolean {
  const n = text.toLowerCase();
  return n.includes("navigation failed") ||
    n.includes("performing security verification") ||
    n.includes("verification successful") ||
    // Cloudflare challenge: these phrases appear on actual challenge pages
    // but NOT in search snippets mentioning "speed.cloudflare.com"
    (n.includes("cloudflare") && (
      n.includes("just a moment") ||
      n.includes("checking your browser") ||
      n.includes("please complete the security check") ||
      n.includes("attention required") ||
      n.includes("ddos protection")
    )) ||
    n.includes("bot verification") ||
    (n.includes("duckduckgo") && n.includes("select all squares containing a duck"));
}

function htmlToMarkdown(html: string): string {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|tr|table|thead|tbody|tfoot|blockquote|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return clean.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function runPlaywrightFallback(
  ctx: ExtensionContext,
  url: string,
  toolName: string,
  signal?: AbortSignal,
): Promise<ToolOutput | undefined> {
  if (signal?.aborted) return undefined;

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    if (isMissingModuleError(error, "playwright")) {
      if (ctx.hasUI) ctx.ui.notify("Playwright is not available.", "warning");
    }
    return undefined;
  }

  const browserBinary = await resolveBrowserFallbackBinary();
  const profileDir = join(homedir(), ".pi", "agent", "tmp", `browser-pw-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    mkdirSync(profileDir, { recursive: true });
    const launchOptions: {
      executablePath?: string;
      headless: boolean;
      viewport: { width: number; height: number };
      args: string[];
    } = {
      headless: true,
      viewport: { width: 1280, height: 720 },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    };
    if (browserBinary) launchOptions.executablePath = browserBinary;

    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    if (signal) {
      const onAbort = () => context?.close().catch(() => undefined);
      signal.addEventListener("abort", onAbort);
      setTimeout(() => signal.removeEventListener("abort", onAbort), 120000);
    }

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    await sleep(1500);

    let text = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")) || "";
    if (!text) text = htmlToMarkdown(await page.content().catch(() => ""));
    if (!text || isBlockedOrChallenge(text)) {
      await context.close().catch(() => undefined);
      return undefined;
    }

    await context.close().catch(() => undefined);
    return {
      content: [{ type: "text", text: [
        `# ${toolName === "web-search" ? "Search results" : "Page content"}`,
        "",
        `URL: ${url}`,
        `Browser: ${browserBinary || "playwright-chromium"}`,
        "",
        truncatePageDump(text),
      ].join("\n") }],
      details: { url, browserBinary: browserBinary || "playwright-chromium", rendered: true, fallback: "playwright" },
    };
  } catch {
    await context?.close().catch(() => undefined);
    return undefined;
  } finally {
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ── Orchestrator ───────────────────────────────────────────────────────
function makeResultText(toolName: string, url: string, body: string): string {
  return [`# ${toolName === "web-search" ? "Search results" : "Page content"}`, "", `Source: ${url}`, "", body].join("\n");
}

function extractQueryFromUrl(searchUrl: string): string {
  // Parse query param from URLs like https://bing.com/search?q=hello+world
  try {
    const qMatch = searchUrl.match(/[?&]q=([^&]+)/);
    if (qMatch) return decodeURIComponent(qMatch[1].replace(/\+/g, " "));
  } catch { /* ignore */ }
  return "";
}

const SEARCH_BACKEND = (process.env.WEBSEARCH_BACKEND || "").toLowerCase().trim() || "auto";
const SEARXNG_URL = (process.env.WEBSEARCH_SEARXNG_URL || "http://localhost:8888").replace(/\/+$/, "");

async function fetchWithFallback(
  toolName: string,
  url: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<ToolOutput> {
  if (signal?.aborted) return { content: [{ type: "text", text: "# Aborted by caller" }], details: {} };

  // ── Check cache ──────────────────────────────────────────────────────
  const cached = cacheRead(url);
  if (cached) return cached;

  // ── For web-search, try search backends → static fetch → renderers ──
  if (toolName === "web-search") {
    const query = extractQueryFromUrl(url);
    if (query) {
      // Determine backend ordering based on WEBSEARCH_BACKEND:
      //   searxng  → SearXNG first, then API backends
      //   auto/…  → API backends first, then SearXNG
      const forcedSearxng = SEARCH_BACKEND === "searxng";
      let searxngSucceeded = false;

      if (forcedSearxng) {
        // Forced SearXNG mode — skip the probe, just try the search
        try {
          const text = await searchSearxng(query, SEARXNG_URL, signal);
          const result: ToolOutput = {
            content: [{ type: "text", text: makeResultText(toolName, url, text) }],
            details: { url, rendered: true, backend: "searxng" },
          };
          cacheWrite(url, result);
          return result;
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          if (ctx.hasUI) ctx.ui.notify(`SearXNG search failed, falling through: ${reason}`, "info");
        }
      } else {
        // Auto / unset — API backends first, then SearXNG
        const apiResult = await searchWithApiBackend(query, signal);
        if (apiResult) {
          const result: ToolOutput = {
            content: [{ type: "text", text: makeResultText(toolName, url, apiResult.text) }],
            details: { url, rendered: true, backend: apiResult.backend },
          };
          cacheWrite(url, result);
          return result;
        }

        // SearXNG — local aggregator across 70+ engines
        const wantSearxng = SEARCH_BACKEND === "searxng" || (SEARCH_BACKEND === "auto" && await isSearxngAvailable(SEARXNG_URL));
        if (wantSearxng) {
          try {
            const text = await searchSearxng(query, SEARXNG_URL, signal);
            searxngSucceeded = true;
            const result: ToolOutput = {
              content: [{ type: "text", text: makeResultText(toolName, url, text) }],
              details: { url, rendered: true, backend: "searxng" },
            };
            cacheWrite(url, result);
            return result;
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            if (ctx.hasUI) ctx.ui.notify(`SearXNG search failed, falling through: ${reason}`, "info");
          }
        }

        // Static HTTP fast path — try plain fetch before reaching for renderers.
        // Skip when searxng already succeeded (search URLs don't need static-fetch).
        if (!searxngSucceeded) {
          const staticResult = await tryStaticFetch(url, toolName);
          if (staticResult) {
            cacheWrite(url, staticResult);
            return staticResult;
          }
        }
      }
    } else {
      // open-url or search URL without a parseable query: try static fetch first
      const staticResult = await tryStaticFetch(url, toolName);
      if (staticResult) {
        cacheWrite(url, staticResult);
        return staticResult;
      }
    }
  } else {
    // open-url: try static fetch before heavy renderers
    const staticResult = await tryStaticFetch(url, toolName);
    if (staticResult) {
      cacheWrite(url, staticResult);
      return staticResult;
    }
  }

  // ── Lightpanda ───────────────────────────────────────────────────────
  const binary = getLightpandaBinary();
  const lpAvailable = await isLightpandaAvailable(binary);
  if (lpAvailable) {
    try {
      const result = await fetchMarkdown(binary, url, { signal, timeoutMs: 30000 });
      const body = result.stdout.trim();
      if (body && !isBlockedOrChallenge(body)) {
        const toolResult: ToolOutput = {
          content: [{ type: "text", text: makeResultText(toolName, url, truncatePageDump(body)) }],
          details: { binary, url, available: true, rendered: true, backend: "lightpanda" },
        };
        cacheWrite(url, toolResult);
        return toolResult;
      } else if (body && ctx.hasUI) {
        ctx.ui.notify("Lightpanda output blocked — likely false positive", "warning");
      }
    } catch { /* fall through */ }
  }

  // ── Playwright ───────────────────────────────────────────────────────
  const pwResult = await runPlaywrightFallback(ctx, url, toolName, signal);
  if (pwResult) {
    cacheWrite(url, pwResult);
    return pwResult;
  }

  // ── All failed — write negative cache entry ──────────────────────────
  cacheWriteFailure(url);

  if (!lpAvailable) {
    return {
      content: [{ type: "text", text: `# ${toolName} unavailable\n\nLightpanda is required. Use: install-lightpanda` }],
      details: { available: false, suggestedTool: "install-lightpanda" },
    };
  }

  return {
    content: [{ type: "text", text: `# ${toolName} failed\n\nURL: ${url}\n\nLightpanda and Playwright could not render this page.` }],
    details: { url, rendered: false, backend: "lightpanda" },
  };
}

// ── Static HTTP fast path ──────────────────────────────────────────────
// Attempt a plain native fetch before reaching for heavy renderers.
async function tryStaticFetch(url: string, toolName: string): Promise<ToolOutput | undefined> {
  try {
    const res = await fetchWithTimeout(url, 15_000, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return undefined;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return undefined;
    const html = await res.text();
    if (isBlockedOrChallenge(html)) return undefined;
    return {
      content: [{ type: "text", text: makeResultText(toolName, url, truncatePageDump(htmlToMarkdown(html))) }],
      details: { url, rendered: true, backend: "static-fetch" },
    };
  } catch {
    return undefined;
  }
}

// ── Setup tools ────────────────────────────────────────────────────────
async function installLightpanda(ctx: ExtensionContext, options: InstallParams): Promise<ToolOutput> {
  const binary = LIGHTPANDA_INSTALL_PATH;
  const assetName = detectAssetName();
  if (!assetName) {
    return {
      content: [{ type: "text", text: `# Lightpanda install not supported\n\nPlatform not supported (${process.platform} ${process.arch}).\n\n${LIGHTPANDA_INSTALL_URL}` }],
      details: { installed: false, supported: false },
    };
  }

  if (await isLightpandaAvailable(binary) && !options.force) {
    return { content: [{ type: "text", text: `# Lightpanda already installed\n\nBinary: ${binary}` }], details: { installed: true, alreadyInstalled: true } };
  }

  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm("Install Lightpanda?", `Download ${assetName} into ${binary}?`);
    if (!ok) return { content: [{ type: "text", text: "# Cancelled" }], details: { installed: false, cancelled: true } };
  }

  const dest = join(homedir(), ".pi", "agent", "bin");
  mkdirSync(dest, { recursive: true });
  const res = await fetch(buildReleaseUrl(assetName));
  if (!res.ok) throw new Error(`Download failed: HTTP ${String(res.status)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(binary, buf);
  chmodSync(binary, 0o755);
  await run(binary, ["version"]);

  if (ctx.hasUI) ctx.ui.notify(`Lightpanda installed at ${binary}`, "info");
  return { content: [{ type: "text", text: `# Lightpanda installed\n\nBinary: ${binary}` }], details: { installed: true, binary, assetName } };
}

async function installPlaywrightRuntime(ctx: ExtensionContext, options: InstallParams): Promise<ToolOutput> {
  const pkgPath = `${PACKAGE_ROOT}/package.json`;
  if (!existsSync(pkgPath)) {
    return { content: [{ type: "text", text: "# Playwright install unavailable\n\nNo package.json found." }], details: {} };
  }

  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm("Install Playwright?", "Install Playwright in the web-search package?");
    if (!ok) return { content: [{ type: "text", text: "# Cancelled" }], details: { installed: false, cancelled: true } };
  }

  const npmInstall = spawnSync("npm", options.force ? ["install", "--force"] : ["install"], { cwd: PACKAGE_ROOT, stdio: "pipe", encoding: "utf8" });
  if (npmInstall.status !== 0) {
    return { content: [{ type: "text", text: `# Playwright install failed\n\n${npmInstall.stderr || npmInstall.stdout}` }], details: { installed: false } };
  }

  if (ctx.hasUI) ctx.ui.notify("Playwright installed", "info");
  return { content: [{ type: "text", text: "# Playwright installed\n\nReady for fallback browsing." }], details: { installed: true } };
}

async function setBrowserFallbackPath(ctx: ExtensionContext, params: ConfigureBrowserParams): Promise<ToolOutput> {
  const path = params.browserPath?.trim();
  if (!path) {
    return {
      content: [{ type: "text", text: "# Browser path required\n\nProvide a full path to a Chromium-family browser:\n- /usr/bin/brave-browser-stable\n- /usr/bin/google-chrome" }],
      details: { configured: false },
    };
  }
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(BROWSER_FALLBACK_CONFIG_PATH, path, "utf8");
  if (ctx.hasUI) ctx.ui.notify(`Browser fallback saved: ${path}`, "info");
  return {
    content: [{ type: "text", text: `# Browser fallback configured\n\nPath: ${path}\nPlaywright will use this browser.` }],
    details: { configured: true, browserPath: path },
  };
}

// ── Registration ───────────────────────────────────────────────────────
export default function registerWebSearchTool(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!await isLightpandaAvailable(getLightpandaBinary()) && ctx.hasUI) {
      ctx.ui.notify("Lightpanda is missing. Run install-lightpanda.", "warning");
    }
  });

  pi.registerTool({
    name: "install-lightpanda",
    label: "Install Lightpanda",
    description: "Download and install the Lightpanda browser binary for the current platform.",
    promptSnippet: "Use install-lightpanda when web-search cannot run because Lightpanda is missing.",
    promptGuidelines: [
      "Call this tool when the backend is missing or not on PATH.",
      "If installation is not supported on the current platform, explain the manual setup path instead.",
    ],
    parameters: { type: "object", properties: { force: { type: "boolean" } }, additionalProperties: false },
    async execute(_id: string, params: InstallParams, signal, _upd, ctx): Promise<ToolOutput> {
      if (signal?.aborted) return { content: [{ type: "text", text: "# Aborted" }], details: {} };
      return installLightpanda(ctx, { force: params.force === true });
    },
  });

  pi.registerTool({
    name: "install-playwright",
    label: "Install Playwright",
    description: "Install Playwright in the web-search package runtime for the browser fallback.",
    promptSnippet: "Use install-playwright when the fallback fails and Playwright is missing.",
    promptGuidelines: [
      "Call this tool when Playwright is missing from the installed package runtime.",
      "If installation is not supported, explain the manual setup path instead.",
    ],
    parameters: { type: "object", properties: { force: { type: "boolean" } }, additionalProperties: false },
    async execute(_id: string, params: InstallParams, signal, _upd, ctx): Promise<ToolOutput> {
      if (signal?.aborted) return { content: [{ type: "text", text: "# Aborted" }], details: {} };
      return installPlaywrightRuntime(ctx, { force: params.force === true });
    },
  });

  pi.registerTool({
    name: "set-browser-fallback",
    label: "Set Browser Fallback",
    description: "Save the path to a Chromium-family browser binary used by the Playwright fallback.",
    promptSnippet: "Use set-browser-fallback when auto-detection cannot find a usable browser binary.",
    promptGuidelines: [
      "Ask the user for an explicit browser binary path only when automatic detection fails.",
      "Store the path and reuse it for future fallback browser sessions.",
    ],
    parameters: {
      type: "object",
      properties: { browserPath: { type: "string", minLength: 1, description: "Full path to a Chromium-family browser." } },
      required: ["browserPath"],
      additionalProperties: false,
    },
    async execute(_id: string, params: ConfigureBrowserParams, signal, _upd, ctx): Promise<ToolOutput> {
      if (signal?.aborted) return { content: [{ type: "text", text: "# Aborted" }], details: {} };
      return setBrowserFallbackPath(ctx, params);
    },
  });

  pi.registerTool({
    name: "web-search",
    label: "Web Search",
    description: "Search the web — tries SearXNG first (if available), then Lightpanda, then Playwright.",
    promptSnippet: "Use web-search when you need current or source-backed web results.",
    promptGuidelines: [
      "Prefer precise queries, then refine using site: or quoted phrases if the first pass is noisy.",
      "Treat the result as a browser-rendered page dump; inspect linked sources before answering definitively.",
      "If Lightpanda is missing, call install-lightpanda first or explain the manual install path.",
    ],
    parameters: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, description: "Search terms." } },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_id: string, params: SearchParams, signal, _upd, ctx): Promise<ToolOutput> {
      if (signal?.aborted) return { content: [{ type: "text", text: "# Aborted" }], details: {} };
      const query = params.query.trim();
      if (!query) throw new Error("Query is required.");
      const template = process.env.WEBSEARCH_URL_TEMPLATE || "https://www.bing.com/search?q={query}";
      const searchUrl = template.replace("{query}", encodeURIComponent(query));
      return fetchWithFallback("web-search", searchUrl, ctx, signal);
    },
  });

  pi.registerTool({
    name: "open-url",
    label: "Open URL",
    description: "Open a specific URL — tries Lightpanda, then Playwright fallback.",
    promptSnippet: "Use open-url when you already know the page URL and want to inspect it directly.",
    promptGuidelines: [
      "Prefer open-url after search when the user has a specific page in mind.",
      "If Lightpanda cannot render the page, the tool will try Playwright before failing.",
    ],
    parameters: {
      type: "object",
      properties: { url: { type: "string", minLength: 1, description: "A direct http or https URL." } },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(_id: string, params: OpenUrlParams, signal, _upd, ctx): Promise<ToolOutput> {
      if (signal?.aborted) return { content: [{ type: "text", text: "# Aborted" }], details: {} };
      return fetchWithFallback("open-url", normalizeUrl(params.url), ctx, signal);
    },
  });
}
