import { chromium, BrowserContext } from 'playwright';
import { load } from 'cheerio';
import { promises as fs, statSync } from 'fs';
import path from 'path';
import { ScrapeOptions } from './types';
import { createScopeFilter, isHttpUrl, normalizeUrl } from './url';
import { Storage } from './storage';
import { RobotsClient } from './robots';
import { inlineHtmlAssets, rewriteCss, rewriteHtml } from './rewrite';
import { capturePage, CapturedPage } from './playwright_capture';
import { Crawler, CrawlItem } from './crawler';
import { captureAssetsForHtml, capturePageFetch } from './fetch_capture';
import {
  AgentPageContext,
  buildAgentContextDocument,
  buildAgentPageContext,
  renderAgentContextMarkdown,
} from './agent_context';
import {
  CdBrandingAssets,
  MiniCdCollector,
  MiniCdReport,
  renderCdHtml,
  renderCdMarkdown,
} from './mini_cd';
import { writeSkill } from './skill_gen';

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

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    if (
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('javascript:')
    ) {
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

const SPINNER_FRAMES = ['-', '\\', '|', '/'] as const;
const toPosix = (value: string): string => value.split(path.sep).join('/');

export class Scraper {
  private storage: Storage;
  private robots: RobotsClient | null;
  private scopeFilter: (url: string) => boolean;
  private rateLimiter: RateLimiter;
  private crawler: Crawler;
  private processedPages = 0;
  private completedPages = 0;
  private failedPages = 0;
  private useFetchFallback = false;
  private progressTicker: ReturnType<typeof setInterval> | null = null;
  private lastRenderLength = 0;
  private lastNonTtyRenderAt = 0;
  private spinnerIndex = 0;
  private lastStartedUrl: string | null = null;
  private miniCdCollector = new MiniCdCollector();
  private agentPages: AgentPageContext[] = [];

  constructor(private options: ScrapeOptions) {
    this.storage = new Storage(options.output, options);
    this.robots = options.respectRobots ? new RobotsClient() : null;
    this.scopeFilter = createScopeFilter(
      options.url,
      options.scope,
      options.include,
      options.exclude,
    );
    this.rateLimiter = new RateLimiter(options.delayMs);
    this.crawler = new Crawler({
      concurrency: options.concurrency,
      maxPages: options.maxPages,
    });
  }

  async run(): Promise<void> {
    await this.storage.init();

    this.crawler.enqueue(this.options.url, 0);
    this.storage.registerPageMapping(this.options.url);

    let browser;
    try {
      browser = await chromium.launch();
    } catch (_error) {
      console.warn(
        'Playwright browser not found or failed to launch. Falling back to fetch-only mode.',
      );
      this.useFetchFallback = true;
    }

    const context = browser
      ? await browser.newContext({
          userAgent: this.options.userAgent,
        })
      : null;

    let crawlError: unknown = null;
    this.renderProgress(false, true);
    this.startProgressTicker();
    try {
      await this.crawler.run((item) => this.processPage(context, item));
    } catch (error) {
      crawlError = error;
    } finally {
      this.stopProgressTicker();
      if (context) await context.close();
      if (browser) await browser.close();
      this.renderProgress(true, true);
    }
    if (crawlError) throw crawlError;

    const report = this.miniCdCollector.buildReport(this.options.url);

    const postTasks: Promise<void>[] = [
      this.writeCdFile(report).catch((error) => {
        this.storage.recordError({
          url: this.options.url,
          error: (error as Error).message,
          phase: 'cd',
          timestamp: new Date().toISOString(),
        });
      }),
      this.writeAgentContext().catch((error) => {
        this.storage.recordError({
          url: this.options.url,
          error: (error as Error).message,
          phase: 'agent-context',
          timestamp: new Date().toISOString(),
        });
      }),
    ];

    if (this.options.skill) {
      const domain = new URL(this.options.url).hostname;
      postTasks.push(
        writeSkill(this.options.output, domain, this.options.url, report).then(async (skillDir) => {
          await this.storage.logEvent({ type: 'skill-written', skillDir });
        }).catch((error) => {
          this.storage.recordError({
            url: this.options.url,
            error: (error as Error).message,
            phase: 'skill',
            timestamp: new Date().toISOString(),
          });
        }),
      );
    }

    await Promise.allSettled(postTasks);

    await this.storage.finalize();

    const errors = this.storage.errorCount();
    if (errors > 0) {
      console.warn(
        `Scrape finished with ${errors} error(s). See: ${this.storage.manifestPath}`,
      );
    }
    if (this.storage.pageCount() === 0) {
      throw new Error(`No pages were captured. See: ${this.storage.manifestPath}`);
    }
  }

  private async processPage(
    context: BrowserContext | null,
    item: CrawlItem,
  ): Promise<void> {
    if (item.depth > 0 && !this.scopeFilter(item.url)) return;
    if (item.depth > this.options.maxDepth) return;
    this.markPageStarted(item.url);
    try {
      if (this.robots) {
        const allowed = await this.robots.canFetch(item.url, this.options.userAgent);
        if (!allowed) {
          this.failedPages += 1;
          this.storage.recordError({
            url: item.url,
            error: 'Blocked by robots.txt',
            phase: 'robots',
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      await this.rateLimiter.wait();
      await this.storage.logEvent({
        type: 'page-start',
        url: item.url,
        depth: item.depth,
      });

      let captured: CapturedPage | null = null;
      try {
        if (this.useFetchFallback || !context) {
          captured = await capturePageFetch(
            item.url,
            this.options.userAgent,
            this.options.timeoutMs,
          );
        } else {
          captured = await capturePage(context, item.url, {
            timeoutMs: this.options.timeoutMs,
            collectComputedSnapshot: false,
          });
        }
      } catch (error) {
        this.failedPages += 1;
        this.storage.recordError({
          url: item.url,
          error: (error as Error).message,
          phase: 'navigation',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!captured) {
        this.failedPages += 1;
        return;
      }

      if (captured.computedSnapshot) {
        this.miniCdCollector.addComputedSnapshot(captured.computedSnapshot);
      }

      // Playwright only captures resources that were actually requested during the page load.
      // For lazy-loaded media, this can miss important assets. We augment by discovering assets
      // directly from the captured HTML/CSS and fetching any that aren't already captured.
      if (!this.useFetchFallback && context) {
        try {
          const already = new Set<string>();
          for (const response of captured.responses) {
            try {
              const contentType = (response.contentType || '').toLowerCase();
              const lowerUrl = response.url.split('?')[0].toLowerCase();
              const isCss = contentType.includes('text/css') || lowerUrl.endsWith('.css');
              // Keep CSS out of "already captured" so we still parse it for nested assets
              // (fonts, images, @imports) during the extra fetch pass.
              if (!isCss) {
                already.add(normalizeUrl(response.url));
              }
            } catch {
              continue;
            }
          }
          const extra = await captureAssetsForHtml(
            captured.html,
            item.url,
            this.options.userAgent,
            this.options.timeoutMs,
            already,
          );
          captured.responses.push(...extra);
        } catch {
          // best-effort
        }
      }

      const pagePath = this.storage.registerPageMapping(item.url);
      this.storage.setCurrentPageDir(pagePath);

      const responseMap = new Map<string, { contentType: string | null; body: Buffer }>();
      for (const response of captured.responses) {
        responseMap.set(normalizeUrl(response.url), {
          contentType: response.contentType,
          body: response.body,
        });
      }

      const savedCssAssets = new Map<string, string>();
      for (const response of captured.responses) {
        const kind = this.getAssetKind(response.url, response.contentType);
        if (!kind) continue;
        try {
          const asset = await this.storage.saveAsset(
            response.url,
            response.body,
            response.contentType,
            kind,
          );
          await this.storage.logEvent({
            type: 'asset-saved',
            url: response.url,
            path: asset.path,
          });
          if (kind === 'css') {
            savedCssAssets.set(asset.path, normalizeUrl(response.url));
            this.miniCdCollector.addCss(response.body.toString('utf8'));
          }
        } catch (error) {
          this.storage.recordError({
            url: response.url,
            error: (error as Error).message,
            phase: 'asset-save',
            timestamp: new Date().toISOString(),
          });
        }
      }

      if (!this.options.singleFile) {
        for (const [cssPath, cssUrl] of savedCssAssets.entries()) {
          try {
            const cssBuffer =
              responseMap.get(cssUrl)?.body ?? (await fs.readFile(cssPath));
            const rewrittenCss = rewriteCss(
              cssBuffer.toString('utf8'),
              cssUrl,
              cssPath,
              this.storage.resourceMap,
              responseMap,
              false,
            );
            await fs.writeFile(cssPath, rewrittenCss, 'utf8');
          } catch (error) {
            this.storage.recordError({
              url: cssUrl,
              error: (error as Error).message,
              phase: 'css-rewrite',
              timestamp: new Date().toISOString(),
            });
          }
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

      let rewrittenHtml = inlineHtmlAssets(
        captured.html,
        item.url,
        pagePath,
        responseMap,
        this.storage.resourceMap,
        this.options.singleFile,
        this.options.singleFile,
      );
      rewrittenHtml = rewriteHtml(
        rewrittenHtml,
        item.url,
        pagePath,
        this.storage.resourceMap,
        responseMap,
        this.options.singleFile,
        this.options.stripConsent,
      );
      if (!captured.computedSnapshot) {
        this.miniCdCollector.addHtml(rewrittenHtml);
      }

      await this.storage.savePage(
        {
          url: item.url,
          path: pagePath,
          depth: item.depth,
          status: captured.status,
          contentType: captured.contentType,
          timestamp: new Date().toISOString(),
        },
        rewrittenHtml,
      );

      this.agentPages.push(
        buildAgentPageContext({
          outputDir: this.options.output,
          url: item.url,
          pagePath,
          depth: item.depth,
          status: captured.status,
          contentType: captured.contentType,
          html: rewrittenHtml,
        }),
      );

      this.processedPages += 1;

      await this.storage.logEvent({
        type: 'page-finished',
        url: item.url,
        depth: item.depth,
      });
    } finally {
      this.markPageFinished();
    }
  }

  private async writeCdFile(report: MiniCdReport): Promise<void> {
    const rootPagePath = this.storage.pagePathForUrl(this.options.url);
    const dataDir = path.join(path.dirname(rootPagePath), 'data');
    const markdownPath = path.join(dataDir, 'cd.md');
    const htmlPath = path.join(dataDir, 'cd.html');
    const branding = await this.extractBrandingAssets(rootPagePath, htmlPath);

    await fs.mkdir(dataDir, { recursive: true });
    await Promise.all([
      fs.writeFile(markdownPath, renderCdMarkdown(report), 'utf8'),
      fs.writeFile(htmlPath, renderCdHtml(report, branding), 'utf8'),
    ]);

    await this.storage.logEvent({
      type: 'cd-written',
      markdownPath,
      htmlPath,
    });
  }

  private async writeAgentContext(): Promise<void> {
    const rootPagePath = this.storage.pagePathForUrl(this.options.url);
    const contextDir = path.join(this.options.output, 'agent');
    const contextJsonPath = path.join(contextDir, 'context.json');
    const contextMdPath = path.join(contextDir, 'context.md');
    const rootRelative = toPosix(path.relative(this.options.output, rootPagePath));
    const context = buildAgentContextDocument(
      this.options.url,
      rootRelative,
      this.agentPages,
    );

    await fs.mkdir(contextDir, { recursive: true });
    await Promise.all([
      fs.writeFile(contextJsonPath, JSON.stringify(context, null, 2), 'utf8'),
      fs.writeFile(contextMdPath, renderAgentContextMarkdown(context), 'utf8'),
    ]);

    await this.storage.logEvent({
      type: 'agent-context-written',
      contextJsonPath,
      contextMdPath,
    });
  }

  private async extractBrandingAssets(
    rootPagePath: string,
    cdHtmlPath: string,
  ): Promise<CdBrandingAssets> {
    try {
      const html = await fs.readFile(rootPagePath, 'utf8');
      const $ = load(html);

      const faviconRaw =
        this.pickFirstAttr(
          $,
          [
            'link[rel~="icon"][href]',
            'link[rel="shortcut icon"][href]',
            'link[rel="apple-touch-icon"][href]',
          ],
          'href',
        ) || this.pickFirstAttr($, ['meta[property="og:image"][content]'], 'content');

      const logoRaw = this.pickFirstAttr(
        $,
        [
          'header a[class*="logo" i] img[src]',
          'a[class*="logo" i] img[src]',
          'img[alt*="logo" i][src]',
          'img[src*="logo" i]',
          'header img[src]',
        ],
        'src',
      );

      return {
        faviconHref: this.resolveBrandAssetPath(faviconRaw, rootPagePath, cdHtmlPath),
        logoHref: this.resolveBrandAssetPath(logoRaw, rootPagePath, cdHtmlPath),
      };
    } catch {
      return {};
    }
  }

  private pickFirstAttr(
    $: ReturnType<typeof load>,
    selectors: string[],
    attribute: string,
  ): string | null {
    for (const selector of selectors) {
      const element = $(selector).first();
      const value = element.attr(attribute);
      if (value && value.trim()) return value.trim();
    }
    return null;
  }

  private resolveBrandAssetPath(
    rawValue: string | null,
    rootPagePath: string,
    cdHtmlPath: string,
  ): string | null {
    if (!rawValue) return null;
    const value = rawValue.trim();
    if (!value) return null;
    if (value.startsWith('data:')) return value;
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    if (value.startsWith('//')) return `https:${value}`;

    const hashIndex = value.indexOf('#');
    const queryIndex = value.indexOf('?');
    let splitIndex = -1;
    if (hashIndex !== -1 && queryIndex !== -1) splitIndex = Math.min(hashIndex, queryIndex);
    else splitIndex = Math.max(hashIndex, queryIndex);
    const suffix = splitIndex === -1 ? '' : value.slice(splitIndex);
    const filePart = splitIndex === -1 ? value : value.slice(0, splitIndex);
    if (!filePart) return null;

    if (filePart.startsWith('/')) return value;

    const absolutePath = path.resolve(path.dirname(rootPagePath), filePart);
    try {
      const stat = statSync(absolutePath);
      if (!stat.isFile()) return value;
    } catch {
      return value;
    }

    const relative = path.relative(path.dirname(cdHtmlPath), absolutePath);
    return `${toPosix(relative || '.')}${suffix}`;
  }

  private startProgressTicker(): void {
    this.stopProgressTicker();
    this.progressTicker = setInterval(() => {
      this.renderProgress(false);
    }, 1000);
  }

  private stopProgressTicker(): void {
    if (!this.progressTicker) return;
    clearInterval(this.progressTicker);
    this.progressTicker = null;
  }

  private markPageStarted(url: string): void {
    this.lastStartedUrl = url;
    this.renderProgress(false, true);
  }

  private markPageFinished(): void {
    this.completedPages += 1;
    this.renderProgress(false, true);
  }

  private renderProgress(done = false, force = false): void {
    const discovered = this.options.subpages
      ? Math.min(this.crawler.discoveredCount(), this.options.maxPages)
      : 1;
    const completed = Math.min(this.completedPages, this.options.maxPages);
    const spinner = done
      ? 'done'
      : SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length];
    if (!done) {
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
    }
    const summary = this.options.subpages
      ? `${completed}/${discovered} pages (max ${this.options.maxPages})`
      : `${completed}/1 pages`;
    const counts = `ok:${this.processedPages} failed:${this.failedPages} active:${this.crawler.activeCount()} queued:${this.crawler.pendingCount()}`;
    const current = this.lastStartedUrl
      ? ` | current:${this.truncateUrl(this.lastStartedUrl)}`
      : '';
    const message = `${done ? 'Progress:' : `[${spinner}]`} ${summary} | ${counts}${current}`;

    if (process.stdout.isTTY) {
      const padded = message.padEnd(this.lastRenderLength, ' ');
      process.stdout.write(`\r${padded}${done ? '\n' : ''}`);
      this.lastRenderLength = message.length;
      return;
    }

    const now = Date.now();
    if (!done && !force && now - this.lastNonTtyRenderAt < 5000) {
      return;
    }
    this.lastNonTtyRenderAt = now;
    console.log(message);
  }

  private truncateUrl(url: string, maxLength = 72): string {
    if (url.length <= maxLength) return url;
    return `${url.slice(0, maxLength - 3)}...`;
  }

  private getAssetKind(
    url: string,
    contentType: string | null,
  ): 'img' | 'css' | 'other' | null {
    if (contentType) {
      if (contentType.startsWith('image/')) return 'img';
      if (contentType.includes('text/css')) return 'css';
      if (contentType.includes('javascript') || contentType.includes('ecmascript'))
        return 'other';
      if (contentType.startsWith('font/')) return 'other';
      if (contentType.includes('font')) return 'other';
    }
    const lower = url.split('?')[0].toLowerCase();
    if (lower.endsWith('.css')) return 'css';
    if (lower.match(/\.(m?js|cjs)$/)) return 'other';
    if (lower.match(/\.(png|jpe?g|gif|webp|svg|avif|ico)$/)) return 'img';
    if (lower.match(/\.(woff2?|ttf|otf|eot)$/)) return 'other';
    return null;
  }
}
