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

export interface VerifyConsoleMessage {
  text: string;
  location?: string; // "url:line" wenn vorhanden
}

export interface VerifyRequestIssue {
  url: string;
  origin: 'local' | 'external'; // lokaler Server vs. fremder Host
  method?: string;
  resourceType?: string;
  status?: number; // bei 4xx/5xx-Response
  errorText?: string; // bei requestfailed
}

export interface VerifyPageResult {
  url: string; // ursprüngliche Remote-URL
  localUrl: string; // http://127.0.0.1:<port>/...
  path: string; // Snapshot-Pfad, relativ zum Scrape-Root (posix)
  navigated: boolean;
  navigationError?: string;
  consoleErrors: VerifyConsoleMessage[];
  consoleWarnings: VerifyConsoleMessage[];
  pageErrors: VerifyConsoleMessage[];
  localFailedRequests: VerifyRequestIssue[]; // actionable
  externalFailedRequests: VerifyRequestIssue[]; // informativ
}

export interface VerifyReport {
  generatedAt: string;
  rootDir: string;
  pagesChecked: number;
  totals: {
    // actionable
    localFailedRequests: number;
    pagesWithLocalFailures: number;
    // informativ
    externalFailedRequests: number;
    consoleErrors: number;
    consoleWarnings: number;
    pageErrors: number;
  };
  pages: VerifyPageResult[];
}
