import { describe, expect, it } from 'bun:test';
import {
  buildVerifyReport,
  classifyRequestOrigin,
  renderVerifyMarkdown,
  renderVerifySummary,
  splitRequestIssues,
} from '../src/verify';
import { VerifyPageResult, VerifyRequestIssue } from '../src/types';

const makePage = (overrides: Partial<VerifyPageResult> = {}): VerifyPageResult => ({
  url: 'https://example.com/',
  localUrl: 'http://127.0.0.1:1234/pages/index.html',
  path: 'pages/index.html',
  navigated: true,
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  localFailedRequests: [],
  externalFailedRequests: [],
  ...overrides,
});

const meta = { rootDir: '/tmp/scrape', generatedAt: '2026-07-15T00:00:00.000Z' };

describe('classifyRequestOrigin', () => {
  it('marks requests to the local server as local', () => {
    expect(
      classifyRequestOrigin('http://127.0.0.1:4173/assets/x.css', '127.0.0.1', 4173),
    ).toBe('local');
    expect(classifyRequestOrigin('http://localhost:4173/a.js', '127.0.0.1', 4173)).toBe(
      'local',
    );
  });

  it('marks other hosts and ports as external', () => {
    expect(classifyRequestOrigin('https://cdn.example.com/x.js', '127.0.0.1', 4173)).toBe(
      'external',
    );
    // same host, different port
    expect(classifyRequestOrigin('http://127.0.0.1:9999/x.js', '127.0.0.1', 4173)).toBe(
      'external',
    );
  });

  it('treats non-http(s) and unparseable URLs as external', () => {
    expect(classifyRequestOrigin('data:image/png;base64,AAAA', '127.0.0.1', 4173)).toBe(
      'external',
    );
    expect(classifyRequestOrigin('not a url', '127.0.0.1', 4173)).toBe('external');
  });
});

describe('splitRequestIssues', () => {
  it('collapses a 404 and its follow-up net::ERR_ABORTED into one issue', () => {
    const url = 'http://127.0.0.1:1/pages/assets/chunk.esm.js';
    const issues: VerifyRequestIssue[] = [
      { url, origin: 'local', status: 404, resourceType: 'script' },
      { url, origin: 'local', errorText: 'net::ERR_ABORTED', resourceType: 'script' },
    ];
    const { local, external } = splitRequestIssues(issues);
    expect(local).toHaveLength(1);
    expect(local[0].status).toBe(404); // HTTP status wins over errorText
    expect(external).toHaveLength(0);
  });

  it('keeps distinct urls and separates local from external', () => {
    const issues: VerifyRequestIssue[] = [
      { url: 'http://127.0.0.1:1/a.js', origin: 'local', status: 404 },
      { url: 'http://127.0.0.1:1/b.js', origin: 'local', status: 404 },
      { url: 'https://cdn.example.com/c.js', origin: 'external', status: 500 },
    ];
    const { local, external } = splitRequestIssues(issues);
    expect(local).toHaveLength(2);
    expect(external).toHaveLength(1);
  });

  it('keeps an errorText-only issue when there is no HTTP status', () => {
    const issues: VerifyRequestIssue[] = [
      {
        url: 'http://127.0.0.1:1/x.js',
        origin: 'local',
        errorText: 'net::ERR_FAILED',
      },
    ];
    const { local } = splitRequestIssues(issues);
    expect(local).toHaveLength(1);
    expect(local[0].errorText).toBe('net::ERR_FAILED');
  });
});

describe('buildVerifyReport', () => {
  it('aggregates totals across pages', () => {
    const pages = [
      makePage({
        localFailedRequests: [
          { url: 'http://127.0.0.1:1/a.css', origin: 'local', status: 404 },
          { url: 'http://127.0.0.1:1/b.woff2', origin: 'local', status: 404 },
        ],
        consoleErrors: [{ text: 'boom' }],
        externalFailedRequests: [
          { url: 'https://cdn.example.com/x.js', origin: 'external', status: 503 },
        ],
      }),
      makePage({
        url: 'https://example.com/about',
        pageErrors: [{ text: 'TypeError' }, { text: 'ReferenceError' }],
        consoleWarnings: [{ text: 'deprecated' }],
      }),
    ];

    const report = buildVerifyReport(pages, meta);

    expect(report.pagesChecked).toBe(2);
    expect(report.totals.localFailedRequests).toBe(2);
    expect(report.totals.pagesWithLocalFailures).toBe(1);
    expect(report.totals.externalFailedRequests).toBe(1);
    expect(report.totals.consoleErrors).toBe(1);
    expect(report.totals.consoleWarnings).toBe(1);
    expect(report.totals.pageErrors).toBe(2);
    expect(report.generatedAt).toBe(meta.generatedAt);
  });

  it('reports zeroed totals for a clean scrape', () => {
    const report = buildVerifyReport([makePage()], meta);
    expect(report.totals.localFailedRequests).toBe(0);
    expect(report.totals.pagesWithLocalFailures).toBe(0);
  });
});

describe('renderVerifySummary', () => {
  it('headlines the actionable local signal when present', () => {
    const report = buildVerifyReport(
      [
        makePage({
          localFailedRequests: [
            { url: 'http://127.0.0.1:1/a.css', origin: 'local', status: 404 },
          ],
          consoleErrors: [{ text: 'boom' }],
        }),
      ],
      meta,
    );
    const summary = renderVerifySummary(report);
    expect(summary).toContain('1 fehlende lokale Ressource(n)');
    expect(summary).toContain('actionable');
  });

  it('states no local problems for a clean scrape', () => {
    const summary = renderVerifySummary(buildVerifyReport([makePage()], meta));
    expect(summary).toContain('keine fehlenden lokalen Ressourcen');
  });
});

describe('renderVerifyMarkdown', () => {
  it('lists local failures under the actionable section', () => {
    const report = buildVerifyReport(
      [
        makePage({
          localFailedRequests: [
            {
              url: 'http://127.0.0.1:1/assets/x.woff2',
              origin: 'local',
              status: 404,
              resourceType: 'font',
            },
          ],
        }),
      ],
      meta,
    );
    const md = renderVerifyMarkdown(report);
    expect(md).toContain('## Actionable — fehlende lokale Ressourcen');
    expect(md).toContain('assets/x.woff2');
    expect(md).toContain('HTTP 404');
    expect(md).toContain('### https://example.com/');
  });

  it('marks a clean scrape with a check and no per-page section', () => {
    const md = renderVerifyMarkdown(buildVerifyReport([makePage()], meta));
    expect(md).toContain('Keine fehlenden lokalen Ressourcen. ✅');
    expect(md).not.toContain('### https://example.com/');
  });

  it('records navigation failures in the informative details', () => {
    const report = buildVerifyReport(
      [makePage({ navigated: false, navigationError: 'Timeout 30000ms exceeded' })],
      meta,
    );
    const md = renderVerifyMarkdown(report);
    expect(md).toContain('Navigation fehlgeschlagen: Timeout 30000ms exceeded');
  });
});
