import { chromium, BrowserContext } from "playwright";
import { promises as fs } from "fs";
import path from "path";
import { load } from "cheerio";
import { ScrapeOptions } from "./types";
import { createScopeFilter, isHttpUrl, normalizeUrl } from "./url";
import { Storage } from "./storage";
import { RobotsClient } from "./robots";
import { inlineHtmlAssets, rewriteHtml } from "./rewrite";
import { capturePage, CapturedPage } from "./playwright_capture";
import { Crawler, CrawlItem } from "./crawler";
import { capturePageFetch } from "./fetch_capture";

class RateLimiter {
  private last = 0;
  private gate: Promise<void> = Promise.resolve();

  constructor(private delayMs: number) {}

  async wait(): Promise<void> {
    if (this.delayMs <= 0) return;
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.gate;
    this.gate = next;
    await previous;

    const now = Date.now();
    const waitFor = Math.max(0, this.last + this.delayMs - now);
    this.last = now + waitFor;
    if (waitFor > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitFor));
    }
    release();
  }
}

const extractLinks = (html: string, baseUrl: string): string[] => {
  const $ = load(html);
  const links = new Set<string>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
      return;
    }
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (isHttpUrl(absolute)) {
        links.add(absolute);
      }
    } catch {
      return;
    }
  });

  return Array.from(links);
};

export class Scraper {
  private storage: Storage;
  private robots: RobotsClient | null;
  private scopeFilter: (url: string) => boolean;
  private rateLimiter: RateLimiter;
  private crawler: Crawler;
  private processedPages = 0;
  private progressTarget: number;
  private useFetchFallback = false;

  constructor(private options: ScrapeOptions) {
    this.storage = new Storage(options.output, options);
    this.robots = options.respectRobots ? new RobotsClient() : null;
    this.scopeFilter = createScopeFilter(options.url, options.scope, options.include, options.exclude);
    this.rateLimiter = new RateLimiter(options.delayMs);
    this.crawler = new Crawler({ concurrency: options.concurrency, maxPages: options.maxPages });
    this.progressTarget = options.subpages ? options.maxPages : 1;
  }

  async run(): Promise<void> {
    await this.storage.init();

    this.crawler.enqueue(this.options.url, 0);
    this.storage.registerPageMapping(this.options.url);

    let browser;
    try {
      browser = await chromium.launch();
    } catch (error) {
      const fallback = await this.findPlaywrightExecutable();
      if (fallback) {
        console.warn(`Playwright browser not found. Using fallback executable: ${fallback}`);
        browser = await chromium.launch({ executablePath: fallback });
      } else {
        console.warn("Playwright browser not found. Falling back to system Chrome.");
        browser = await chromium.launch({ channel: "chrome" });
      }
    }
    const context = await browser.newContext({
      userAgent: this.options.userAgent,
    });

    await this.crawler.run((item) => this.processPage(context, item));
    await context.close();
    await browser.close();
    await this.storage.finalize();
    this.renderProgress(true);
  }

  private async processPage(context: BrowserContext, item: CrawlItem): Promise<void> {
    if (item.depth > 0 && !this.scopeFilter(item.url)) return;
    if (item.depth > this.options.maxDepth) return;

    if (this.robots) {
      const allowed = await this.robots.canFetch(item.url, this.options.userAgent);
      if (!allowed) {
        this.storage.recordError({
          url: item.url,
          error: "Blocked by robots.txt",
          phase: "robots",
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    await this.rateLimiter.wait();
    await this.storage.logEvent({ type: "page-start", url: item.url, depth: item.depth });

    let captured: CapturedPage | null = null;
    try {
      captured = await capturePage(context, item.url, { timeoutMs: this.options.timeoutMs });
    } catch (error) {
      this.storage.recordError({
        url: item.url,
        error: (error as Error).message,
        phase: "navigation",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!captured) return;

    const pagePath = this.storage.registerPageMapping(item.url);

    const responseMap = new Map<string, { contentType: string | null; body: Buffer }>();
    for (const response of captured.responses) {
      responseMap.set(normalizeUrl(response.url), {
        contentType: response.contentType,
        body: response.body,
      });
    }

    for (const response of captured.responses) {
      const kind = this.getAssetKind(response.url, response.contentType);
      if (!kind) continue;
      try {
        const asset = await this.storage.saveAsset(response.url, response.body, response.contentType, kind);
        await this.storage.logEvent({ type: "asset-saved", url: response.url, path: asset.path });
      } catch (error) {
        this.storage.recordError({
          url: response.url,
          error: (error as Error).message,
          phase: "asset-save",
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (this.options.subpages) {
      const links = extractLinks(captured.html, item.url);
      for (const link of links) {
        if (!this.scopeFilter(link)) {
          continue;
        }
        const nextDepth = item.depth + 1;
        if (nextDepth > this.options.maxDepth) {
          continue;
        }
        const added = this.crawler.enqueue(link, nextDepth);
        if (added) {
          this.storage.registerPageMapping(normalizeUrl(link));
        }
      }
    }

    let rewrittenHtml = rewriteHtml(captured.html, item.url, pagePath, this.storage.resourceMap);
    rewrittenHtml = inlineHtmlAssets(
      rewrittenHtml,
      item.url,
      pagePath,
      responseMap,
      this.storage.resourceMap
    );

    await this.storage.savePage(
      {
        url: item.url,
        path: pagePath,
        depth: item.depth,
        status: captured.status,
        contentType: captured.contentType,
        timestamp: new Date().toISOString(),
      },
      rewrittenHtml
    );

    this.processedPages += 1;
    this.renderProgress();

    await this.storage.logEvent({ type: "page-finished", url: item.url, depth: item.depth });
  }

  private renderProgress(done = false): void {
    const total = this.progressTarget;
    const current = Math.min(this.processedPages, total);
    const message = `Progress: ${current}/${total} pages`;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${message}${done ? "\n" : ""}`);
    } else if (done) {
      console.log(message);
    }
  }

  private getAssetKind(url: string, contentType: string | null): "img" | "css" | null {
    if (contentType) {
      if (contentType.startsWith("image/")) return "img";
      if (contentType.includes("text/css")) return "css";
    }
    const lower = url.split("?")[0].toLowerCase();
    if (lower.endsWith(".css")) return "css";
    if (lower.match(/\.(png|jpe?g|gif|webp|svg|avif|ico)$/)) return "img";
    return null;
  }

  private async findPlaywrightExecutable(): Promise<string | null> {
    const cacheDir = path.join(process.env.HOME || "", "Library", "Caches", "ms-playwright");
    const candidates = [
      path.join(cacheDir, "chromium_headless_shell-1208", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
      path.join(cacheDir, "chromium_headless_shell-1208", "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
      path.join(cacheDir, "chromium-1208", "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(cacheDir, "chromium-1208", "chrome-mac-x64", "Chromium.app", "Contents", "MacOS", "Chromium"),
    ];

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }

    return null;
  }
}
