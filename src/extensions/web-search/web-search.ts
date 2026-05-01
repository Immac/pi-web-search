import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type SearchParams = {
  query: string;
};

type OpenUrlParams = {
  url: string;
};

type InstallParams = {
  force?: boolean;
};

type ConfigureBrowserParams = {
  browserPath?: string;
};

type ToolOutput = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type CdpEvent = {
  method: string;
  params?: Record<string, unknown>;
};

type CdpResponse = {
  id: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type CdpSocket = {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  callSession(sessionId: string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  waitForEvent(method: string, timeoutMs?: number): Promise<Record<string, unknown> | undefined>;
  waitForSessionEvent(sessionId: string, method: string, timeoutMs?: number): Promise<Record<string, unknown> | undefined>;
  close(): void;
};

const DEFAULT_SEARCH_URL = "https://html.duckduckgo.com/html/?q={query}";
const LIGHTPANDA_INSTALL_URL = "https://github.com/lightpanda-io/browser";
const LIGHTPANDA_BINARY_NAME = "lightpanda";
const LIGHTPANDA_INSTALL_PATH = `${getHomeDir()}/.pi/agent/bin/${LIGHTPANDA_BINARY_NAME}`;
const BROWSER_FALLBACK_PORT = Number(process.env.WEBSEARCH_CDP_PORT?.trim() || "9222");
const BROWSER_FALLBACK_CONFIG_PATH = `${getHomeDir()}/.pi/agent/web-search-browser-path.txt`;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(MODULE_DIR, "../../..");
const BROWSER_FALLBACK_CANDIDATES = [
  process.env.BROWSER_FALLBACK_BIN?.trim(),
  process.env.BRAVE_BIN?.trim(),
  process.env.BRAVE_BROWSER_BIN?.trim(),
  process.env.CHROME_BIN?.trim(),
  process.env.GOOGLE_CHROME_BIN?.trim(),
  "brave",
  "brave-browser",
  "brave-browser-stable",
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
].filter((value): value is string => Boolean(value));

let missingBackendWarned = false;
let playwrightWarned = false;

function getHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || process.cwd();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

function getSearchUrl(query: string): string {
  const template = process.env.WEBSEARCH_URL_TEMPLATE?.trim() || DEFAULT_SEARCH_URL;
  return template.replace("{query}", encodeURIComponent(query));
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
  if (configured) {
    return configured;
  }

  try {
    const fs = require("node:fs") as {
      existsSync(path: string): boolean;
      readFileSync(path: string, encoding: string): string;
    };
    if (fs.existsSync(BROWSER_FALLBACK_CONFIG_PATH)) {
      const value = fs.readFileSync(BROWSER_FALLBACK_CONFIG_PATH, "utf8").trim();
      return value || undefined;
    }
  } catch {
    // ignore
  }

  return undefined;
}

function detectAssetName(): string | null {
  if (process.platform === "linux" && process.arch === "x64") {
    return "lightpanda-x86_64-linux";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "lightpanda-aarch64-linux";
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "lightpanda-aarch64-macos";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "lightpanda-x86_64-macos";
  }
  return null;
}

function buildReleaseUrl(assetName: string): string {
  return `https://github.com/lightpanda-io/browser/releases/download/nightly/${assetName}`;
}

function run(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });

    child.on("error", (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("close", (code: unknown) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || `Command failed with exit code ${String(code)}`));
    });
  });
}

function spawnDetached(command: string, args: string[]): { child: ReturnType<typeof spawn> } {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.unref?.();
  return { child };
}

function isBlockedOrChallenge(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("navigation failed") ||
    normalized.includes("performing security verification") ||
    normalized.includes("verification successful") ||
    normalized.includes("cloudflare") ||
    normalized.includes("bot verification") ||
    normalized.includes("duckduckgo") && normalized.includes("select all squares containing a duck")
  );
}

function isMissingModuleError(error: unknown, moduleName: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const haystack = `${error.message} ${(error as Error & { code?: string }).code ?? ""}`.toLowerCase();
  return haystack.includes(`cannot find module '${moduleName}'`) ||
    haystack.includes(`cannot find module "${moduleName}"`) ||
    haystack.includes('module not found') ||
    haystack.includes('err_module_not_found');
}

function makeMissingPlaywrightResult(toolName: string, url: string, reason: string): ToolOutput {
  const configuredPath = readBrowserFallbackPath();
  const lines = [
    `# ${toolName} playwright fallback unavailable`,
    "",
    `URL: ${url}`,
    `Reason: ${reason}`,
    "",
    "The extension reached its final fallback, but Playwright is not available in the installed package runtime.",
    "Use the install-playwright tool to install or repair Playwright in this package runtime.",
  ];
  
  if (configuredPath) {
    lines.push("");
    lines.push(`Browser fallback configured: ${configuredPath}`);
    lines.push("If CDP fails, try a different path with: set-browser-fallback --browserPath /path/to/working-browser");
  } else {
    lines.push("");
    lines.push("No browser fallback configured.");
    lines.push("Use: set-browser-fallback --browserPath /usr/bin/brave-browser-stable");
  }
  
  return {
    content: [
      {
        type: "text",
        text: lines.join("\n"),
      },
    ],
    details: {
      url,
      rendered: false,
      fallback: "playwright",
      error: reason,
      missingDependency: "playwright",
      suggestedTool: "install-playwright",
    },
  };
}

async function installPlaywrightRuntime(ctx: ExtensionContext, options: InstallParams): Promise<ToolOutput> {
  const packageJsonPath = `${PACKAGE_ROOT}/package.json`;
  const { spawnSync } = require("node:child_process") as {
    spawnSync(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string | undefined>; stdio?: string; encoding?: string }): { status: number | null; stdout: string; stderr: string };
  };
  const fs = require("node:fs") as { existsSync(path: string): boolean };

  if (!fs.existsSync(packageJsonPath)) {
    return {
      content: [
        {
          type: "text",
          text: [
            "# Playwright install is not available",
            "",
            `No package.json found at ${PACKAGE_ROOT}.`,
            "",
            "The extension runtime cannot repair Playwright in this location.",
          ].join("\n"),
        },
      ],
      details: { installed: false, supported: false, packageRoot: PACKAGE_ROOT },
    };
  }

  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      "Install Playwright?",
      "Install or repair Playwright in the web-search package runtime and download the Chromium browser used by the final fallback?",
    );
    if (!ok) {
      return {
        content: [{ type: "text", text: "# Playwright installation cancelled by user" }],
        details: { installed: false, cancelled: true },
      };
    }
  }

  const npmInstall = spawnSync("npm", options.force ? ["install", "--force"] : ["install"], { cwd: PACKAGE_ROOT, env: process.env, stdio: "pipe", encoding: "utf8" });
  if (npmInstall.status !== 0) {
    const stderr = String(npmInstall.stderr || npmInstall.stdout || "npm install failed").trim();
    return {
      content: [
        {
          type: "text",
          text: [
            "# Playwright installation failed",
            "",
            `npm install failed in ${PACKAGE_ROOT}`,
            stderr,
          ].join("\n"),
        },
      ],
      details: { installed: false, packageRoot: PACKAGE_ROOT, error: stderr },
    };
  }

  // Note: Skipping Chromium download - extension uses Brave browser instead
  // Brave is Chromium-based and can be used with Playwright via executablePath

  if (ctx.hasUI) {
    ctx.ui.notify(`Playwright installed in ${PACKAGE_ROOT} (using Brave browser)`, "info");
  }

  return {
    content: [
      {
        type: "text",
        text: [
          "# Playwright installed (Brave browser)",
          "",
          `Package root: ${PACKAGE_ROOT}`,
          "",
          "The extension will use Brave browser (Chromium-based) instead of downloading Chromium.",
        ].join("\n"),
      },
    ],
    details: { installed: true, packageRoot: PACKAGE_ROOT, browser: "brave" },
  };
}

async function isLightpandaAvailable(binary: string): Promise<boolean> {
  try {
    await run(binary, ["version"]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return !(message.includes("ENOENT") || message.toLowerCase().includes("not found"));
  }
}

async function isBrowserFallbackAvailable(binary: string): Promise<boolean> {
  try {
    await run(binary, ["--version"]);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return !(message.includes("ENOENT") || message.toLowerCase().includes("not found"));
  }
}

async function resolveBrowserFallbackBinary(): Promise<string | undefined> {
  const configured = readBrowserFallbackPath();
  if (configured && (await isBrowserFallbackAvailable(configured))) {
    return configured;
  }

  for (const candidate of BROWSER_FALLBACK_CANDIDATES) {
    if (await isBrowserFallbackAvailable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function resolveBrowserFallbackBinaries(): Promise<string[]> {
  const candidates = [readBrowserFallbackPath(), ...BROWSER_FALLBACK_CANDIDATES].filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  const available: string[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    
    // Resolve full path using which
    let fullPath = candidate;
    if (!candidate.startsWith("/")) {
      try {
        const whichResult = await run("which", [candidate]);
        fullPath = whichResult.stdout.trim();
      } catch {
        fullPath = candidate;
      }
    }
    
    if (await isBrowserFallbackAvailable(fullPath)) {
      available.push(fullPath);
    }
  }

  return available;
}


async function fetchMarkdown(binary: string, url: string): Promise<{ stdout: string; stderr: string }> {
  return run(binary, [
    "fetch",
    "--dump",
    "markdown",
    "--wait-ms",
    "1000",
    "--log-level",
    "error",
    url,
  ]);
}

async function httpGetJson(url: string): Promise<Record<string, unknown>> {
  const result = await run("curl", ["-fsSL", url]);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function makeTimeoutPromise<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function createCdpSocket(webSocketUrl: string): CdpSocket {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const eventWaiters = new Map<string, Array<(params: Record<string, unknown> | undefined) => void>>();
  const sessionEventWaiters = new Map<string, Map<string, Array<(params: Record<string, unknown> | undefined) => void>>>();

  const ready = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error(`Failed to connect to CDP websocket: ${webSocketUrl}`));
  });

  function dispatchEvent(sessionId: string | undefined, method: string, params: Record<string, unknown> | undefined): void {
    if (sessionId) {
      const perSession = sessionEventWaiters.get(sessionId);
      const waiters = perSession?.get(method);
      if (waiters && waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter) {
          waiter(params);
        }
      }
      return;
    }

    const waiters = eventWaiters.get(method);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(params);
      }
    }
  }

  socket.onmessage = (event: { data: unknown }) => {
    let payload: CdpResponse | (CdpEvent & { sessionId?: string });
    try {
      payload = JSON.parse(String(event.data)) as CdpResponse | (CdpEvent & { sessionId?: string });
    } catch {
      return;
    }

    if ("id" in payload) {
      const record = pending.get(payload.id);
      if (!record) {
        return;
      }
      pending.delete(payload.id);
      if (payload.error?.message) {
        record.reject(new Error(payload.error.message));
        return;
      }
      record.resolve(payload.result ?? {});
      return;
    }

    dispatchEvent((payload as { sessionId?: string }).sessionId, payload.method, payload.params);
  };

  socket.onclose = () => {
    for (const record of pending.values()) {
      record.reject(new Error(`CDP websocket closed: ${webSocketUrl}`));
    }
    pending.clear();
  };

  async function call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    await ready;
    const id = nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(message);
    });
  }

  async function callSession(sessionId: string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    await ready;
    const id = nextId++;
    const message = JSON.stringify({ id, sessionId, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(message);
    });
  }

  function waitForEvent(method: string, timeoutMs = 15000): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve, reject) => {
      const waiters = eventWaiters.get(method) ?? [];
      eventWaiters.set(method, waiters);
      waiters.push((params) => resolve(params));
      void makeTimeoutPromise(timeoutMs, `Timed out waiting for ${method}`).catch(reject);
    });
  }

  function waitForSessionEvent(sessionId: string, method: string, timeoutMs = 15000): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve, reject) => {
      const perSession = sessionEventWaiters.get(sessionId) ?? new Map<string, Array<(params: Record<string, unknown> | undefined) => void>>();
      sessionEventWaiters.set(sessionId, perSession);
      const waiters = perSession.get(method) ?? [];
      perSession.set(method, waiters);
      waiters.push((params) => resolve(params));
      void makeTimeoutPromise(timeoutMs, `Timed out waiting for ${method} on session ${sessionId}`).catch(reject);
    });
  }

  function close(): void {
    socket.close();
  }

  return { call, callSession, waitForEvent, waitForSessionEvent, close };
}

function htmlToMarkdown(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  const withBreaks = withoutScripts
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|tr|table|thead|tbody|tfoot|blockquote|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "");

  const stripped = withBreaks
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, " ");

  const decoded = stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return decoded.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function missingBackendInstructions(binary: string, toolName: string, browserFallbackBinary?: string): string {
  const assetName = detectAssetName();
  const downloadUrl = assetName ? buildReleaseUrl(assetName) : LIGHTPANDA_INSTALL_URL;
  const platformLine = assetName
    ? `Detected platform asset: ${assetName}`
    : `Detected platform is not supported by the automatic installer.`;
  const browserLine = browserFallbackBinary
    ? `Browser fallback candidate: ${browserFallbackBinary}`
    : `No browser fallback binary was detected on PATH or via config.`;

  return [
    `Lightpanda is required for ${toolName}.`,
    "",
    `Current binary setting: ${binary}`,
    platformLine,
    browserLine,
    "",
    "Option 1: call the install-lightpanda tool",
    "",
    "Option 2: install manually",
    "```bash",
    `curl -L -o ${LIGHTPANDA_BINARY_NAME} ${downloadUrl}`,
    `chmod a+x ./${LIGHTPANDA_BINARY_NAME}`,
    `./${LIGHTPANDA_BINARY_NAME} version`,
    `export LIGHTPANDA_BIN=\"$(pwd)/${LIGHTPANDA_BINARY_NAME}\"`,
    "```",
    "",
    "Project docs:",
    LIGHTPANDA_INSTALL_URL,
  ].join("\n");
}

function makeMissingBackendResult(binary: string, toolName: string, browserFallbackBinary?: string): ToolOutput {
  return {
    content: [
      {
        type: "text",
        text: [`# Lightpanda is not available`, "", missingBackendInstructions(binary, toolName, browserFallbackBinary)].join("\n"),
      },
    ],
    details: {
      binary,
      available: false,
      installUrl: LIGHTPANDA_INSTALL_URL,
      suggestedTool: "install-lightpanda",
      toolName,
      browserFallbackBinary: browserFallbackBinary || undefined,
    },
  };
}

function makeFetchFailureResult(toolName: string, target: string, error: unknown, binary: string, backend?: string): ToolOutput {
  const message = error instanceof Error ? error.message : String(error);
  const configuredPath = readBrowserFallbackPath();
  const browserSuggestion = !configuredPath 
    ? `\n\n**No browser fallback configured.**\nUse: \`set-browser-fallback --browserPath /usr/bin/brave-browser-stable\`` 
    : ``;
  
  return {
    content: [
      {
        type: "text",
        text: [
          `# ${toolName} failed`,
          "",
          `Target: ${target}`,
          `Binary: ${binary}`,
          backend ? `Backend: ${backend}` : undefined,
          `Reason: ${message}`,
          "",
          "Lightpanda and browser fallbacks could not render this page.",
          browserSuggestion,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    details: {
      binary,
      target,
      available: true,
      error: message,
      rendered: false,
      backend: backend || undefined,
    },
  };
}

async function warnIfMissingBackend(ctx: ExtensionContext, binary: string): Promise<void> {
  if (missingBackendWarned) {
    return;
  }

  const available = await isLightpandaAvailable(binary);
  if (available) {
    return;
  }

  missingBackendWarned = true;
  if (ctx.hasUI) {
    ctx.ui.notify(
      `Lightpanda is missing. Call install-lightpanda, set LIGHTPANDA_BIN, or install it from ${LIGHTPANDA_INSTALL_URL}.`,
      "warning",
    );
  }
}

async function installLightpanda(ctx: ExtensionContext, options: InstallParams): Promise<ToolOutput> {
  const binary = LIGHTPANDA_INSTALL_PATH;
  const assetName = detectAssetName();
  if (!assetName) {
    return {
      content: [
        {
          type: "text",
          text: [
            "# Lightpanda install is not supported on this platform",
            "",
            "The extension can guide you to the upstream project, but the automatic installer only supports Linux x64, Linux arm64, macOS arm64, and macOS x64.",
            "",
            LIGHTPANDA_INSTALL_URL,
          ].join("\n"),
        },
      ],
      details: {
        installed: false,
        supported: false,
        installUrl: LIGHTPANDA_INSTALL_URL,
      },
    };
  }

  const alreadyAvailable = await isLightpandaAvailable(binary);
  if (alreadyAvailable && !options.force) {
    return {
      content: [
        {
          type: "text",
          text: [`# Lightpanda is already installed`, ``, `Binary: ${binary}`, `Asset: ${assetName}`].join("\n"),
        },
      ],
      details: {
        installed: true,
        binary,
        assetName,
        alreadyInstalled: true,
      },
    };
  }

  const downloadUrl = buildReleaseUrl(assetName);
  const destinationDir = `${getHomeDir()}/.pi/agent/bin`;

  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      "Install Lightpanda?",
      `Download ${assetName} into ${binary}?`,
    );
    if (!ok) {
      return {
        content: [{ type: "text", text: "# Lightpanda installation cancelled by user" }],
        details: { installed: false, cancelled: true, binary, assetName },
      };
    }
  }

  await run("mkdir", ["-p", destinationDir]);
  await run("curl", ["-fsSL", "-o", binary, downloadUrl]);
  await run("chmod", ["a+x", binary]);
  await run(binary, ["version"]);

  if (ctx.hasUI) {
    ctx.ui.notify(`Lightpanda installed at ${binary}`, "info");
  }

  // Check for browser fallback and add instructions if missing
  const browserFallback = await resolveBrowserFallbackBinary();

  return {
    content: [
      {
        type: "text",
        text: [
          "# Lightpanda installed",
          "",
          `Binary: ${binary}`,
          `Asset: ${assetName}`,
          `Source: ${downloadUrl}`,
          browserFallback ? `Browser fallback: ${browserFallback}` : "",
          !browserFallback ? "" : "",
          !browserFallback ? "**No compatible browser fallback detected.**" : "",
          !browserFallback ? "Use the `set-browser-fallback` tool to configure a Chromium-based browser (e.g., Brave):" : "",
          !browserFallback ? "```" : "",
          !browserFallback ? "set-browser-fallback --browserPath /usr/bin/brave-browser" : "",
          !browserFallback ? "```" : "",
          "",
          "You can retry web-search or open-url now.",
        ].filter(Boolean).join("\n"),
      },
    ],
    details: {
      installed: true,
      binary,
      assetName,
      downloadUrl,
      destinationDir,
      browserFallback: browserFallback || undefined,
    },
  };
}

async function setBrowserFallbackPath(ctx: ExtensionContext, params: ConfigureBrowserParams): Promise<ToolOutput> {
  const path = params.browserPath?.trim();
  if (!path) {
    return {
      content: [
        {
          type: "text",
          text: [
            "# Browser path is required",
            "",
            "Provide the full path to a Chromium-family browser binary, such as:",
            "- /usr/bin/brave-browser-stable",
            "- /usr/bin/google-chrome",
            "- /usr/bin/chromium",
          ].join("\n"),
        },
      ],
      details: { configured: false, missing: true },
    };
  }

  await run("mkdir", ["-p", `${getHomeDir()}/.pi/agent`]);
  await run("bash", ["-lc", `printf '%s' ${JSON.stringify(path)} > ${JSON.stringify(BROWSER_FALLBACK_CONFIG_PATH)}`]);

  if (ctx.hasUI) {
    ctx.ui.notify(`Browser fallback path saved: ${path}`, "info");
  }

  return {
    content: [
      {
        type: "text",
        text: [
          "# Browser path configured",
          "",
          `Path: ${path}`,
          `Stored at: ${BROWSER_FALLBACK_CONFIG_PATH}`,
          "",
          "The extension will use this browser as the fallback when Lightpanda fails.",
        ].join("\n"),
      },
    ],
    details: { configured: true, browserPath: path, configPath: BROWSER_FALLBACK_CONFIG_PATH },
  };
}

async function runBrowserCdpFallback(url: string, toolName: string): Promise<ToolOutput | undefined> {
  const browserBinary = await resolveBrowserFallbackBinary();
  if (!browserBinary) {
    return undefined;
  }

  const port = BROWSER_FALLBACK_PORT;
  const profileDir = `${getHomeDir()}/.pi/agent/tmp/browser-cdp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await run("mkdir", ["-p", profileDir]);

  const browserProcess = spawnDetached(browserBinary, [
    "--headless",
    "--window-size=1280,720",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-background-networking",
    "--disable-extensions",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ]);

  try {
    const versionInfo = await (async () => {
      const deadline = Date.now() + 5000; // Reduced timeout
      while (Date.now() < deadline) {
        try {
          return await httpGetJson(`http://127.0.0.1:${port}/json/version`);
        } catch {
          await sleep(250);
        }
      }
      throw new Error(`Timed out waiting for browser CDP on port ${port}. Browser may not support headless mode.`);
    })();

    const wsUrl = versionInfo.webSocketDebuggerUrl;
    if (typeof wsUrl !== "string" || !wsUrl) {
      throw new Error("Browser CDP endpoint did not expose a websocket URL.");
    }

    const cdp = createCdpSocket(wsUrl);
    try {
      const target = await cdp.call("Target.createTarget", { url: "about:blank" });
      const targetId = String(target.targetId ?? "");
      if (!targetId) {
        throw new Error("Browser CDP target could not be created.");
      }

      const attach = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = String(attach.sessionId ?? "");
      if (!sessionId) {
        throw new Error("Browser CDP target could not be attached.");
      }

      await cdp.callSession(sessionId, "Page.enable");
      await cdp.callSession(sessionId, "Runtime.enable");

      const loadEvent = cdp.waitForSessionEvent(sessionId, "Page.loadEventFired", 20000).catch(() => undefined);
      await cdp.callSession(sessionId, "Page.navigate", { url });
      await loadEvent;
      await sleep(2000);

      const extracted = await cdp.callSession(sessionId, "Runtime.evaluate", {
        expression:
          "document.body ? document.body.innerText : (document.documentElement ? document.documentElement.innerText : '')",
        returnByValue: true,
      });

      let text = String((extracted.result as { value?: unknown } | undefined)?.value ?? "").trim();
      if (!text) {
        const htmlResult = await cdp.callSession(sessionId, "Runtime.evaluate", {
          expression:
            "document.documentElement ? document.documentElement.outerHTML : (document.body ? document.body.innerHTML : '')",
          returnByValue: true,
        });
        const html = String((htmlResult.result as { value?: unknown } | undefined)?.value ?? "").trim();
        text = htmlToMarkdown(html);
      }

      if (!text || isBlockedOrChallenge(text)) {
        return {
          content: [
            {
              type: "text",
              text: [
                `# ${toolName} browser fallback failed`,
                "",
                `URL: ${url}`,
                `Browser: ${browserBinary}`,
                "Reason: browser still returned a protection page or empty content.",
              ].join("\n"),
            },
          ],
          details: {
            url,
            browserBinary,
            rendered: false,
            fallback: "browser-cdp",
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `# ${toolName === "web-search" ? "Search results" : "Page content"}`,
              "",
              `URL: ${url}`,
              `Browser: ${browserBinary}`,
              "",
              text,
            ].join("\n"),
          },
        ],
        details: {
          url,
          browserBinary,
          rendered: true,
          fallback: "browser-cdp",
        },
      };
    } finally {
      cdp.close();
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: [
            `# ${toolName} browser fallback failed`,
            "",
            `URL: ${url}`,
            `Browser: ${browserBinary}`,
            `Reason: ${error instanceof Error ? error.message : String(error)}`,
          ].join("\n"),
        },
      ],
      details: {
        url,
        browserBinary,
        rendered: false,
        fallback: "browser-cdp",
      },
    };
  } finally {
    try {
      browserProcess.child.kill("SIGTERM");
    } catch {
      // ignore cleanup errors
    }
  }
}

async function runPlaywrightFallback(ctx: ExtensionContext, url: string, toolName: string): Promise<ToolOutput | undefined> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    if (isMissingModuleError(error, "playwright")) {
      const reason = "Playwright is not available in the installed extension runtime.";
      if (!playwrightWarned && ctx.hasUI) {
        playwrightWarned = true;
        ctx.ui.notify(reason, "warning");
      }
      return makeMissingPlaywrightResult(toolName, url, reason);
    }
    const reason = error instanceof Error ? error.message : String(error);
    return makeMissingPlaywrightResult(toolName, url, reason);
  }

  const browserBinaries = await resolveBrowserFallbackBinaries();
  let lastError: string | undefined;

  // First try system browsers if any found
  for (const browserBinary of browserBinaries) {
    const profileDir = `${getHomeDir()}/.pi/agent/tmp/browser-playwright-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await run("mkdir", ["-p", profileDir]);

    let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
    try {
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

      launchOptions.executablePath = browserBinary;

      context = await chromium.launchPersistentContext(profileDir, launchOptions);
      const page = context.pages()[0] ?? (await context.newPage());

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      await sleep(1500);

      let text = "";
      try {
        text = (await page.locator("body").innerText({ timeout: 5000 })).trim();
      } catch {
        text = "";
      }

      if (!text) {
        text = htmlToMarkdown(await page.content());
      }

      if (!text || isBlockedOrChallenge(text)) {
        lastError = `Browser ${browserBinary || "playwright-managed-chromium"} returned a protection page or empty content.`;
        await context.close().catch(() => undefined);
        continue;
      }

      await context.close().catch(() => undefined);
      return {
        content: [
          {
            type: "text",
            text: [
              `# ${toolName === "web-search" ? "Search results" : "Page content"}`,
              "",
              `URL: ${url}`,
              `Browser: ${browserBinary || "playwright-managed-chromium"}`,
              "",
              text,
            ].join("\n"),
          },
        ],
        details: {
          url,
          browserBinary: browserBinary || "playwright-managed-chromium",
          rendered: true,
          fallback: "playwright",
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await context?.close().catch(() => undefined);
      continue;
    }
  }

  if (lastError) {
    return {
      content: [
        {
          type: "text",
          text: [
            `# ${toolName} playwright fallback failed`,
            "",
            `URL: ${url}`,
            `Reason: ${lastError}`,
          ].join("\n"),
        },
      ],
      details: {
        url,
        rendered: false,
        fallback: "playwright",
        error: lastError,
      },
    };
  }

  return undefined;
}

async function fetchWithFallback(toolName: string, url: string, ctx: ExtensionContext): Promise<ToolOutput> {
  const lightpandaBinary = getLightpandaBinary();
  const lightpandaAvailable = await isLightpandaAvailable(lightpandaBinary);
  if (!lightpandaAvailable) {
    const browserFallbackBinary = await resolveBrowserFallbackBinary();
    return makeMissingBackendResult(lightpandaBinary, toolName, browserFallbackBinary);
  }

  try {
    const result = await fetchMarkdown(lightpandaBinary, url);
    const body = result.stdout.trim();
    const stderr = result.stderr.trim();

    if (body && !isBlockedOrChallenge(body)) {
      return {
        content: [{ type: "text", text: [`# ${toolName === "web-search" ? "Search results" : "Page content"}`, "", `Source: ${url}`, "", body].join("\n") }],
        details: {
          binary: lightpandaBinary,
          url,
          stderr: stderr || undefined,
          available: true,
          rendered: true,
          backend: "lightpanda",
        },
      };
    }

    const browserFallback = await runBrowserCdpFallback(url, toolName);
    if (browserFallback?.details && (browserFallback.details as { rendered?: boolean }).rendered === true) {
      return browserFallback;
    }

    // Skip Playwright if not available
    let playwrightFallback: ToolOutput | undefined;
    try {
      playwrightFallback = await runPlaywrightFallback(ctx, url, toolName);
    } catch {
      // Playwright not available
    }
    if (playwrightFallback?.details && (playwrightFallback.details as { rendered?: boolean }).rendered === true) {
      return playwrightFallback;
    }

    // If all fallbacks failed, return helpful error with browser path suggestion
    const configuredPath = readBrowserFallbackPath();
    const failureText = body || stderr || "Lightpanda returned no renderable content.";
    const errorResult = playwrightFallback ?? browserFallback ?? makeFetchFailureResult(toolName, url, failureText, lightpandaBinary, "lightpanda");
    
    // Add browser path suggestion to error
    if (!configuredPath) {
      (errorResult.content[0].text as string) += "\n\n**No browser fallback configured.**\nUse: `set-browser-fallback --browserPath /usr/bin/brave-browser-stable`";
    }
    
    return errorResult;
  } catch (error) {
    const browserFallback = await runBrowserCdpFallback(url, toolName);
    if (browserFallback?.details && (browserFallback.details as { rendered?: boolean }).rendered === true) {
      return browserFallback;
    }

    const playwrightFallback = await runPlaywrightFallback(ctx, url, toolName);
    if (playwrightFallback?.details && (playwrightFallback.details as { rendered?: boolean }).rendered === true) {
      return playwrightFallback;
    }

    return playwrightFallback ?? browserFallback ?? makeFetchFailureResult(toolName, url, error, lightpandaBinary, "lightpanda");
  }
}

export default function registerWebSearchTool(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const binary = getLightpandaBinary();
    await warnIfMissingBackend(ctx, binary);
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
    parameters: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Re-download and replace an existing installation.",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: InstallParams, _signal, _onUpdate, ctx): Promise<ToolOutput> {
      return installLightpanda(ctx, { force: params.force === true });
    },
  });

  pi.registerTool({
    name: "install-playwright",
    label: "Install Playwright",
    description: "Install or repair Playwright in the web-search package runtime and download the Chromium browser used by the final fallback.",
    promptSnippet: "Use install-playwright when the final fallback is missing or the runtime cannot import Playwright.",
    promptGuidelines: [
      "Call this tool when Playwright is missing from the installed package runtime.",
      "If installation is not supported on the current machine, explain the manual setup path instead.",
    ],
    parameters: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Reinstall Playwright and redownload the browser runtime.",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: InstallParams, _signal, _onUpdate, ctx): Promise<ToolOutput> {
      return installPlaywrightRuntime(ctx, { force: params.force === true });
    },
  });

  pi.registerTool({
    name: "set-browser-fallback",
    label: "Set Browser Fallback",
    description: "Save the path to a Chromium-family browser binary used for the final fallback CDP browser.",
    promptSnippet: "Use set-browser-fallback when auto-detection cannot find a usable browser binary.",
    promptGuidelines: [
      "Ask the user for an explicit browser binary path only when automatic detection fails.",
      "Store the path and reuse it for future fallback browser sessions.",
    ],
    parameters: {
      type: "object",
      properties: {
        browserPath: {
          type: "string",
          minLength: 1,
          description: "Full path to a Chromium-family browser binary.",
        },
      },
      required: ["browserPath"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: ConfigureBrowserParams, _signal, _onUpdate, ctx): Promise<ToolOutput> {
      return setBrowserFallbackPath(ctx, params);
    },
  });

  pi.registerTool({
    name: "web-search",
    label: "Web Search",
    description: "Search the web with Lightpanda and return the rendered search results page as markdown.",
    promptSnippet: "Use web-search when you need current or source-backed web results.",
    promptGuidelines: [
      "Prefer precise queries, then refine using site: or quoted phrases if the first pass is noisy.",
      "Treat the result as a browser-rendered page dump; inspect linked sources before answering definitively.",
      "If Lightpanda is missing, call install-lightpanda first or explain the manual install path.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Search terms to send to the browser-backed search page.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: SearchParams, _signal, _onUpdate, ctx): Promise<ToolOutput> {
      const query = params.query.trim();
      if (!query) {
        throw new Error("Query is required.");
      }

      return fetchWithFallback("web-search", getSearchUrl(query), ctx);
    },
  });

  pi.registerTool({
    name: "open-url",
    label: "Open URL",
    description: "Open a specific URL with Lightpanda and return the rendered page as markdown.",
    promptSnippet: "Use open-url when you already know the page URL and want to inspect it directly.",
    promptGuidelines: [
      "Prefer open-url after search when the user has a specific page in mind.",
      "If Lightpanda cannot render the page, the tool will try a final browser/CDP fallback before failing.",
    ],
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 1,
          description: "A direct http or https URL to open.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: OpenUrlParams, _signal, _onUpdate, ctx): Promise<ToolOutput> {
      return fetchWithFallback("open-url", normalizeUrl(params.url), ctx);
    },
  });
}
