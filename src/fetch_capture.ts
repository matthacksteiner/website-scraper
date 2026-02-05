import { load } from "cheerio";
import { CapturedResponse } from "./types";
import { normalizeUrl } from "./url";

export interface CapturedPage {
  html: string;
  status: number | null;
  contentType: string | null;
  responses: CapturedResponse[];
}

const isSkippable = (value: string): boolean => {
  return (
    value.startsWith("data:") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    value.startsWith("javascript:")
  );
};

const resolveUrl = (value: string, baseUrl: string): string | null => {
  if (!value || isSkippable(value)) return null;
  try {
    return normalizeUrl(new URL(value, baseUrl).toString());
  } catch {
    return null;
  }
};

const collectAssetUrls = (html: string, baseUrl: string): string[] => {
  const $ = load(html);
  const assets = new Set<string>();

  $("link[rel=\"stylesheet\"][href]").each((_, el) => {
    const href = $(el).attr("href");
    const resolved = href ? resolveUrl(href, baseUrl) : null;
    if (resolved) assets.add(resolved);
  });

  $("script[src]").each((_, el) => {
    const src = $(el).attr("src");
    const resolved = src ? resolveUrl(src, baseUrl) : null;
    if (resolved) assets.add(resolved);
  });

  $("img[src], source[src], video[poster]").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("poster");
    const resolved = src ? resolveUrl(src, baseUrl) : null;
    if (resolved) assets.add(resolved);
  });

  $("[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset");
    if (!srcset) return;
    srcset.split(",").forEach((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return;
      const [urlPart] = trimmed.split(/\s+/, 2);
      const resolved = resolveUrl(urlPart, baseUrl);
      if (resolved) assets.add(resolved);
    });
  });

  return Array.from(assets);
};

const fetchBinary = async (url: string, userAgent: string, timeoutMs: number) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        "Accept": "*/*",
      },
      signal: controller.signal,
    });
    const arrayBuffer = await res.arrayBuffer();
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: Buffer.from(arrayBuffer),
    };
  } finally {
    clearTimeout(timeout);
  }
};

export const capturePageFetch = async (
  url: string,
  userAgent: string,
  timeoutMs: number
): Promise<CapturedPage> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let html = "";
  let status: number | null = null;
  let contentType: string | null = null;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    status = res.status;
    contentType = res.headers.get("content-type");
    html = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  const assetUrls = collectAssetUrls(html, url);
  const responses: CapturedResponse[] = [];
  const seen = new Set<string>();

  for (const assetUrl of assetUrls) {
    if (seen.has(assetUrl)) continue;
    seen.add(assetUrl);
    try {
      const result = await fetchBinary(assetUrl, userAgent, timeoutMs);
      responses.push({
        url: assetUrl,
        status: result.status,
        contentType: result.contentType,
        body: result.body,
      });
    } catch {
      continue;
    }
  }

  return { html, status, contentType, responses };
};
