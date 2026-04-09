export type ScopeMode = 'same-origin' | 'subdomains' | 'custom';

export interface ScrapeOptions {
  url: string;
  subpages: boolean;
  scope: ScopeMode;
  include: string[];
  exclude: string[];
  maxPages: number;
  maxDepth: number;
  output: string;
  singleFile: boolean;
  stripConsent: boolean;
  respectRobots: boolean;
  delayMs: number;
  concurrency: number;
  userAgent: string;
  timeoutMs: number;
  skill: boolean;
}

export interface PageEntry {
  url: string;
  path: string;
  depth: number;
  status: number | null;
  contentType: string | null;
  timestamp: string;
}

export interface AssetEntry {
  url: string;
  path: string;
  contentType: string | null;
  size: number;
  hash: string;
}

export interface ErrorEntry {
  url: string;
  error: string;
  phase: string;
  timestamp: string;
}

export interface Manifest {
  startedAt: string;
  finishedAt?: string;
  options: ScrapeOptions;
  pages: PageEntry[];
  assets: AssetEntry[];
  errors: ErrorEntry[];
}

export interface CapturedResponse {
  url: string;
  status: number;
  contentType: string | null;
  body: Buffer;
}

export interface ComputedHeadingSnapshot {
  heading: string;
  breakpoint: string;
  fontFamilies: Record<string, number>;
  fontSizes: Record<string, number>;
  fontWeights: Record<string, number>;
  lineHeights: Record<string, number>;
}

export interface ComputedStyleSnapshot {
  html: {
    elements: number;
    externalStylesheets: number;
    inlineStyleElements: number;
    inlineStyleAttributes: number;
  };
  used: {
    colors: {
      text: Record<string, number>;
      background: Record<string, number>;
      border: Record<string, number>;
      fill: Record<string, number>;
    };
    typography: {
      fontFamilies: Record<string, number>;
      fontSizes: Record<string, number>;
      fontWeights: Record<string, number>;
      lineHeights: Record<string, number>;
    };
    layout: {
      spacing: Record<string, number>;
      borderRadius: Record<string, number>;
    };
  };
  headings: ComputedHeadingSnapshot[];
}
