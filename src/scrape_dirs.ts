import path from 'path';
import { readdirSync, statSync } from 'fs';

/**
 * Resolve the most recently finished scrape output directory inside `scrapesDir`.
 * A directory counts as a finished scrape only if it contains `scrape-manifest.json`.
 * Shared by `serve` (--latest) and `verify` (--latest).
 */
export const resolveLatestScrapeDir = (scrapesDir: string): string => {
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
