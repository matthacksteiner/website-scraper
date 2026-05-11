import { describe, expect, it } from 'bun:test';
import { MiniCdCollector } from '../src/mini_cd';

describe('MiniCdCollector', () => {
  it('extracts design tokens, breakpoints and headline styles', () => {
    const collector = new MiniCdCollector();

    collector.addCss(`
      body {
        font-family: 'Open Sans', Arial, sans-serif;
        color: rgb(255, 102, 0);
      }
      h1 {
        font: 700 32px/40px "Playfair Display", serif;
      }
      .card {
        background: linear-gradient(#fff, #00000080);
        padding: 16px 24px;
        border-radius: 12px;
      }
      @media (max-width: 768px) {
        h1 {
          font-size: 24px;
          line-height: 32px;
        }
      }
    `);

    collector.addHtml(`
      <html>
      <head>
        <link rel="stylesheet" href="/style.css" />
        <style>
          .chip { font-size: 14px; line-height: 1.4; }
        </style>
      </head>
      <body>
        <h1>Title</h1>
        <div style="margin: 8px; color: #abc"></div>
      </body>
      </html>
    `);

    const report = collector.buildReport('https://example.com');

    expect(report.colors.all.some((entry) => entry.value === '#ffffff')).toBeTrue();
    expect(report.colors.all.some((entry) => entry.value === '#00000080')).toBeTrue();
    expect(report.colors.all.some((entry) => entry.value === '#aabbcc')).toBeTrue();
    expect(report.colors.text.some((entry) => entry.value === '#aabbcc')).toBeTrue();
    expect(report.fonts.brand.some((entry) => entry.value === 'Open Sans')).toBeTrue();
    expect(report.fonts.brand.some((entry) => entry.value === 'Playfair Display')).toBeTrue();
    expect(report.fonts.generic.some((entry) => entry.value === 'sans-serif')).toBeTrue();
    expect(report.typography.fontSizes.some((entry) => entry.value === '32px')).toBeTrue();
    expect(report.typography.fontSizes.some((entry) => entry.value === '14px')).toBeTrue();
    expect(report.typography.fontWeights.some((entry) => entry.value === '700')).toBeTrue();
    expect(report.typography.lineHeights.some((entry) => entry.value === '40px')).toBeTrue();
    expect(report.layout.spacing.some((entry) => entry.value === '16px')).toBeTrue();
    expect(report.layout.spacing.some((entry) => entry.value === '8px')).toBeTrue();
    expect(report.layout.borderRadius.some((entry) => entry.value === '12px')).toBeTrue();
    expect(report.media.queries.some((entry) => entry.value === '(max-width: 768px)')).toBeTrue();
    expect(report.media.breakpoints.some((entry) => entry.value === 'max-width 768px')).toBeTrue();
    expect(
      report.headings.some(
        (entry) =>
          entry.heading === 'h1' &&
          entry.breakpoint.includes('max-width: 768px') &&
          entry.fontSizes.some((size) => size.value === '24px'),
      ),
    ).toBeTrue();

    expect(report.stats.html.pages).toBe(1);
    expect(report.stats.html.externalStylesheets).toBe(1);
  });
});
