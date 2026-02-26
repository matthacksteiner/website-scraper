# State-of-the-Art Website Scraper

## Quickstart

```bash
bun install
bunx playwright install
bun run build
bun run start
```

You’ll be prompted for a URL, whether to scrape subpages, and snapshot mode. Output is written to `./scraped_sites/scrape-<domain>-<timestamp>/`.

By default pages are saved with references to local assets (`--no-single-file`) for a smaller footprint. In this mode, runtime scripts are removed to keep snapshots stable/editable. Use `--single-file` to inline CSS/images/fonts into each HTML file.

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

## Output

```
scraped_sites/
  scrape-<domain>-<timestamp>/
    pages/
      assets/
        img/
        css/
      index.html
      <subpage>/
        assets/
          img/
          css/
        index.html
    scrape-manifest.json
    scrape-log.jsonl
```

Pages are saved under the `pages/` directory, with each page having its own `assets/` folder containing only the assets used by that page. The root page is at `pages/index.html` with assets in `pages/assets/`, and subpages are at `pages/<subpage>/index.html` with assets in `pages/<subpage>/assets/`. By default, HTML references local files in `assets/` (`assets/img`, `assets/css`, etc). In `--single-file` mode, CSS/images/fonts are inlined into each HTML page.

## Notes

- In single-file mode, assets are still saved to `assets/` (helps debugging and enables re-postprocessing).
- If some assets can’t be captured, they remain as absolute `https://...` URLs (page may need network to fully match the live site).
- Some pages may block scraping or require authentication.
