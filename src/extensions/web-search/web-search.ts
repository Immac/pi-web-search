import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
const LIGHTPANDA_INSTALL_URL = "https://github.com/lightpanda-io/browser";
const LIGHTPANDA_BINARY_NAME = "lightpanda";
const LIGHTPANDA_INSTALL_PATH = join(homedir(), ".pi", "agent", "bin", LIGHTPANDA_BINARY_NAME);
const BROWSER_FALLBACK_CONFIG_PATH = join(homedir(), ".pi", "agent", "web-search-browser-path.txt");
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(MODULE_DIR, "../../..");
const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "web-search");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min for search, 1 hour for pages

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

function cacheRead(url: string): ToolOutput | undefined {
  const path = join(CACHE_DIR, `${simpleHash(url)}.json`);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const data = JSON.parse(readFileSync(path, "utf8")) as { url: string; result: ToolOutput; cachedAt: number };
    const ttl = data.url.startsWith("http") && data.url.includes("/search?") ? CACHE_TTL_MS : CACHE_TTL_MS * 12;
    if (Date.now() - data.cachedAt < ttl) return data.result;
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
  try {
    await run("curl", ["-fsSL", "-o", "/dev/null", "--max-time", "3", `${searxngUrl}/search?q=test&format=json`]);
    return true;
  } catch { return false; }
}

async function searchSearxng(
  query: string,
  searxngUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await run("curl", ["-fsSL", "--max-time", "10", url], undefined, { signal, timeoutMs: 12000 });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: Record<string, unknown> = JSON.parse(res.stdout);

  const results = (data.results as Array<Record<string, string>>) || [];
  const answers = (data.answers as string[]) || [];
  const suggestions = (data.suggestions as string[]) || [];
  const infoboxes = (data.infoboxes as Array<Record<string, string>>) || [];
  const unresponsive = (data.unresponsive_engines as string[]) || [];
  const numResults = data.number_of_results as number | undefined;

  const lines: string[] = [];
  if (infoboxes.length) {
    for (const box of infoboxes) {
      lines.push(`> **${box.infobox || ""}** — ${box.content || ""}`);
    }
    lines.push("");
  }
  if (numResults !== undefined) { lines.push(`**${numResults} results**`); lines.push(""); }
  if (answers.length) { for (const a of answers) { lines.push(`> ${a}`); } lines.push(""); }
  if (suggestions.length) { lines.push(`**Suggestions:** ${suggestions.join(", ")}`); lines.push(""); }

  for (const r of results) {
    const title = r.title || "Untitled";
    const href = r.url || "";
    const snippet = r.content || "";
    const engine = r.engine || "?";
    lines.push(`- [${title}](${href}) — ${snippet} *(via ${engine})*`);
  }

  if (unresponsive.length) {
    lines.push("");
    lines.push(`_Unresponsive engines: ${unresponsive.join(", ")}_`);
  }

  return lines.join("\n") || "No results found.";
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

function isBlockedOrChallenge(text: string): boolean {
  const n = text.toLowerCase();
  return n.includes("navigation failed") ||
    n.includes("performing security verification") ||
    n.includes("verification successful") ||
    n.includes("cloudflare") ||
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
    await run("mkdir", ["-p", profileDir]);
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
        text,
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

  // ── For web-search, try SearXNG first ────────────────────────────────
  if (toolName === "web-search") {
    const wantSearxng = SEARCH_BACKEND === "searxng" || (SEARCH_BACKEND === "auto" && await isSearxngAvailable(SEARXNG_URL));
    if (wantSearxng) {
      const query = extractQueryFromUrl(url);
      if (query) {
        try {
          const text = await searchSearxng(query, SEARXNG_URL, signal);
          const result: ToolOutput = {
            content: [{ type: "text", text: makeResultText(toolName, url, text) }],
            details: { url, rendered: true, backend: "searxng" },
          };
          cacheWrite(url, result);
          return result;
        } catch { /* fall through to Lightpanda */ }
      }
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
          content: [{ type: "text", text: makeResultText(toolName, url, body) }],
          details: { binary, url, available: true, rendered: true, backend: "lightpanda" },
        };
        cacheWrite(url, toolResult);
        return toolResult;
      }
    } catch { /* fall through */ }
  }

  // ── Playwright ───────────────────────────────────────────────────────
  const pwResult = await runPlaywrightFallback(ctx, url, toolName, signal);
  if (pwResult) {
    cacheWrite(url, pwResult);
    return pwResult;
  }

  // ── All failed ───────────────────────────────────────────────────────
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
  await run("mkdir", ["-p", dest]);
  await run("curl", ["-fsSL", "-o", binary, buildReleaseUrl(assetName)]);
  await run("chmod", ["a+x", binary]);
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
