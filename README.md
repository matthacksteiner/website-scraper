# State-of-the-Art Website Scraper

## Quickstart

```bash
npm install
npx playwright install
npm run build
node dist/cli.js
```

You’ll be prompted for a URL and whether to scrape subpages. Output is written to `./scrape-<domain>-<timestamp>/`.

## Features
- Headless browser rendering (Playwright)
- Inline CSS and JS into each saved HTML page
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
- `--respect-robots` / `--no-respect-robots`
- `--delay-ms <number>` (default: 500)
- `--concurrency <number>` (default: 2)
- `--user-agent <string>`
- `--timeout-ms <number>` (default: 30000)

## Output
```
output/
  pages/<path>/index.html
  assets/
    img/
    css/
  scrape-manifest.json
  scrape-log.jsonl
```

Each page is saved as a single HTML file with inlined CSS and JS. Images are downloaded to `assets/img`, and CSS files are also saved to `assets/css`.

## Notes
- Images are not inlined. CSS and JS are embedded into HTML.
- Some pages may block scraping or require authentication.
