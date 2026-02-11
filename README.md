# State-of-the-Art Website Scraper

## Quickstart

```bash
npm install
npx playwright install
npm run build
node dist/cli.js
```

You’ll be prompted for a URL and whether to scrape subpages. Output is written to `./scraped_sites/scrape-<domain>-<timestamp>/`.

By default pages are saved as **single-file static snapshots** (CSS/images/fonts inlined when captured; executing scripts removed) so you can open `index.html` directly in Chrome without `file://` CORS issues. Interactive widgets (carousels, consent banners, analytics) are not preserved.

## Preview (recommended for `--no-single-file`)

When using `--no-single-file`, Chrome blocks many asset loads when opening pages via `file://` (you’ll see CORS errors in the console). Serve the scrape directory over HTTP instead:

```bash
npm run build
node dist/serve.js --dir scraped_sites/scrape-<domain>-<timestamp>
```

Then open the printed `http://127.0.0.1:4173/` URL in your browser.

## Features
- Headless browser rendering (Playwright)
- Single-file static snapshots (inline CSS/images/fonts, strip consent overlays)
- Optional subpage crawling with scope controls
- `robots.txt` compliance and rate limiting
- Crawl limits for safety
- Manifest and JSONL event log

## Usage

```bash
node dist/cli.js --url https://example.com --subpages --scope same-origin
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
- `--single-file` / `--no-single-file` (default: single-file)
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
    pages/<path>/index.html
    assets/
      img/
      css/
    scrape-manifest.json
    scrape-log.jsonl
```

Each page is saved as a single HTML file with inlined CSS/images/fonts when captured. Assets are also downloaded to `assets/` (`assets/img`, `assets/css`, etc).

## Notes
- In single-file mode, assets are still saved to `assets/` (helps debugging and enables re-postprocessing).
- If some assets can’t be captured, they remain as absolute `https://...` URLs (page may need network to fully match the live site).
- Some pages may block scraping or require authentication.
