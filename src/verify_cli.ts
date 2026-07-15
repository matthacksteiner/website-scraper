#!/usr/bin/env node
import path from 'path';
import { Command } from 'commander';
import { resolveLatestScrapeDir } from './scrape_dirs';
import { renderVerifySummary, verifyScrape, writeVerifyReport } from './verify';

const toNumber = (value: string, fallback: number, min: number): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed < min ? min : parsed;
};

const program = new Command();
program
  .name('scrape-verify')
  .description(
    'Verify a scrape output by loading every page like `npx http-server` would',
  )
  .option('--dir <dir>', 'Scrape output directory', '.')
  .option('--latest', 'Verify the most recent scrape output directory', false)
  .option(
    '--scrapes-dir <dir>',
    'Directory that contains scrape output folders (used with --latest)',
    'scraped_sites',
  )
  .option('--concurrency <number>', 'Concurrent page checks', '2')
  .option('--timeout-ms <number>', 'Navigation timeout in ms', '30000');

program.parse(process.argv);
const opts = program.opts();

const main = async (): Promise<void> => {
  let rootDir = path.resolve(String(opts.dir));
  if (opts.latest) {
    rootDir = resolveLatestScrapeDir(String(opts.scrapesDir));
    console.log(`Latest scrape selected: ${rootDir}`);
  }

  const report = await verifyScrape(rootDir, {
    concurrency: toNumber(String(opts.concurrency), 2, 1),
    timeoutMs: toNumber(String(opts.timeoutMs), 30000, 1),
  });
  const { mdPath } = await writeVerifyReport(rootDir, report);

  console.log(renderVerifySummary(report));
  console.log(`Details: ${mdPath}`);
};

main().catch((error) => {
  console.error('Verify failed:', error);
  process.exitCode = 1;
});
