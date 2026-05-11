# State-of-the-Art Website Scraper

## Quickstart

```bash
bun install
bunx playwright install
bun run build
bun run start
```

You’ll be prompted for a URL, whether to scrape subpages, and snapshot mode. Output is written to `./scraped_sites/scrape-<domain>-<timestamp>/`.

By default pages are saved with references to local assets (`--no-single-file`) for a smaller footprint. In this mode, runtime scripts are removed to keep snapshots stable/editable, and large inline `<style>` blocks are automatically extracted into `assets/css/inline/` to keep HTML AI-friendly without changing visual output. Use `--single-file` to inline CSS/images/fonts into each HTML file.

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
- Auto-generated `design.md` in `<page-dir>/data/` following the [google-labs-code/design.md](https://github.com/google-labs-code/design.md) spec (YAML front matter with `colors`, `typography`, `rounded`, `spacing` tokens + canonical markdown sections)
- Compact agent index in `agent/context.json` + `agent/context.md` for faster agent onboarding
- LLM-friendly output by default (large inline style blocks are extracted to `assets/css/inline/*.css`)

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

## Agent-Optimized Workflow

The scraper now applies LLM-friendly defaults automatically:

- In `--no-single-file` mode, stylesheet files stay external (smaller editable HTML + direct CSS targets).
- Large inline `<style>` blocks are extracted into `assets/css/inline/` (default threshold: 32 KB).
- `agent/context.json` + `agent/context.md` are always generated.
- CD summary files are generated with lightweight extraction (no expensive computed-style pass).

For redesign-focused runs:

```bash
bun run start --url https://example.com --subpages
```

Then start from `agent/context.md` / `agent/context.json`.

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
