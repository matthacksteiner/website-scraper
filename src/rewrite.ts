import path from "path";
import { load } from "cheerio";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { normalizeUrl } from "./url";

const isSkippableScheme = (value: string): boolean => {
  return (
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    value.startsWith("javascript:") ||
    value.startsWith("data:")
  );
};

const resolveUrl = (value: string, baseUrl: string): string | null => {
  if (!value || isSkippableScheme(value)) {
    return null;
  }
  try {
    return normalizeUrl(new URL(value, baseUrl).toString());
  } catch {
    return null;
  }
};

const toPosix = (value: string): string => value.split(path.sep).join("/");
const makeWordNode = (value: string) => ({
  type: "word" as const,
  value,
  sourceIndex: 0,
  sourceEndIndex: value.length,
});

export const rewriteHtml = (
  html: string,
  pageUrl: string,
  pagePath: string,
  resourceMap: Map<string, string>
): string => {
  const $ = load(html);
  const attributes = ["href", "src", "poster"];

  const rewriteAttr = (element: any, attr: string) => {
    const value = $(element).attr(attr);
    if (!value) return;
    const resolved = resolveUrl(value, pageUrl);
    if (!resolved) return;
    const localPath = resourceMap.get(resolved);
    if (!localPath) return;
    const relative = toPosix(path.relative(path.dirname(pagePath), localPath));
    $(element).attr(attr, relative || "./");
  };

  attributes.forEach((attr) => {
    $("[" + attr + "]").each((_, element) => rewriteAttr(element, attr));
  });

  $("[srcset]").each((_, element) => {
    const srcset = $(element).attr("srcset");
    if (!srcset) return;
    const rewritten = srcset
      .split(",")
      .map((candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed) return trimmed;
        const [urlPart, descriptor] = trimmed.split(/\s+/, 2);
        const resolved = resolveUrl(urlPart, pageUrl);
        if (!resolved) return trimmed;
        const localPath = resourceMap.get(resolved);
        if (!localPath) return trimmed;
        const relative = toPosix(path.relative(path.dirname(pagePath), localPath));
        return descriptor ? `${relative} ${descriptor}` : relative;
      })
      .join(", ");
    $(element).attr("srcset", rewritten);
  });

  return $.html();
};

export const inlineHtmlAssets = (
  html: string,
  pageUrl: string,
  pagePath: string,
  responses: Map<string, { contentType: string | null; body: Buffer }>,
  resourceMap: Map<string, string>
): string => {
  const $ = load(html);

  $("link[rel=\"stylesheet\"][href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const resolved = resolveUrl(href, pageUrl);
    if (!resolved) return;
    const response = responses.get(resolved);
    if (!response) return;
    if (response.contentType && !response.contentType.includes("text/css") && !resolved.endsWith(".css")) {
      return;
    }
    const styleTag = $("<style></style>");
    const rewritten = rewriteCss(
      response.body.toString("utf8"),
      resolved,
      pagePath,
      resourceMap
    );
    styleTag.text(rewritten);
    $(element).replaceWith(styleTag);
  });

  $("script[src]").each((_, element) => {
    const src = $(element).attr("src");
    if (!src) return;
    const resolved = resolveUrl(src, pageUrl);
    if (!resolved) return;
    const response = responses.get(resolved);
    if (!response) return;
    if (response.contentType && !response.contentType.includes("javascript") && !resolved.endsWith(".js")) {
      return;
    }
    const scriptTag = $("<script></script>");
    const typeAttr = $(element).attr("type");
    const nomodule = $(element).attr("nomodule");
    if (typeAttr) scriptTag.attr("type", typeAttr);
    if (nomodule !== undefined) scriptTag.attr("nomodule", "nomodule");
    scriptTag.text(response.body.toString("utf8"));
    $(element).replaceWith(scriptTag);
  });

  return $.html();
};

export const rewriteCss = (
  css: string,
  cssUrl: string,
  cssPath: string,
  resourceMap: Map<string, string>
): string => {
  const root = postcss.parse(css);

  root.walkDecls((decl) => {
    const parsed = valueParser(decl.value);
    parsed.walk((node) => {
      if (node.type === "function" && node.value === "url") {
        const inner = valueParser.stringify(node.nodes).trim();
        const cleaned = inner.replace(/^['"]|['"]$/g, "");
        const resolved = resolveUrl(cleaned, cssUrl);
        if (!resolved) {
          return false;
        }
        const localPath = resourceMap.get(resolved);
        if (!localPath) {
          return false;
        }
        const relative = toPosix(path.relative(path.dirname(cssPath), localPath));
        node.nodes = [makeWordNode(relative)];
      }
      return false;
    });
    decl.value = parsed.toString();
  });

  root.walkAtRules("import", (rule) => {
    const parsed = valueParser(rule.params);
    parsed.walk((node) => {
      if (node.type === "function" && node.value === "url") {
        const inner = valueParser.stringify(node.nodes).trim();
        const cleaned = inner.replace(/^['"]|['"]$/g, "");
        const resolved = resolveUrl(cleaned, cssUrl);
        if (!resolved) return false;
        const localPath = resourceMap.get(resolved);
        if (!localPath) return false;
        const relative = toPosix(path.relative(path.dirname(cssPath), localPath));
        node.nodes = [makeWordNode(relative)];
        return false;
      }
      if (node.type === "string") {
        const resolved = resolveUrl(node.value, cssUrl);
        if (!resolved) return false;
        const localPath = resourceMap.get(resolved);
        if (!localPath) return false;
        const relative = toPosix(path.relative(path.dirname(cssPath), localPath));
        node.value = relative;
        return false;
      }
      return false;
    });
    rule.params = parsed.toString();
  });

  return root.toString();
};
