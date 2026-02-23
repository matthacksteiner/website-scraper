#!/usr/bin/env node
import http from 'http';
import path from 'path';
import { promises as fs, readdirSync, statSync } from 'fs';
import * as mime from 'mime-types';
import { Command } from 'commander';

const toNumber = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

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

const resolveLatestScrapeDir = (scrapesDir: string): string => {
  const baseDir = path.resolve(scrapesDir);
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    throw new Error(`Scrapes directory not found: ${baseDir}`);
  }

  const candidates: Array<{ dir: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidateDir = path.join(baseDir, entry.name);
    const manifestPath = path.join(candidateDir, 'scrape-manifest.json');
    try {
      const manifestStat = statSync(manifestPath);
      candidates.push({ dir: candidateDir, mtimeMs: manifestStat.mtimeMs });
    } catch {
      // Ignore folders that are not finished scrape outputs.
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No scrape outputs found in: ${baseDir}`);
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].dir;
};

const resolveDefaultPageHtml = async (root: string): Promise<string | null> => {
  const pagesDir = path.join(root, 'pages');

  let hostDirs: string[];
  try {
    hostDirs = (await fs.readdir(pagesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }

  for (const hostName of hostDirs) {
    const rootIndex = path.join(pagesDir, hostName, 'root', 'index.html');
    try {
      await fs.access(rootIndex);
      return rootIndex;
    } catch {
      // Try the next host.
    }
  }

  return null;
};

interface ManifestLookup {
  byPathWithQuery: Map<string, string>;
  byPath: Map<string, string>;
  suffixEntries: Array<{ remotePath: string; localPath: string }>;
}

const normalizeRemotePath = (value: string): string => {
  if (!value) return '/';
  return value.startsWith('/') ? value : `/${value}`;
};

const buildManifestLookup = async (root: string): Promise<ManifestLookup | null> => {
  const manifestPath = path.join(root, 'scrape-manifest.json');
  let parsed: any;
  try {
    const text = await fs.readFile(manifestPath, 'utf8');
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const byPathWithQuery = new Map<string, string>();
  const byPath = new Map<string, string>();
  const suffixEntries: Array<{ remotePath: string; localPath: string }> = [];

  const register = (remoteUrl: string, localPath: string) => {
    try {
      const absoluteLocalPath = path.resolve(localPath);
      const remote = new URL(remoteUrl);
      const remotePath = normalizeRemotePath(remote.pathname);
      const withQuery = `${remotePath}${remote.search || ''}`;
      if (!byPathWithQuery.has(withQuery)) {
        byPathWithQuery.set(withQuery, absoluteLocalPath);
      }
      if (!byPath.has(remotePath)) {
        byPath.set(remotePath, absoluteLocalPath);
      }
      suffixEntries.push({ remotePath, localPath: absoluteLocalPath });
    } catch {
      return;
    }
  };

  const assets = Array.isArray(parsed?.assets) ? parsed.assets : [];
  for (const entry of assets) {
    if (typeof entry?.url !== 'string' || typeof entry?.path !== 'string') continue;
    register(entry.url, entry.path);
  }

  const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
  for (const entry of pages) {
    if (typeof entry?.url !== 'string' || typeof entry?.path !== 'string') continue;
    register(entry.url, entry.path);
  }

  return { byPathWithQuery, byPath, suffixEntries };
};

const resolveFromManifestLookup = (
  lookup: ManifestLookup | null,
  pathname: string,
  search: string,
): string | null => {
  if (!lookup) return null;
  const requestPath = normalizeRemotePath(pathname);
  const keyWithQuery = `${requestPath}${search || ''}`;

  const exactWithQuery = lookup.byPathWithQuery.get(keyWithQuery);
  if (exactWithQuery) return exactWithQuery;

  const exactPath = lookup.byPath.get(requestPath);
  if (exactPath) return exactPath;

  let bestMatch: string | null = null;
  let bestLength = -1;
  for (const entry of lookup.suffixEntries) {
    if (!entry.remotePath.endsWith(requestPath)) continue;
    if (entry.remotePath.length <= bestLength) continue;
    bestLength = entry.remotePath.length;
    bestMatch = entry.localPath;
  }

  return bestMatch;
};

const program = new Command();
program
  .name('serve-scrape')
  .description('Serve a scrape output directory over HTTP (avoids file:// CORS issues)')
  .option('--dir <dir>', 'Directory to serve', '.')
  .option('--latest', 'Serve the most recent scrape output directory', false)
  .option(
    '--scrapes-dir <dir>',
    'Directory that contains scrape output folders (used with --latest)',
    'scraped_sites',
  )
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option('--port <number>', 'Port to listen on', '4173');

program.parse(process.argv);
const opts = program.opts();

const latest = Boolean(opts.latest);
let rootDir = path.resolve(String(opts.dir));
if (latest) {
  try {
    rootDir = resolveLatestScrapeDir(String(opts.scrapesDir));
  } catch (error) {
    console.error((error as Error).message || 'Failed to resolve latest scrape output');
    process.exit(1);
  }
}
const host = String(opts.host);
const port = toNumber(String(opts.port), 4173);
let cachedDefaultPageHtml: string | null | undefined;
let cachedManifestLookup: ManifestLookup | null | undefined;

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || '/', `http://${host}:${port}`);
    const filePath = safeJoin(rootDir, reqUrl.pathname);
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      if (cachedManifestLookup === undefined) {
        cachedManifestLookup = await buildManifestLookup(rootDir);
      }
      const mapped = resolveFromManifestLookup(
        cachedManifestLookup,
        reqUrl.pathname,
        reqUrl.search,
      );
      if (mapped) {
        try {
          const body = await fs.readFile(mapped);
          const contentType = mime.lookup(mapped) || 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': `${contentType}${String(contentType).startsWith('text/') ? '; charset=utf-8' : ''}`,
            'Access-Control-Allow-Origin': '*',
          });
          res.end(body);
          return;
        } catch {
          // Fall through to standard 404.
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    let targetPath = filePath;
    if (stat.isDirectory()) {
      targetPath = path.join(filePath, 'index.html');
      try {
        await fs.access(targetPath);
      } catch {
        if (reqUrl.pathname === '/' || reqUrl.pathname.endsWith('/')) {
          if (reqUrl.pathname === '/') {
            if (cachedDefaultPageHtml === undefined) {
              cachedDefaultPageHtml = await resolveDefaultPageHtml(rootDir);
            }
            if (cachedDefaultPageHtml) {
              const body = await fs.readFile(cachedDefaultPageHtml);
              const contentType =
                mime.lookup(cachedDefaultPageHtml) || 'application/octet-stream';
              res.writeHead(200, {
                'Content-Type': `${contentType}${String(contentType).startsWith('text/') ? '; charset=utf-8' : ''}`,
                'Access-Control-Allow-Origin': '*',
              });
              res.end(body);
              return;
            }
          }

          const listing = await renderDirectoryListing(
            rootDir,
            filePath,
            reqUrl.pathname,
          );
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(listing);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
    }

    const body = await fs.readFile(targetPath);
    const contentType = mime.lookup(targetPath) || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': `${contentType}${String(contentType).startsWith('text/') ? '; charset=utf-8' : ''}`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end((error as Error).message || 'Internal error');
  }
});

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const ensureTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value : `${value}/`;

const renderDirectoryListing = async (
  root: string,
  dir: string,
  requestPath: string,
): Promise<string> => {
  const rel = path.relative(root, dir) || '.';
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const rows: { href: string; name: string }[] = [];
  const basePath = ensureTrailingSlash(requestPath);

  if (basePath !== '/') {
    const parent = basePath.replace(/[^/]+\/$/, '');
    rows.push({ href: parent, name: '..' });
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const suffix = entry.isDirectory() ? '/' : '';
    rows.push({
      href: `${basePath}${encodeURIComponent(entry.name)}${suffix}`,
      name: `${entry.name}${suffix}`,
    });
  }

  const recommended: { href: string; name: string }[] = [];
  if (rel === '.' || rel === '') {
    const pagesDir = path.join(root, 'pages');
    try {
      const hostDirs = (await fs.readdir(pagesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .slice(0, 20);
      for (const hostName of hostDirs) {
        const candidate = `/pages/${encodeURIComponent(hostName)}/root/index.html`;
        recommended.push({ href: candidate, name: `${hostName} (root)` });
      }
    } catch {
      // ignore
    }
  }

  const recommendedHtml =
    recommended.length > 0
      ? `<h2>Recommended</h2><ul>${recommended
          .map((item) => `<li><a href="${item.href}">${escapeHtml(item.name)}</a></li>`)
          .join('')}</ul>`
      : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Index of ${escapeHtml(basePath)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; padding: 16px; }
    code { background: #f4f4f5; padding: 2px 6px; border-radius: 6px; }
    ul { padding-left: 18px; }
  </style>
</head>
<body>
  <h1>Index of <code>${escapeHtml(basePath)}</code></h1>
  <p>Serving <code>${escapeHtml(path.resolve(root))}</code></p>
  ${recommendedHtml}
  <h2>Browse</h2>
  <ul>
    ${rows.map((item) => `<li><a href="${item.href}">${escapeHtml(item.name)}</a></li>`).join('')}
  </ul>
</body>
</html>`;
};

server.listen(port, host, () => {
  if (latest) {
    console.log(`Latest scrape selected: ${rootDir}`);
  }
  console.log(`Serving: ${rootDir}`);
  console.log(`URL: http://${host}:${port}/`);
});
