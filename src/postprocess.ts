#!/usr/bin/env node
import path from 'path';
import { promises as fs } from 'fs';
import { Command } from 'commander';
import { inlineHtmlAssets, rewriteHtml } from './rewrite';
import { normalizeUrl } from './url';
import { Manifest } from './types';

const program = new Command();
program
  .name('scrape-postprocess')
  .description('Post-process an existing scrape directory (e.g. convert to single-file)')
  .option('--dir <dir>', 'Scrape output directory', '.')
  .option('--single-file', 'Inline CSS/JS/images/fonts into each HTML file', true)
  .option('--no-single-file', 'Keep HTML referencing local assets instead of inlining')
  .option('--strip-consent', 'Remove common cookie/consent overlays', true)
  .option('--no-strip-consent', 'Keep cookie/consent overlays');

program.parse(process.argv);
const opts = program.opts();

const rootDir = path.resolve(String(opts.dir));
const manifestPath = path.join(rootDir, 'scrape-manifest.json');

const readJson = async <T>(filePath: string): Promise<T> => {
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text) as T;
};

const main = async (): Promise<void> => {
  const manifest = await readJson<Manifest>(manifestPath);

  const resourceMap = new Map<string, string>();
  for (const page of manifest.pages) {
    resourceMap.set(normalizeUrl(page.url), page.path);
  }
  for (const asset of manifest.assets) {
    resourceMap.set(normalizeUrl(asset.url), asset.path);
    const basename = path.basename(asset.path);
    if (basename && !resourceMap.has(`asset-basename:${basename}`)) {
      resourceMap.set(`asset-basename:${basename}`, asset.path);
    }
  }

  const responses = new Map<string, { contentType: string | null; body: Buffer }>();
  for (const asset of manifest.assets) {
    try {
      const body = await fs.readFile(asset.path);
      responses.set(normalizeUrl(asset.url), { contentType: asset.contentType, body });
    } catch {
      continue;
    }
  }

  let updated = 0;
  for (const page of manifest.pages) {
    const html = await fs.readFile(page.path, 'utf8');
    const inlined = inlineHtmlAssets(
      html,
      page.url,
      page.path,
      responses,
      resourceMap,
      Boolean(opts.singleFile),
    );
    const rewritten = rewriteHtml(
      inlined,
      page.url,
      page.path,
      resourceMap,
      responses,
      Boolean(opts.singleFile),
      Boolean(opts.stripConsent),
    );
    await fs.writeFile(page.path, rewritten, 'utf8');
    updated += 1;
  }

  console.log(`Post-process complete. Updated ${updated} page(s).`);
};

main().catch((error) => {
  console.error('Post-process failed:', error);
  process.exitCode = 1;
});
