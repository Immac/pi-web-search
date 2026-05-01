---
name: web-search
description: Browser-backed web search using the web-search tool and Lightpanda. Use when you need current facts, source-backed results, or a quick search/refinement loop.
---

# Web Search

## What this skill does

Use the `web-search` tool to search the web through the Lightpanda browser backend and inspect the rendered results page as markdown. Use `open-url` when you already know the page URL and want to inspect it directly. If Lightpanda fails, the extension will try a real browser fallback when available.

## When to use

- Current or rapidly changing facts
- Documentation lookup
- Source-backed verification
- Refining a query after noisy results

## Workflow

1. Start with a precise query.
2. Call `web-search` with the query.
3. Read the returned markdown results page.
4. If the results are noisy, narrow the query with quoted phrases or `site:` filters.
5. Prefer checking linked sources before answering with high confidence.
6. Use `open-url` when the user has a known target page.
7. If the tool reports that Lightpanda is missing, call `install-lightpanda` or explain the manual setup options before continuing.

## Backend

This skill expects Lightpanda to be available as a browser backend.

- Default binary: `lightpanda`
- Override with `LIGHTPANDA_BIN`
- Override the search page template with `WEBSEARCH_URL_TEMPLATE`

Default search template:

```text
https://html.duckduckgo.com/html/?q={query}
```

## Notes

The tool returns the browser-rendered search page, not a curated answer. Use it as a research step, then synthesize the result.
