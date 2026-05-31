import { describe, it, expect } from "vitest";

// ── Replicate pure helper functions from web-search.ts for testing ─────

function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = (hash & hash) >>> 0;
  }
  return hash.toString(16);
}

function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function safeStrArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is string => typeof x === "string");
}

function isMissingModuleError(error: unknown, moduleName: string): boolean {
  if (!(error instanceof Error)) return false;
  const haystack = `${error.message} ${(error as Error & { code?: string }).code ?? ""}`.toLowerCase();
  return (
    haystack.includes(`cannot find module '${moduleName}'`) ||
    haystack.includes(`cannot find module "${moduleName}"`) ||
    haystack.includes("module not found") ||
    haystack.includes("err_module_not_found")
  );
}

function isBlockedOrChallenge(text: string): boolean {
  const n = text.toLowerCase();
  return (
    n.includes("navigation failed") ||
    n.includes("performing security verification") ||
    n.includes("verification successful") ||
    n.includes("cloudflare") ||
    n.includes("bot verification") ||
    (n.includes("duckduckgo") && n.includes("select all squares containing a duck"))
  );
}

function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  return parsed.toString();
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

// ── Tests ──────────────────────────────────────────────────────────────

describe("simpleHash", () => {
  it("returns a stable hash for the same input", () => {
    expect(simpleHash("hello")).toBe(simpleHash("hello"));
  });

  it("returns different hashes for different inputs", () => {
    expect(simpleHash("hello")).not.toBe(simpleHash("world"));
  });

  it("handles empty string", () => {
    expect(simpleHash("")).toBe("1505");
  });

  it("returns a hex string", () => {
    expect(simpleHash("https://example.com")).toMatch(/^[0-9a-f]+$/);
  });

  it("handles long URLs without collision", () => {
    const a = simpleHash("https://example.com/this-is-a-very-long-url-path/with/many/segments?q=search+term&page=1");
    const b = simpleHash("https://example.com/other-path/with/different?q=stuff");
    expect(a).not.toBe(b);
  });
});

describe("safeStr", () => {
  it("passes strings through", () => {
    expect(safeStr("hello")).toBe("hello");
  });

  it("coerces numbers", () => {
    expect(safeStr(42)).toBe("42");
    expect(safeStr(0)).toBe("0");
  });

  it("coerces booleans", () => {
    expect(safeStr(true)).toBe("true");
    expect(safeStr(false)).toBe("false");
  });

  it("returns empty string for null", () => {
    expect(safeStr(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(safeStr(undefined)).toBe("");
  });

  it("returns empty string for objects", () => {
    expect(safeStr({})).toBe("");
  });

  it("returns empty string for arrays", () => {
    expect(safeStr([1, 2, 3])).toBe("");
  });
});

describe("safeStrArray", () => {
  it("filters to only strings", () => {
    expect(safeStrArray(["a", 1, "b", null, "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for non-array input", () => {
    expect(safeStrArray(null)).toEqual([]);
    expect(safeStrArray(undefined)).toEqual([]);
    expect(safeStrArray("string")).toEqual([]);
    expect(safeStrArray(42)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(safeStrArray([])).toEqual([]);
  });

  it("passes through string arrays unchanged", () => {
    expect(safeStrArray(["hello", "world"])).toEqual(["hello", "world"]);
  });
});

describe("isMissingModuleError", () => {
  it("detects ESM-style missing module error", () => {
    const err = new Error("Cannot find module 'playwright'");
    expect(isMissingModuleError(err, "playwright")).toBe(true);
  });

  it("detects ERR_MODULE_NOT_FOUND", () => {
    const err = new Error("Module not found: playwright");
    (err as Error & { code?: string }).code = "ERR_MODULE_NOT_FOUND";
    expect(isMissingModuleError(err, "playwright")).toBe(true);
  });

  it("returns false for non-Error values", () => {
    expect(isMissingModuleError("some string", "playwright")).toBe(false);
    expect(isMissingModuleError(null, "playwright")).toBe(false);
    expect(isMissingModuleError(undefined, "playwright")).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    const err = new Error("Something went wrong");
    expect(isMissingModuleError(err, "playwright")).toBe(false);
  });

  it("detects module not found in message", () => {
    const err = new Error("module not found: some-module");
    expect(isMissingModuleError(err, "some-module")).toBe(true);
  });
});

describe("isBlockedOrChallenge", () => {
  it("detects navigation failed", () => {
    expect(isBlockedOrChallenge("Navigation failed: timeout")).toBe(true);
  });

  it("detects cloudflare challenge", () => {
    expect(isBlockedOrChallenge("Please complete the Cloudflare security check")).toBe(true);
  });

  it("detects bot verification page", () => {
    expect(isBlockedOrChallenge("Bot verification detected")).toBe(true);
  });

  it("detects duckduckgo challenge", () => {
    expect(isBlockedOrChallenge("DuckDuckGo select all squares containing a duck")).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(isBlockedOrChallenge("Here are the search results for cats")).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(isBlockedOrChallenge("")).toBe(false);
  });

  it("detects performing security verification", () => {
    expect(isBlockedOrChallenge("Performing security verification, please wait...")).toBe(true);
  });

  it("detects verification successful", () => {
    expect(isBlockedOrChallenge("Verification successful, redirecting...")).toBe(true);
  });
});

describe("normalizeUrl", () => {
  it("normalizes a valid URL", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("trims whitespace", () => {
    expect(normalizeUrl("  https://example.com  ")).toBe("https://example.com/");
  });

  it("rejects ftp protocol", () => {
    expect(() => normalizeUrl("ftp://example.com")).toThrow("Only http and https URLs");
  });

  it("rejects file protocol", () => {
    expect(() => normalizeUrl("file:///tmp/test")).toThrow("Only http and https URLs");
  });

  it("preserves path and query", () => {
    expect(normalizeUrl("https://example.com/path?q=hello")).toBe("https://example.com/path?q=hello");
  });

  it("rejects empty string", () => {
    expect(() => normalizeUrl("")).toThrow();
  });
});

describe("htmlToMarkdown", () => {
  it("strips script tags", () => {
    const result = htmlToMarkdown("<p>Hello</p><script>alert('xss')</script><p>World</p>");
    expect(result).not.toContain("alert");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });

  it("strips style tags", () => {
    const result = htmlToMarkdown("<style>body { color: red; }</style><p>Content</p>");
    expect(result).not.toContain("color");
    expect(result).toContain("Content");
  });

  it("converts <br> to newlines", () => {
    expect(htmlToMarkdown("Line1<br>Line2")).toBe("Line1\nLine2");
  });

  it("replaces block elements with newlines", () => {
    const result = htmlToMarkdown("<p>First</p><p>Second</p>");
    expect(result).toContain("First");
    expect(result).toContain("Second");
  });

  it("converts list items with dashes", () => {
    const result = htmlToMarkdown("<ul><li>Item 1</li><li>Item 2</li></ul>");
    expect(result).toContain("- Item 1");
    expect(result).toContain("- Item 2");
  });

  it("decodes HTML entities", () => {
    const result = htmlToMarkdown("<p>AT&amp;T &lt;test&gt; &quot;quote&quot;</p>");
    expect(result).toContain("AT&T");
    expect(result).toContain("<test>");
    expect(result).toContain('"quote"');
  });

  it("handles empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  it("handles input with only tags", () => {
    expect(htmlToMarkdown("<script>code</script><style>css</style>")).toBe("");
  });
});
