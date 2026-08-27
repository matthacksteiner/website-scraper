# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

A state-of-the-art website scraper. It renders pages with Playwright, saves an
offline snapshot (assets linked by default, or fully inlined single-file), and
generates AI-friendly artifacts (`design.md`, `wording.md`, `agent/context.*`).
After each scrape it verifies the snapshot and writes a `verify-report.*`.

## Setup & commands

The runtime is **Bun**. TypeScript in `src/` compiles to `dist/`, and the run
scripts execute the compiled JS — **always `bun run build` before running a CLI**.

```bash
bun install
bunx playwright install   # required once, downloads chromium
bun run build             # tsc → dist/
bun run start             # interactive scrape (prompts for URL etc.)
```

| Command                            | Purpose                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bun run build`                    | Compile `src/` → `dist/` (run before any CLI).                                                                   |
| `bun run start`                    | Scrape a site (see `src/cli.ts`). Auto-verifies unless `--no-verify`; writes `wording.md` unless `--no-wording`. |
| `bun run serve` / `serve:latest`   | Serve a scrape over HTTP (manifest URL-mapping).                                                                 |
| `bun run verify` / `verify:latest` | Verify a scrape snapshot standalone.                                                                             |
| `bun run postprocess`              | Re-inline / convert an existing scrape.                                                                          |
| `bun test`                         | Run the `bun:test` suite in `tests/`.                                                                            |
| `bun run typecheck`                | `tsc --noEmit`.                                                                                                  |
| `bun run lint` / `lint:fix`        | ESLint over `src/`.                                                                                              |
| `bun run format` / `format:check`  | Prettier.                                                                                                        |

Before claiming a change works, run `typecheck`, `lint`, `test`, `build` — and for
runtime behavior, exercise the actual CLI against a real scrape (see below).

## Module map (`src/`)

- `cli.ts` — `bun run start` entry: prompts/flags → `Scraper.run()` → verify.
- `scraper.ts` — `Scraper` orchestration: crawl, capture, rewrite, save, artifacts.
- `crawler.ts` — concurrency-limited crawl queue (`p-limit`).
- `playwright_capture.ts` — headless render + lazy-load/consent handling + computed-style snapshot.
- `fetch_capture.ts` — fetch-only fallback + extra asset discovery from HTML.
- `rewrite.ts` — HTML/CSS rewriting, asset inlining, consent-artifact stripping.
- `storage.ts` — `Storage`: page/asset paths, manifest, event log.
- `serve.ts` — static HTTP preview server with manifest URL-mapping.
- `verify.ts` — snapshot verification (static server + Playwright) + report rendering.
- `verify_cli.ts` — `bun run verify` entry.
- `scrape_dirs.ts` — shared `resolveLatestScrapeDir` (used by serve + verify).
- `design_md.ts`, `mini_cd.ts` — design-token extraction → `design.md`.
- `wording.ts` — copy extraction (CTAs, H1–H3, nav, forms, meta) + salutation → `wording.md`.
- `agent_context.ts` — `agent/context.{json,md}`.
- `types.ts` — shared interfaces.
- `options.ts`, `url.ts`, `robots.ts`, `ai_friendly.ts` — helpers.

## Verification (`verify.ts`)

Loads every manifest page with a **plain static server** (mirrors `npx
http-server`, no manifest mapping — the strict/honest view the user sees) and
classifies findings by origin:

- **Local** failed requests (to our server, `4xx/5xx`) = actionable missing assets.
- **External** requests + console errors + JS exceptions = informative runtime noise
  (snapshots keep app scripts, which re-run without a backend).

Best-effort: never fails the scrape, exit code stays `0`. Writes
`verify-report.{json,md}` to the scrape root. Pure functions
(`splitRequestIssues`, `buildVerifyReport`, `renderVerifyMarkdown`,
`renderVerifySummary`, `classifyRequestOrigin`) are unit-tested; the
Playwright/server layer is kept thin.

## Wording (`wording.ts`)

Writes `wording.md` to the scrape root — deliberately **not** into `design.md`,
which follows the google-labs-code spec and is linted.

Two collection paths, one shared pure pipeline:

- **Playwright** — `collectWordingSnapshot()` in `playwright_capture.ts`, a single
  `page.evaluate` that resolves visibility (`getComputedStyle` up the whole
  ancestor chain) and accessible names. It runs **directly after
  `page.content()`, before `collectComputedSnapshot()`** — that function resizes
  the viewport six times, and responsive JS can rewrite the DOM in between.
  Moving the call breaks the guarantee that `wording.md` and the saved HTML
  describe the same document.
- **Fetch fallback** — `extractWordingFromHtml()` (cheerio) when Playwright can't
  launch. Sees no CSS, so it only catches attribute- and inline-style-based
  hiding; `collectionMode` in the document records which path ran.

Everything else — cleaning, dedup, salutation, markdown — is pure and unit-tested
(`tests/wording.test.ts`). The salutation is a marker heuristic, weighted
(`Ihnen`/`Ihre` strong, `Sie`/`Ihr` weak, threshold 2) so a single ambiguous
sentence-initial `Sie` doesn't decide it. Mixed usage prints both counters.

Wording is collected **before** `rewriteHtml()`, so CTA targets are the live URLs,
not local snapshot paths. `writeWordingFile()` swallows its own errors
(`phase: 'wording'`) and returns `null`; the agent context links `wording.md` only
when that returned a filename — hence the two post-tasks run sequentially.

## Conventions

- Indentation: **2 spaces** (`.editorconfig`), single quotes, semicolons,
  trailing commas, `printWidth: 90` (Prettier). Match surrounding code.
- Prefer plain functions for new modules; avoid new classes/factories/patterns.
  (`Scraper`/`Storage` are pre-existing classes — extend them in place.)
- Don't abstract until a pattern is clearly shared; duplication is fine.
- CommonJS + `esModuleInterop`; default-import CJS deps (`import pLimit from 'p-limit'`).
- Tests: `bun:test` (`describe/it/expect`). Favor pure, browser-free unit tests.
- Only format files you changed — some existing files predate current Prettier config.

## Gotchas

- `scraped_sites/` is git-ignored (generated). `dist/` too. Never commit them.
- **`bun`'s `http.Server.close(cb)` does not reliably fire its callback** once
  sockets are torn down (node does). `verify.ts` destroys tracked sockets and
  resolves via `setImmediate` so cleanup never hangs — keep that pattern for any
  in-process server.
- Snapshots are **not** script-free: only consent/cookie scripts are stripped.
  App JS is kept and re-runs on load, so console errors are expected — that's why
  verify separates local (actionable) from runtime (informative).
- Design specs live in `docs/superpowers/specs/`.
