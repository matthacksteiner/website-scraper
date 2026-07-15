# State-of-the-Art Website Scraper

## Quickstart

```bash
bun install
bunx playwright install
bun run build
bun run start
```

You’ll be prompted for a URL, whether to scrape subpages, and snapshot mode. Output is written to `./scraped_sites/scrape-<domain>-<timestamp>/`.

By default pages are saved with references to local assets (`--no-single-file`) for a smaller footprint. Cookie/consent banners and their blocker scripts are stripped by default (`--strip-consent`); other page scripts are kept as captured. Large inline `<style>` blocks are automatically extracted into `assets/css/inline/` to keep HTML AI-friendly without changing visual output. Use `--single-file` to inline CSS/images/fonts into each HTML file.

After each scrape, a verification step loads every captured page and reports problems (see [Verification](#verification)).

## Preview (recommended for `--no-single-file`)

When using `--no-single-file`, Chrome blocks many asset loads when opening pages via `file://` (you’ll see CORS errors in the console). Serve the scrape directory over HTTP instead:

```bash
bun run build
bun run serve --dir scraped_sites/scrape-<domain>-<timestamp>
```

Then open the printed `http://127.0.0.1:4173/` URL in your browser. The server will automatically serve `pages/index.html` as the default page.

To serve the newest scrape output automatically:

```bash
bun run build
bun run serve:latest
```

This will find the most recent scrape directory and serve its root page at `http://127.0.0.1:4173/`.

## Verification

After every scrape, `bun run start` runs a verification pass: it serves the output with a plain static server (the same way `npx http-server` would) and loads every captured page in a headless browser, then writes a report to the scrape root.

Findings are split by origin so the actionable signal is not drowned out by runtime noise:

- **Actionable — missing local resources:** requests to the local server that return `4xx/5xx` (typically `404` on `assets/…`). These indicate assets the scrape failed to capture.
- **Informative:** requests to external hosts (absolute URLs still in the HTML), console errors and uncaught JS exceptions. Re-running a page's JavaScript without its backend is inherently noisy, so these are reported but not treated as scrape defects.

The step is best-effort and never fails the scrape (exit code stays `0`). Two files are written to the scrape root: `verify-report.json` (full detail) and `verify-report.md` (human-readable). A one-line summary is printed to the console.

Skip it with `--no-verify`. Verify an existing scrape directory on its own:

```bash
bun run build
bun run verify --dir scraped_sites/scrape-<domain>-<timestamp>
```

Or verify the most recent scrape output:

```bash
bun run verify:latest
```

## Quality Tooling

```bash
bun run lint
bun run format:check
bun run typecheck
```

Fix formatting automatically with:

```bash
bun run format
```

## Features

- Headless browser rendering (Playwright)
- Asset-linked snapshots by default, with optional single-file inlining
- Optional subpage crawling with scope controls
- `robots.txt` compliance and rate limiting
- Crawl limits for safety
- Manifest and JSONL event log
- Auto-generated `design.md` at the scrape root following the [google-labs-code/design.md](https://github.com/google-labs-code/design.md) spec (YAML front matter with `colors`, `typography`, `rounded`, `spacing` tokens + canonical markdown sections)
- Compact agent index in `agent/context.json` + `agent/context.md` for faster agent onboarding
- LLM-friendly output by default (large inline style blocks are extracted to `assets/css/inline/*.css`)
- Post-scrape verification that loads every page like a static server and reports missing local resources, external requests and console errors (`verify-report.md`)

## Usage

```bash
bun run start --url https://example.com --subpages --scope same-origin
```

### Options

- `--url <url>`
- `--subpages` / `--no-subpages`
- `--scope <same-origin|subdomains|custom>`
- `--include <glob>` (repeatable)
- `--exclude <glob>` (repeatable)
- `--max-pages <number>` (default: 50)
- `--max-depth <number>` (default: 2)
- `--output <dir>`
- `--single-file` / `--no-single-file` (default: no-single-file)
- `--strip-consent` / `--no-strip-consent` (default: strip)
- `--respect-robots` / `--no-respect-robots`
- `--delay-ms <number>` (default: 500)
- `--concurrency <number>` (default: 2)
- `--user-agent <string>`
- `--timeout-ms <number>` (default: 30000)
- `--verify` / `--no-verify` (default: verify)

## Agent-Optimized Workflow

The scraper now applies LLM-friendly defaults automatically:

- In `--no-single-file` mode, stylesheet files stay external (smaller editable HTML + direct CSS targets).
- Large inline `<style>` blocks are extracted into `assets/css/inline/` (default threshold: 32 KB).
- `agent/context.json` + `agent/context.md` are always generated.
- `design.md` is generated from rendered computed styles when Playwright is available, with CSS/HTML extraction as a fallback.

For redesign-focused runs:

```bash
bun run start --url https://example.com --subpages
```

Then start from `agent/context.md` / `agent/context.json`.
The first agent instruction points to the scrape-root `design.md`; read that file before editing HTML or CSS.

Validate a generated design contract with:

```bash
bun run design:lint scraped_sites/scrape-<domain>-<timestamp>/design.md
```

## Output

```
scraped_sites/
  scrape-<domain>-<timestamp>/
    pages/
      <page-dir>/
        assets/
          img/
          css/
            inline/
        index.html
    design.md
    scrape-manifest.json
    scrape-log.jsonl
    verify-report.json
    verify-report.md
    agent/
      context.json
      context.md
```

Pages are saved under the `pages/` directory, with each page having its own `assets/` folder containing only the assets used by that page. The root page is at `pages/index.html` with assets in `pages/assets/`, and subpages are at `pages/<subpage>/index.html` with assets in `pages/<subpage>/assets/`. By default, HTML references local files in `assets/` (`assets/img`, `assets/css`, etc), and large inline `<style>` blocks are moved into `assets/css/inline/`. In `--single-file` mode, CSS/images/fonts are inlined into each HTML page.

After each scrape, a `design.md` is written to the scrape root containing extracted color, typography, spacing, and rounded tokens in the [google-labs-code/design.md](https://github.com/google-labs-code/design.md) format.

## Notes

- In single-file mode, assets are still saved to `assets/` (helps debugging and enables re-postprocessing).
- AI-friendly inline-style extraction applies to newly generated scrapes; existing scrape folders are not modified automatically.
- If some assets can’t be captured, they remain as absolute `https://...` URLs (page may need network to fully match the live site).
- Some pages may block scraping or require authentication.
