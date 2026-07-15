import http from 'http';
import { Socket } from 'net';
import path from 'path';
import { promises as fs } from 'fs';
import * as mime from 'mime-types';
import { chromium, BrowserContext } from 'playwright';
import pLimit from 'p-limit';
import {
  Manifest,
  PageEntry,
  VerifyConsoleMessage,
  VerifyPageResult,
  VerifyReport,
  VerifyRequestIssue,
} from './types';

const toPosix = (value: string): string => value.split(path.sep).join('/');

const truncate = (value: string, max = 200): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

// ---------------------------------------------------------------------------
// Static server — mirrors `npx http-server`: plain static files, index.html for
// directories, 404 otherwise. Deliberately NO manifest URL-mapping, so the check
// reflects exactly what the user sees when previewing with http-server.
// ---------------------------------------------------------------------------

const safeJoin = (root: string, urlPath: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const normalized = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, normalized);
  const rel = path.relative(root, resolved);
  if (rel === '') return resolved;
  if (rel.startsWith('..') || rel.includes(`..${path.sep}`)) return null;
  return resolved;
};

export interface StaticServer {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

export const startStaticServer = async (rootDir: string): Promise<StaticServer> => {
  const root = path.resolve(rootDir);
  const host = '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${host}`);
      const filePath = safeJoin(root, reqUrl.pathname);
      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad request');
        return;
      }

      let targetPath = filePath;
      let stat;
      try {
        stat = await fs.stat(targetPath);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      if (stat.isDirectory()) {
        targetPath = path.join(targetPath, 'index.html');
        try {
          await fs.access(targetPath);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
      }

      const body = await fs.readFile(targetPath);
      const contentType = mime.lookup(targetPath) || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': `${contentType}${String(contentType).startsWith('text/') ? '; charset=utf-8' : ''}`,
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end((error as Error).message || 'Internal error');
    }
  });

  // Track open sockets so we can force-close them. Otherwise `server.close()`
  // waits for lingering keep-alive connections and its callback never fires,
  // hanging the whole verify run.
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://${host}:${port}`,
    host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        server.close(() => done());
        // bun does not always invoke the close callback once sockets are torn
        // down (node does). Resolve on the next tick as well so the run never
        // hangs; the listener is already stopped and all sockets destroyed.
        setImmediate(done);
      }),
  };
};

// ---------------------------------------------------------------------------
// Classification + aggregation — pure, unit-tested.
// ---------------------------------------------------------------------------

/** A request is `local` when it targets our static server, `external` otherwise. */
export const classifyRequestOrigin = (
  requestUrl: string,
  serverHost: string,
  serverPort: number,
): 'local' | 'external' => {
  try {
    const parsed = new URL(requestUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'external';
    }
    const host = parsed.hostname;
    const isLocalHost =
      host === serverHost || host === 'localhost' || host === '127.0.0.1';
    return isLocalHost && parsed.port === String(serverPort) ? 'local' : 'external';
  } catch {
    return 'external';
  }
};

/**
 * Dedupe failed requests to one issue per unique resource (origin + url) and
 * split them into local (actionable) vs external (informative). A 404 response
 * and its follow-up `net::ERR_ABORTED` describe the same missing resource — the
 * entry carrying an HTTP status wins.
 */
export const splitRequestIssues = (
  issues: VerifyRequestIssue[],
): { local: VerifyRequestIssue[]; external: VerifyRequestIssue[] } => {
  const byKey = new Map<string, VerifyRequestIssue>();
  for (const issue of issues) {
    const key = `${issue.origin}::${issue.url}`;
    const existing = byKey.get(key);
    if (!existing || (issue.status != null && existing.status == null)) {
      byKey.set(key, issue);
    }
  }

  const local: VerifyRequestIssue[] = [];
  const external: VerifyRequestIssue[] = [];
  for (const issue of byKey.values()) {
    if (issue.origin === 'local') local.push(issue);
    else external.push(issue);
  }
  return { local, external };
};

export const buildVerifyReport = (
  pages: VerifyPageResult[],
  meta: { rootDir: string; generatedAt: string },
): VerifyReport => {
  const totals = {
    localFailedRequests: 0,
    pagesWithLocalFailures: 0,
    externalFailedRequests: 0,
    consoleErrors: 0,
    consoleWarnings: 0,
    pageErrors: 0,
  };

  for (const page of pages) {
    totals.localFailedRequests += page.localFailedRequests.length;
    totals.externalFailedRequests += page.externalFailedRequests.length;
    totals.consoleErrors += page.consoleErrors.length;
    totals.consoleWarnings += page.consoleWarnings.length;
    totals.pageErrors += page.pageErrors.length;
    if (page.localFailedRequests.length > 0) totals.pagesWithLocalFailures += 1;
  }

  return {
    generatedAt: meta.generatedAt,
    rootDir: meta.rootDir,
    pagesChecked: pages.length,
    totals,
    pages,
  };
};

/** One-line console summary. Headlines the actionable (local) signal. */
export const renderVerifySummary = (report: VerifyReport): string => {
  const t = report.totals;
  if (t.localFailedRequests > 0) {
    return (
      `Verify: ${t.localFailedRequests} fehlende lokale Ressource(n) auf ` +
      `${t.pagesWithLocalFailures}/${report.pagesChecked} Seite(n) (actionable). ` +
      `Zusätzlich (informativ): ${t.externalFailedRequests} externe Requests, ` +
      `${t.consoleErrors} Console-Errors, ${t.pageErrors} JS-Exceptions.`
    );
  }
  return (
    `Verify: keine fehlenden lokalen Ressourcen (${report.pagesChecked}/${report.pagesChecked} Seiten). ` +
    `Informativ: ${t.consoleErrors} Console-Errors, ${t.externalFailedRequests} externe Requests ` +
    `(Runtime-JS/Remote — erwartbar).`
  );
};

const requestDetail = (req: VerifyRequestIssue): string =>
  req.status ? `HTTP ${req.status}` : req.errorText || 'failed';

export const renderVerifyMarkdown = (report: VerifyReport): string => {
  const t = report.totals;
  const lines: string[] = [];

  lines.push('# Scrape Verify Report');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Root: ${report.rootDir}`);
  lines.push(`- Pages checked: ${report.pagesChecked}`);
  lines.push('');

  lines.push('## Actionable — fehlende lokale Ressourcen');
  lines.push('');
  lines.push(
    `**${t.localFailedRequests}** fehlgeschlagene lokale Request(s) auf ` +
      `**${t.pagesWithLocalFailures}** Seite(n).`,
  );
  lines.push('');

  if (t.localFailedRequests === 0) {
    lines.push('Keine fehlenden lokalen Ressourcen. ✅');
    lines.push('');
  } else {
    for (const page of report.pages) {
      if (page.localFailedRequests.length === 0) continue;
      lines.push(`### ${page.url}`);
      lines.push('');
      lines.push(`Snapshot: \`${page.path}\``);
      lines.push('');
      for (const req of page.localFailedRequests) {
        const type = req.resourceType ? `${req.resourceType} ` : '';
        lines.push(`- [${requestDetail(req)}] ${type}${req.url}`);
      }
      lines.push('');
    }
  }

  lines.push('## Informativ');
  lines.push('');
  lines.push(`- Externe fehlgeschlagene Requests: ${t.externalFailedRequests}`);
  lines.push(`- Console-Errors: ${t.consoleErrors}`);
  lines.push(`- Console-Warnings: ${t.consoleWarnings}`);
  lines.push(`- JS-Exceptions: ${t.pageErrors}`);
  lines.push('');
  lines.push(
    '> Console-Errors/JS-Exceptions und externe Requests sind beim erneuten ' +
      'Ausführen der Seiten-JS ohne Backend meist erwartbar und kein Scrape-Fehler.',
  );
  lines.push('');

  const SAMPLE = 10;
  const pagesWithInfo = report.pages.filter(
    (page) =>
      page.consoleErrors.length +
        page.pageErrors.length +
        page.externalFailedRequests.length >
        0 || !page.navigated,
  );

  if (pagesWithInfo.length > 0) {
    lines.push('### Details (Auszug)');
    lines.push('');
    for (const page of pagesWithInfo) {
      lines.push(`#### ${page.url}`);
      lines.push('');
      if (!page.navigated) {
        lines.push(
          `- ⚠️ Navigation fehlgeschlagen: ${page.navigationError ?? 'unbekannt'}`,
        );
      }
      if (page.consoleErrors.length > 0) {
        lines.push(`- Console-Errors: ${page.consoleErrors.length}`);
        for (const msg of page.consoleErrors.slice(0, SAMPLE)) {
          lines.push(
            `  - ${truncate(msg.text)}${msg.location ? ` (${msg.location})` : ''}`,
          );
        }
      }
      if (page.pageErrors.length > 0) {
        lines.push(`- JS-Exceptions: ${page.pageErrors.length}`);
        for (const msg of page.pageErrors.slice(0, SAMPLE)) {
          lines.push(`  - ${truncate(msg.text)}`);
        }
      }
      if (page.externalFailedRequests.length > 0) {
        lines.push(`- Externe Requests: ${page.externalFailedRequests.length}`);
        for (const req of page.externalFailedRequests.slice(0, SAMPLE)) {
          lines.push(`  - [${requestDetail(req)}] ${req.url}`);
        }
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
};

// ---------------------------------------------------------------------------
// Orchestration — server + Playwright over all manifest pages.
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  concurrency?: number;
  timeoutMs?: number;
}

const readManifest = async (root: string): Promise<Manifest> => {
  const text = await fs.readFile(path.join(root, 'scrape-manifest.json'), 'utf8');
  return JSON.parse(text) as Manifest;
};

const checkPage = async (
  context: BrowserContext,
  server: StaticServer,
  page: PageEntry,
  root: string,
  timeoutMs: number,
): Promise<VerifyPageResult> => {
  const relPath = toPosix(path.relative(root, path.resolve(page.path)));
  const localUrl = `${server.url}/${relPath}`;

  const consoleErrors: VerifyConsoleMessage[] = [];
  const consoleWarnings: VerifyConsoleMessage[] = [];
  const pageErrors: VerifyConsoleMessage[] = [];

  const rawRequests: VerifyRequestIssue[] = [];
  const pushRequest = (issue: VerifyRequestIssue): void => {
    rawRequests.push(issue);
  };

  const pw = await context.newPage();

  pw.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const loc = msg.location();
    const location = loc?.url ? `${loc.url}:${loc.lineNumber ?? 0}` : undefined;
    const entry: VerifyConsoleMessage = { text: msg.text(), location };
    if (type === 'error') consoleErrors.push(entry);
    else consoleWarnings.push(entry);
  });

  pw.on('pageerror', (error) => {
    const stackLine = error.stack?.split('\n')[1]?.trim();
    pageErrors.push({ text: error.message, location: stackLine });
  });

  pw.on('requestfailed', (request) => {
    const url = request.url();
    pushRequest({
      url,
      origin: classifyRequestOrigin(url, server.host, server.port),
      method: request.method(),
      resourceType: request.resourceType(),
      errorText: request.failure()?.errorText,
    });
  });

  pw.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const request = response.request();
    const url = response.url();
    pushRequest({
      url,
      origin: classifyRequestOrigin(url, server.host, server.port),
      method: request.method(),
      resourceType: request.resourceType(),
      status,
    });
  });

  let navigated = true;
  let navigationError: string | undefined;
  try {
    await pw.goto(localUrl, { waitUntil: 'load', timeout: timeoutMs });
    try {
      await pw.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 8000) });
    } catch {
      // best-effort settle for late requests
    }
  } catch (error) {
    navigated = false;
    navigationError = (error as Error).message;
  }

  await pw.close();

  const { local: localFailedRequests, external: externalFailedRequests } =
    splitRequestIssues(rawRequests);

  return {
    url: page.url,
    localUrl,
    path: relPath,
    navigated,
    navigationError,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    localFailedRequests,
    externalFailedRequests,
  };
};

export const verifyScrape = async (
  rootDir: string,
  options: VerifyOptions = {},
): Promise<VerifyReport> => {
  const root = path.resolve(rootDir);
  const manifest = await readManifest(root);
  const pages = (manifest.pages ?? []).filter(
    (page) => page && typeof page.path === 'string',
  );

  const concurrency = Math.max(1, options.concurrency ?? 2);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30000);

  const server = await startStaticServer(root);
  const browser = await chromium.launch();
  const context = await browser.newContext();

  try {
    const limit = pLimit(concurrency);
    const results = await Promise.all(
      pages.map((page) => limit(() => checkPage(context, server, page, root, timeoutMs))),
    );
    return buildVerifyReport(results, {
      rootDir: root,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
};

export const writeVerifyReport = async (
  rootDir: string,
  report: VerifyReport,
): Promise<{ jsonPath: string; mdPath: string }> => {
  const root = path.resolve(rootDir);
  const jsonPath = path.join(root, 'verify-report.json');
  const mdPath = path.join(root, 'verify-report.md');
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(mdPath, renderVerifyMarkdown(report), 'utf8');
  return { jsonPath, mdPath };
};
