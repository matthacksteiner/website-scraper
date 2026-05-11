import { describe, expect, it } from 'bun:test';
import { MiniCdCollector } from '../src/mini_cd';
import { renderDesignMarkdown } from '../src/design_md';

const sampleCss = `
  :root {
    --brand: #2563eb;
  }
  body {
    font-family: 'Inter', sans-serif;
    color: #1f2937;
    background: #ffffff;
    font-size: 16px;
    line-height: 1.5;
  }
  h1 {
    font-family: 'Playfair Display', serif;
    font-size: 48px;
    font-weight: 700;
    line-height: 56px;
    color: #111827;
  }
  h2 {
    font-family: 'Inter', sans-serif;
    font-size: 32px;
    font-weight: 600;
    line-height: 40px;
  }
  .btn {
    background: #2563eb;
    color: #ffffff;
    padding: 12px 24px;
    border-radius: 8px;
    border: 1px solid #1d4ed8;
  }
  .card {
    background: #f9fafb;
    border-radius: 16px;
    padding: 24px;
    border: 1px solid #e5e7eb;
  }
  .muted {
    color: #6b7280;
  }
  @media (max-width: 768px) {
    h1 { font-size: 32px; }
  }
`;

describe('renderDesignMarkdown', () => {
  const collector = new MiniCdCollector();
  collector.addCss(sampleCss);
  const report = collector.buildReport('https://example.com');
  const output = renderDesignMarkdown(report);

  it('starts with YAML front matter', () => {
    expect(output.startsWith('---\n')).toBeTrue();
    expect(output).toContain('\n---\n');
    expect(output).toContain('version: alpha');
  });

  it('includes a derived name from the source URL', () => {
    expect(output).toContain('name: example.com');
  });

  it('emits color tokens with a chromatic primary', () => {
    expect(output).toMatch(/colors:\n/);
    expect(output).toContain('primary: "#2563eb"');
    expect(output).toMatch(/text: "#(1f2937|111827)"/);
  });

  it('emits typography tokens for display and body', () => {
    expect(output).toContain('typography:');
    expect(output).toContain('display:');
    expect(output).toContain('body:');
    expect(output).toMatch(/fontFamily: (Inter|"Playfair Display"|Playfair Display)/);
  });

  it('emits a rounded scale ending in full', () => {
    expect(output).toContain('rounded:');
    expect(output).toContain('full: 9999px');
  });

  it('emits a spacing scale', () => {
    expect(output).toContain('spacing:');
  });

  it('contains the canonical markdown sections in order', () => {
    const sections = [
      '## Overview',
      '## Colors',
      '## Typography',
      '## Layout',
      '## Elevation & Depth',
      '## Shapes',
      '## Components',
      "## Do's and Don'ts",
    ];
    let lastIndex = -1;
    for (const heading of sections) {
      const index = output.indexOf(heading);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });
});
