import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import * as mime from 'mime-types';
import { AssetEntry, ErrorEntry, Manifest, PageEntry, ScrapeOptions } from './types';
import { normalizeUrl } from './url';

const sanitizeSegment = (value: string): string => {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
};

const toPosix = (value: string): string => value.split(path.sep).join('/');

const hashValue = (value: string): string => {
  return createHash('sha1').update(value).digest('hex').slice(0, 10);
};

export class Storage {
  readonly outputDir: string;
  readonly pagesDir: string;
  readonly assetsDir: string;
  readonly assetsImgDir: string;
  readonly assetsCssDir: string;
  readonly manifestPath: string;
  readonly logPath: string;
  readonly resourceMap = new Map<string, string>();
  private readonly primaryHost: string | null;
  private contentHashMap = new Map<string, string>();
  private manifest: Manifest;

  constructor(outputDir: string, options: ScrapeOptions) {
    this.outputDir = outputDir;
    this.pagesDir = outputDir;
    this.assetsDir = path.join(outputDir, 'assets');
    this.assetsImgDir = path.join(this.assetsDir, 'img');
    this.assetsCssDir = path.join(this.assetsDir, 'css');
    this.manifestPath = path.join(outputDir, 'scrape-manifest.json');
    this.logPath = path.join(outputDir, 'scrape-log.jsonl');
    this.manifest = {
      startedAt: new Date().toISOString(),
      options,
      pages: [],
      assets: [],
      errors: [],
    };
    try {
      this.primaryHost = new URL(options.url).hostname.toLowerCase();
    } catch {
      this.primaryHost = null;
    }
  }

  async init(): Promise<void> {
    await fs.mkdir(this.pagesDir, { recursive: true });
    await fs.mkdir(this.assetsDir, { recursive: true });
    await fs.mkdir(this.assetsImgDir, { recursive: true });
    await fs.mkdir(this.assetsCssDir, { recursive: true });
  }

  registerPageMapping(url: string, explicitPath?: string): string {
    const normalized = normalizeUrl(url);
    const pathForUrl = explicitPath ?? this.pagePathForUrl(url);
    if (!this.resourceMap.has(normalized)) {
      this.resourceMap.set(normalized, pathForUrl);
    }
    return pathForUrl;
  }

  registerAssetMapping(url: string, localPath: string): void {
    const normalized = normalizeUrl(url);
    this.resourceMap.set(normalized, localPath);
    const basename = path.basename(localPath);
    if (basename && !this.resourceMap.has(`asset-basename:${basename}`)) {
      this.resourceMap.set(`asset-basename:${basename}`, localPath);
    }
  }

  getResourcePath(url: string): string | undefined {
    const normalized = normalizeUrl(url);
    return this.resourceMap.get(normalized);
  }

  pagePathForUrl(url: string): string {
    const parsed = new URL(url);
    const host = sanitizeSegment(parsed.hostname);
    let pathname = parsed.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    const pathSegments = pathname
      .split('/')
      .filter(Boolean)
      .map(sanitizeSegment);
    const querySuffix = parsed.search ? `__q_${hashValue(parsed.search)}` : '';
    const dirSegments: string[] = [];
    if (this.primaryHost && parsed.hostname.toLowerCase() !== this.primaryHost) {
      dirSegments.push(host);
    }
    dirSegments.push(...pathSegments);
    if (querySuffix) {
      dirSegments.push(querySuffix);
    }
    const dir = dirSegments.length > 0 ? path.join(this.pagesDir, ...dirSegments) : this.pagesDir;
    return path.join(dir, 'index.html');
  }

  async savePage(entry: PageEntry, html: string): Promise<void> {
    await fs.mkdir(path.dirname(entry.path), { recursive: true });
    await fs.writeFile(entry.path, html, 'utf8');
    this.manifest.pages.push(entry);
    this.registerPageMapping(entry.url, entry.path);
  }

  async saveAsset(
    url: string,
    body: Buffer,
    contentType: string | null,
    kind: 'img' | 'css' | 'other' = 'other',
  ): Promise<AssetEntry> {
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    let extension = '';
    if (contentType) {
      const inferred = mime.extension(contentType.split(';')[0]);
      if (inferred) {
        extension = `.${inferred}`;
      }
    }
    if (!extension) {
      const parsed = new URL(url);
      const ext = path.extname(parsed.pathname);
      extension = ext || '';
    }
    const filename = `${hash}${extension}`;
    const baseDir =
      kind === 'img'
        ? this.assetsImgDir
        : kind === 'css'
          ? this.assetsCssDir
          : this.assetsDir;
    const localPath = path.join(baseDir, filename);

    const mapKey = `${kind}/${filename}`;
    const existing = this.contentHashMap.get(mapKey);
    if (!existing) {
      await fs.writeFile(localPath, body);
      this.contentHashMap.set(mapKey, localPath);
    }

    const asset: AssetEntry = {
      url,
      path: localPath,
      contentType,
      size: body.length,
      hash,
    };
    this.manifest.assets.push(asset);
    this.registerAssetMapping(url, localPath);
    return asset;
  }

  recordError(error: ErrorEntry): void {
    this.manifest.errors.push(error);
  }

  async logEvent(event: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
    await fs.appendFile(this.logPath, `${line}\n`);
  }

  async finalize(): Promise<void> {
    this.manifest.finishedAt = new Date().toISOString();
    await fs.writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
  }

  relativePath(fromPath: string, toPath: string): string {
    const relative = path.relative(path.dirname(fromPath), toPath);
    return toPosix(relative || '.');
  }

  pageCount(): number {
    return this.manifest.pages.length;
  }

  errorCount(): number {
    return this.manifest.errors.length;
  }
}
