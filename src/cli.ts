#!/usr/bin/env bun
import { Command } from 'commander';
import prompts from 'prompts';
import path from 'path';
import { Scraper } from './scraper';
import { parseIntOption } from './options';
import { ScrapeOptions, ScopeMode } from './types';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const collect = (value: string, previous: string[]): string[] => {
  return previous.concat([value]);
};

const formatTimestamp = (date: Date): string => {
  const pad2 = (value: number) => String(value).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
};

const program = new Command();
program
  .name('scrape')
  .description('State-of-the-art website scraper')
  .option('--url <url>', 'URL to scrape')
  .option('--subpages', 'Scrape subpages')
  .option('--scope <mode>', 'same-origin | subdomains | custom')
  .option('--include <glob>', 'Include glob for custom scope', collect, [])
  .option('--exclude <glob>', 'Exclude glob for custom scope', collect, [])
  .option('--max-pages <number>', 'Maximum pages to crawl', '50')
  .option('--max-depth <number>', 'Maximum crawl depth', '2')
  .option('--output <dir>', 'Output directory')
  .option('--single-file', 'Inline CSS/JS/images/fonts into each HTML file', false)
  .option(
    '--no-single-file',
    'Save HTML that references local assets instead of inlining',
  )
  .option('--strip-consent', 'Remove common cookie/consent overlays', true)
  .option('--no-strip-consent', 'Keep cookie/consent overlays')
  .option('--respect-robots', 'Respect robots.txt', true)
  .option('--no-respect-robots', 'Ignore robots.txt')
  .option('--delay-ms <number>', 'Delay between page fetches', '500')
  .option('--concurrency <number>', 'Concurrent page fetches', '2')
  .option('--user-agent <string>', 'Custom user-agent string')
  .option('--timeout-ms <number>', 'Navigation timeout in ms', '30000')
  .option('--skill', 'Generate a Claude Code design skill (default)', true)
  .option('--no-skill', 'Skip design skill generation');

const main = async () => {
  const rawArgs = process.argv.slice(2);
  const hasNoSubpages = rawArgs.includes('--no-subpages');
  const singleFileFlagIndex = rawArgs.lastIndexOf('--single-file');
  const noSingleFileFlagIndex = rawArgs.lastIndexOf('--no-single-file');
  const hasStripConsentFlag =
    rawArgs.includes('--strip-consent') || rawArgs.includes('--no-strip-consent');
  const filteredArgs = rawArgs.filter((arg) => arg !== '--no-subpages');
  program.parse(['node', 'scrape', ...filteredArgs]);
  const opts = program.opts();

  const responses: Record<string, unknown> = {};

  if (!opts.url) {
    const answer = await prompts({
      type: 'text',
      name: 'url',
      message: 'Enter the URL to scrape',
      validate: (value) => (value ? true : 'URL is required'),
    });
    responses.url = answer.url;
  } else {
    responses.url = opts.url;
  }

  if (hasNoSubpages) {
    responses.subpages = false;
  } else if (opts.subpages === undefined) {
    const answer = await prompts({
      type: 'confirm',
      name: 'subpages',
      message: 'Scrape subpages?',
      initial: false,
    });
    responses.subpages = answer.subpages;
  } else {
    responses.subpages = opts.subpages;
  }

  if (singleFileFlagIndex !== -1 || noSingleFileFlagIndex !== -1) {
    responses.singleFile = singleFileFlagIndex > noSingleFileFlagIndex;
  } else {
    const answer = await prompts({
      type: 'select',
      name: 'singleFile',
      message: 'Snapshot mode',
      choices: [
        {
          title: 'No single-file (smaller output, references local assets)',
          value: false,
        },
        {
          title: 'Single-file (inline CSS/images/fonts into each HTML)',
          value: true,
        },
      ],
      initial: 0,
    });
    responses.singleFile = answer.singleFile ?? false;
  }

  if (hasStripConsentFlag) {
    responses.stripConsent = Boolean(opts.stripConsent);
  } else {
    const answer = await prompts({
      type: 'confirm',
      name: 'stripConsent',
      message: 'Remove cookie/consent banners?',
      initial: true,
    });
    responses.stripConsent = answer.stripConsent ?? true;
  }

  let scope: ScopeMode = 'same-origin';
  let include: string[] = opts.include ?? [];
  let exclude: string[] = opts.exclude ?? [];

  if (responses.subpages) {
    if (!opts.scope) {
      const answer = await prompts({
        type: 'select',
        name: 'scope',
        message: 'Scope for subpages',
        choices: [
          { title: 'Same origin only', value: 'same-origin' },
          { title: 'Include subdomains', value: 'subdomains' },
          { title: 'Custom include/exclude', value: 'custom' },
        ],
        initial: 0,
      });
      scope = (answer.scope as ScopeMode) || 'same-origin';
    } else {
      const requested = String(opts.scope);
      if (
        requested === 'same-origin' ||
        requested === 'subdomains' ||
        requested === 'custom'
      ) {
        scope = requested;
      } else {
        scope = 'same-origin';
      }
    }

    if (scope === 'custom') {
      if (include.length === 0) {
        const answer = await prompts({
          type: 'text',
          name: 'include',
          message: 'Include globs (comma-separated, optional)',
        });
        include = answer.include
          ? String(answer.include)
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : [];
      }
      if (exclude.length === 0) {
        const answer = await prompts({
          type: 'text',
          name: 'exclude',
          message: 'Exclude globs (comma-separated, optional)',
        });
        exclude = answer.exclude
          ? String(answer.exclude)
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : [];
      }
    }
  }

  const url = String(responses.url);
  const parsed = new URL(url);
  const timestamp = formatTimestamp(new Date());
  const defaultOutput = path.resolve(
    process.cwd(),
    'scraped_sites',
    `scrape-${parsed.hostname}-${timestamp}`,
  );

  const options: ScrapeOptions = {
    url,
    subpages: Boolean(responses.subpages),
    scope,
    include,
    exclude,
    maxPages: parseIntOption(opts.maxPages, 50, 1),
    maxDepth: parseIntOption(opts.maxDepth, 2, 0),
    output: opts.output ? path.resolve(opts.output) : defaultOutput,
    singleFile: Boolean(responses.singleFile),
    stripConsent: Boolean(responses.stripConsent),
    respectRobots: Boolean(opts.respectRobots),
    delayMs: parseIntOption(opts.delayMs, 500, 0),
    concurrency: parseIntOption(opts.concurrency, 2, 1),
    userAgent: opts.userAgent || DEFAULT_USER_AGENT,
    timeoutMs: parseIntOption(opts.timeoutMs, 30000, 1),
    skill: Boolean(opts.skill),
  };

  const scraper = new Scraper(options);
  await scraper.run();

  console.log(`Scrape complete. Output: ${options.output}`);
};

main().catch((error) => {
  console.error('Scrape failed:', error);
  process.exitCode = 1;
});
