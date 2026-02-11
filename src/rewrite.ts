import path from "path";
import { load } from "cheerio";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { readFileSync } from "fs";
import * as mime from "mime-types";
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
  if (value.startsWith("#")) {
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

const looksLikeHtml = (contentType: string | null, url: string): boolean => {
  if (contentType && contentType.toLowerCase().includes("text/html")) return true;
  const lower = url.split("#")[0].split("?")[0].toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
};

const getMimeType = (contentType: string | null, url: string): string => {
  const fromHeader = contentType ? contentType.split(";")[0].trim() : "";
  if (fromHeader) return fromHeader;
  const guessed = mime.lookup(url.split("#")[0].split("?")[0]);
  return (typeof guessed === "string" && guessed) ? guessed : "application/octet-stream";
};

const toDataUrl = (body: Buffer, mimeType: string): string => {
  const base64 = body.toString("base64");
  return `data:${mimeType};base64,${base64}`;
};

const splitUrlForFile = (value: string): { filePart: string; fragment: string } => {
  const [beforeHash, hash] = value.split("#", 2);
  const [beforeQuery] = beforeHash.split("?", 2);
  return { filePart: beforeQuery, fragment: hash ? `#${hash}` : "" };
};

const splitUrlAndFragment = (value: string): { urlPart: string; fragment: string } => {
  const index = value.indexOf("#");
  if (index === -1) return { urlPart: value, fragment: "" };
  return { urlPart: value.slice(0, index), fragment: value.slice(index) };
};

const isLocalRelativeRef = (value: string): boolean => {
  if (!value) return false;
  if (isSkippableScheme(value)) return false;
  if (value.startsWith("#")) return false;
  if (value.startsWith("//")) return false;
  if (value.includes("://")) return false;
  if (value.startsWith("/")) return false;
  return true;
};

const tryInlineLocalRelative = (value: string, basePath: string): string | null => {
  if (!isLocalRelativeRef(value)) return null;
  const { filePart, fragment } = splitUrlForFile(value);
  const absolute = path.resolve(path.dirname(basePath), filePart);
  try {
    const body = readFileSync(absolute);
    const guessed = mime.lookup(absolute);
    const mimeType = typeof guessed === "string" && guessed ? guessed : "application/octet-stream";
    return `${toDataUrl(body, mimeType)}${fragment}`;
  } catch {
    return null;
  }
};

const tryGetAssetBody = (
  resolvedUrl: string,
  responses: Map<string, { contentType: string | null; body: Buffer }> | undefined,
  resourceMap: Map<string, string>
): { contentType: string | null; body: Buffer } | null => {
  const fromResponse = responses?.get(resolvedUrl);
  if (fromResponse) return fromResponse;

  const localPath = resourceMap.get(resolvedUrl);
  if (!localPath) return null;
  try {
    const body = readFileSync(localPath);
    return { contentType: null, body };
  } catch {
    return null;
  }
};

export const rewriteCss = (
  css: string,
  cssUrl: string,
  cssPath: string,
  resourceMap: Map<string, string>,
  responses?: Map<string, { contentType: string | null; body: Buffer }>,
  singleFile?: boolean,
  importDepth = 0
): string => {
  const root = postcss.parse(css);

  const inlineResolvedUrl = (resolvedUrl: string): string | null => {
    const asset = tryGetAssetBody(resolvedUrl, responses, resourceMap);
    if (!asset) return null;
    const mimeType = getMimeType(asset.contentType, resolvedUrl);
    if (looksLikeHtml(asset.contentType, resolvedUrl)) return null;
    return toDataUrl(asset.body, mimeType);
  };

  const rewriteResolvedUrl = (resolvedUrl: string): string => {
    if (singleFile) {
      return inlineResolvedUrl(resolvedUrl) ?? resolvedUrl;
    }
    const localPath = resourceMap.get(resolvedUrl);
    if (!localPath) return resolvedUrl;
    const relative = toPosix(path.relative(path.dirname(cssPath), localPath));
    return relative || "./";
  };

  root.walkDecls((decl) => {
    const parsed = valueParser(decl.value);
    parsed.walk((node) => {
      if (node.type === "function" && node.value === "url") {
        const inner = valueParser.stringify(node.nodes).trim();
        const cleaned = inner.replace(/^['"]|['"]$/g, "");
        if (singleFile) {
          const inlinedLocal = tryInlineLocalRelative(cleaned, cssPath);
          if (inlinedLocal) {
            node.nodes = [makeWordNode(inlinedLocal)];
            return false;
          }
        }
        const { urlPart, fragment } = splitUrlAndFragment(cleaned);
        const resolved = resolveUrl(urlPart, cssUrl);
        if (!resolved) {
          return false;
        }
        const replacement = `${rewriteResolvedUrl(resolved)}${fragment}`;
        node.nodes = [makeWordNode(replacement)];
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
        if (singleFile) {
          const inlinedLocal = tryInlineLocalRelative(cleaned, cssPath);
          if (inlinedLocal) {
            node.nodes = [makeWordNode(inlinedLocal)];
            return false;
          }
        }
        const { urlPart, fragment } = splitUrlAndFragment(cleaned);
        const resolved = resolveUrl(urlPart, cssUrl);
        if (!resolved) return false;
        if (singleFile && importDepth < 5) {
          const asset = tryGetAssetBody(resolved, responses, resourceMap);
          if (asset) {
            const nestedCss = asset.body.toString("utf8");
            const rewrittenNested = rewriteCss(
              nestedCss,
              resolved,
              cssPath,
              resourceMap,
              responses,
              true,
              importDepth + 1
            );
            node.nodes = [makeWordNode(toDataUrl(Buffer.from(rewrittenNested, "utf8"), "text/css"))];
            return false;
          }
        }
        const replacement = `${rewriteResolvedUrl(resolved)}${fragment}`;
        node.nodes = [makeWordNode(replacement)];
        return false;
      }
      if (node.type === "string") {
        if (singleFile) {
          const inlinedLocal = tryInlineLocalRelative(node.value, cssPath);
          if (inlinedLocal) {
            node.value = inlinedLocal;
            return false;
          }
        }
        const { urlPart, fragment } = splitUrlAndFragment(node.value);
        const resolved = resolveUrl(urlPart, cssUrl);
        if (!resolved) return false;
        if (singleFile && importDepth < 5) {
          const asset = tryGetAssetBody(resolved, responses, resourceMap);
          if (asset) {
            const nestedCss = asset.body.toString("utf8");
            const rewrittenNested = rewriteCss(
              nestedCss,
              resolved,
              cssPath,
              resourceMap,
              responses,
              true,
              importDepth + 1
            );
            node.value = toDataUrl(Buffer.from(rewrittenNested, "utf8"), "text/css");
            return false;
          }
        }
        const replacement = `${rewriteResolvedUrl(resolved)}${fragment}`;
        node.value = replacement;
        return false;
      }
      return false;
    });
    rule.params = parsed.toString();
  });

  return root.toString();
};

const rewriteInlineStyleValue = (
  value: string,
  baseUrl: string,
  pagePath: string,
  resourceMap: Map<string, string>,
  responses: Map<string, { contentType: string | null; body: Buffer }> | undefined,
  singleFile: boolean
): string => {
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type === "function" && node.value === "url") {
      const inner = valueParser.stringify(node.nodes).trim();
      const cleaned = inner.replace(/^['"]|['"]$/g, "");
      if (singleFile) {
        const inlinedLocal = tryInlineLocalRelative(cleaned, pagePath);
        if (inlinedLocal) {
          node.nodes = [makeWordNode(inlinedLocal)];
          return false;
        }
      }
      const { urlPart, fragment } = splitUrlAndFragment(cleaned);
      const resolved = resolveUrl(urlPart, baseUrl);
      if (!resolved) return false;
      if (singleFile) {
        const asset = tryGetAssetBody(resolved, responses, resourceMap);
        if (!asset || looksLikeHtml(asset.contentType, resolved)) {
          node.nodes = [makeWordNode(`${resolved}${fragment}`)];
          return false;
        }
        node.nodes = [
          makeWordNode(`${toDataUrl(asset.body, getMimeType(asset.contentType, resolved))}${fragment}`),
        ];
      } else {
        const localPath = resourceMap.get(resolved);
        if (localPath) {
          const relative = toPosix(path.relative(path.dirname(pagePath), localPath));
          node.nodes = [makeWordNode(`${relative || "./"}${fragment}`)];
        } else {
          node.nodes = [makeWordNode(`${resolved}${fragment}`)];
        }
      }
      return false;
    }
    return false;
  });
  return parsed.toString();
};

export const rewriteHtml = (
  html: string,
  pageUrl: string,
  pagePath: string,
  resourceMap: Map<string, string>,
  responses: Map<string, { contentType: string | null; body: Buffer }>,
  singleFile: boolean,
  stripConsent: boolean
): string => {
  const $ = load(html);
  const attributes = [
    "href",
    "src",
    "poster",
    "xlink:href",
    // Common lazy-loading/background-image attributes used by site builders and themes.
    "data-src",
    "data-lazy",
    "data-lazy-src",
    "data-original",
    "data-bg",
    "data-bg-src",
    "data-background",
    "data-background-image",
    "data-nectar-img-src",
  ];

  const shouldInlineAttr = (element: any, attr: string, resolvedUrl: string): boolean => {
    if (!singleFile) return false;
    const tag = String((element as any)?.tagName || (element as any)?.name || "").toLowerCase();
    if ((tag === "a" || tag === "area") && attr === "href") return false;
    if (tag === "link" && attr === "href") {
      const rel = String($(element).attr("rel") || "").toLowerCase();
      if (rel.includes("icon") || rel.includes("apple-touch-icon")) return true;
      return false;
    }
    if (tag === "use" && (attr === "xlink:href" || attr === "href")) return true;
    if (attr === "src" || attr === "poster") return true;

    const lower = resolvedUrl.split("#")[0].split("?")[0].toLowerCase();
    if (lower.match(/\.(png|jpe?g|gif|webp|svg|avif|ico)$/)) return true;
    if (lower.match(/\.(woff2?|ttf|otf|eot)$/)) return true;
    return false;
  };

  const rewriteAttr = (element: any, attr: string) => {
    const value = $(element).attr(attr);
    if (!value) return;
    const { urlPart, fragment } = splitUrlAndFragment(value);
    if (singleFile) {
      if (shouldInlineAttr(element, attr, value)) {
        const localDataUrl = tryInlineLocalRelative(value, pagePath);
        if (localDataUrl) {
          $(element).attr(attr, localDataUrl);
          return;
        }
      }
    }
    const resolved = resolveUrl(urlPart, pageUrl);
    if (!resolved) return;
    if (shouldInlineAttr(element, attr, resolved)) {
      const asset = tryGetAssetBody(resolved, responses, resourceMap);
      if (!asset) return;
      if (looksLikeHtml(asset.contentType, resolved)) return;
      $(element).attr(
        attr,
        `${toDataUrl(asset.body, getMimeType(asset.contentType, resolved))}${fragment}`
      );
      // Inlined resources won't match integrity hashes and don't need CORS metadata.
      $(element).removeAttr("integrity");
      $(element).removeAttr("crossorigin");
      return;
    }

    const tag = String((element as any)?.tagName || (element as any)?.name || "").toLowerCase();
    if (singleFile && tag === "link" && attr === "href") {
      const rel = String($(element).attr("rel") || "").toLowerCase();
      if (rel.includes("stylesheet")) {
        $(element).attr(attr, `${resolved}${fragment}`);
        return;
      }
    }

    const localPath = resourceMap.get(resolved);
    if (localPath) {
      const relative = toPosix(path.relative(path.dirname(pagePath), localPath));
      $(element).attr(attr, `${relative || "./"}${fragment}`);
      return;
    }

    $(element).attr(attr, `${resolved}${fragment}`);
  };

  attributes.forEach((attr) => {
    const selectorAttr = attr.includes(":") ? attr.replace(/:/g, "\\:") : attr;
    $("[" + selectorAttr + "]").each((_, element) => rewriteAttr(element, attr));
  });

  const lazyImgSrcAttrs = ["data-nectar-img-src", "data-src", "data-lazy-src", "data-original", "data-lazy"];
  const lazyImgSrcsetAttrs = ["data-nectar-img-srcset", "data-srcset", "data-lazy-srcset"];

  const looksLikePlaceholderImgSrc = (value: string): boolean => {
    const src = String(value || "").trim();
    if (!src || src === "#") return true;
    if (src.startsWith("data:image/gif")) return true;
    if (src.startsWith("data:image/svg+xml")) return true;
    if (src.startsWith("data:image/")) {
      // In single-file mode we inline real images as `data:` URLs, which can be very large.
      // Treat only very small `data:` images as placeholders.
      return src.length < 2048;
    }
    if (src.startsWith("data:,")) return true;
    if (src === "about:blank") return true;
    return false;
  };

  // Materialize common lazy-load attributes into actual `src` so snapshots render without JS.
  $("img").each((_, element) => {
    const currentSrc = String($(element).attr("src") || "");
    let lazyValue: string | null = null;
    for (const attr of lazyImgSrcAttrs) {
      const value = $(element).attr(attr);
      if (value) {
        lazyValue = value;
        break;
      }
    }
    if (!lazyValue) return;

    if (!looksLikePlaceholderImgSrc(currentSrc)) {
      const className = String($(element).attr("class") || "").toLowerCase();
      const looksLazy =
        className.includes("lazy") ||
        className.includes("lazyload") ||
        className.includes("nectar-lazy") ||
        $(element).attr("loading") === "lazy";
      if (!looksLazy) {
        return;
      }
    }

    $(element).attr("src", lazyValue);
    lazyImgSrcAttrs.forEach((attr) => $(element).removeAttr(attr));
    lazyImgSrcsetAttrs.forEach((attr) => $(element).removeAttr(attr));
    rewriteAttr(element, "src");

    if (singleFile) {
      $(element).removeAttr("srcset");
      $(element).removeAttr("sizes");
    }
  });

  $("[srcset]").each((_, element) => {
    const srcset = $(element).attr("srcset");
    if (!srcset) return;

    // `srcset` uses commas to separate candidates. Data URLs contain commas by design,
    // so browsers (notably Chrome) will misparse data URLs inside `srcset` and attempt
    // to load the base64 payload as a relative URL when viewing snapshots via `file://`.
    //
    // In single-file mode we therefore drop `srcset` entirely and rely on `src`.
    if (singleFile) {
      const tag = String((element as any)?.tagName || (element as any)?.name || "").toLowerCase();
      if (tag === "img") {
        const currentSrc = String($(element).attr("src") || "").trim();
        const looksPlaceholder = looksLikePlaceholderImgSrc(currentSrc);
        if (looksPlaceholder) {
          const firstToken = srcset.trim().split(/\s+/, 1)[0];
          if (firstToken) {
            $(element).attr("src", firstToken);
            rewriteAttr(element, "src");
          }
        }
      }
      $(element).removeAttr("srcset");
      $(element).removeAttr("sizes");
      return;
    }

    const rewritten = srcset
      .split(",")
      .map((candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed) return trimmed;
        const [urlPart, descriptor] = trimmed.split(/\s+/, 2);
        if (urlPart.startsWith("data:")) return trimmed;
        if (singleFile) {
          const inlinedLocal = tryInlineLocalRelative(urlPart, pagePath);
          if (inlinedLocal) return descriptor ? `${inlinedLocal} ${descriptor}` : inlinedLocal;
        }
        const resolved = resolveUrl(urlPart, pageUrl);
        if (!resolved) return trimmed;
        if (singleFile) {
          const asset = tryGetAssetBody(resolved, responses, resourceMap);
          if (!asset || looksLikeHtml(asset.contentType, resolved)) return trimmed;
          const dataUrl = toDataUrl(asset.body, getMimeType(asset.contentType, resolved));
          return descriptor ? `${dataUrl} ${descriptor}` : dataUrl;
        }
        const localPath = resourceMap.get(resolved);
        if (!localPath) return trimmed;
        const relative = toPosix(path.relative(path.dirname(pagePath), localPath));
        return descriptor ? `${relative} ${descriptor}` : relative;
      })
      .join(", ");
    $(element).attr("srcset", rewritten);
  });

  $("style").each((_, element) => {
    const css = $(element).html() ?? "";
    if (!css.trim()) return;
    try {
      const rewritten = rewriteCss(css, pageUrl, pagePath, resourceMap, responses, singleFile);
      $(element).text(rewritten);
    } catch {
      return;
    }
  });

  $("[style]").each((_, element) => {
    const value = $(element).attr("style");
    if (!value) return;
    try {
      const rewritten = rewriteInlineStyleValue(value, pageUrl, pagePath, resourceMap, responses, singleFile);
      $(element).attr("style", rewritten);
    } catch {
      return;
    }
  });

  if (stripConsent) {
    stripConsentArtifacts($);
  }

  // Some themes/plugins (e.g. Salient/Nectar) store background images in data-attributes and
  // set them via JS at runtime. For offline snapshots, it helps to materialize them into CSS.
  const backgroundDataAttrs = ["data-nectar-img-src", "data-bg-src", "data-background-image", "data-background", "data-bg"];
  backgroundDataAttrs.forEach((attr) => {
    const selector = `[${attr}]`;
    $(selector).each((_, element) => {
      const tag = String((element as any)?.tagName || (element as any)?.name || "").toLowerCase();
      if (tag === "img" || tag === "source" || tag === "video") return;

      const value = $(element).attr(attr);
      if (!value) return;
      const existingStyle = $(element).attr("style") || "";
      const hasBg = /background-image\s*:/.test(existingStyle);
      const normalized = existingStyle.trim();
      const stylePrefix = normalized && !normalized.endsWith(";") ? `${normalized}; ` : normalized ? `${normalized} ` : "";
      const bgRule = hasBg ? "" : `background-image: url(${value}); background-size: cover; background-position: 50% 50%; background-repeat: no-repeat; `;
      const opacityRule = /opacity\s*:/.test(existingStyle) ? "" : "opacity: 1; ";
      const combined = `${stylePrefix}${bgRule}${opacityRule}`.trim();
      if (!combined) return;
      try {
        const rewritten = rewriteInlineStyleValue(combined, pageUrl, pagePath, resourceMap, responses, singleFile);
        $(element).attr("style", rewritten);
      } catch {
        $(element).attr("style", combined);
      }
    });
  });

  if (singleFile) {
    // Single-file output is primarily intended as a static snapshot. Removing scripts avoids
    // broken interactive widgets (sliders, consent managers, analytics) when dependencies
    // can't be loaded under `file://`.
    $("script").each((_, element) => {
      const type = String($(element).attr("type") || "").trim().toLowerCase();
      const executes =
        !type ||
        type === "module" ||
        type.includes("javascript") ||
        type.includes("ecmascript");
      if (!executes) return;
      $(element).remove();
    });

    $("style[data-scrape-slider-fallback]").remove();
  }

  return $.html();
};

const stripConsentArtifacts = ($: ReturnType<typeof load>): void => {
  const removeSelectors = [
    "#BorlabsCookieBox",
    "#BorlabsCookieBoxWrap",
    "#BorlabsCookieBoxWidget",
    "#BorlabsCookieWidget",
    "[data-borlabs-cookie-content-blocker-id]",
    "[data-borlabs-cookie-script-blocker-id]",
    "[data-borlabs-cookie-style-blocker-id]",
    "[data-borlabs-cookie-style-blocker-href]",
    "[data-borlabs-cookie-content]",
    "[class*=\"brlbs-\"]",
    "template[id^=\"brlbs-\"]",
    "template[id^=\"brlbs_\"]",
  ];

  removeSelectors.forEach((selector) => $(selector).remove());

  // Borlabs may temporarily set aria-hidden/inert on non-Borlabs page wrappers.
  // Removing those elements can blank the page; instead just drop the attributes.
  $("[data-borlabs-cookie-aria-hidden]").removeAttr("data-borlabs-cookie-aria-hidden");
  $("[aria-hidden]").removeAttr("aria-hidden");
  $("[inert]").removeAttr("inert");

  $("link[data-borlabs-cookie-style-blocker-id], link[data-borlabs-cookie-style-blocker-href]").remove();

  $("script").each((_, element) => {
    const el = $(element);
    const src = (el.attr("src") || "").toLowerCase();
    const type = (el.attr("type") || "").toLowerCase();
    const id = (el.attr("id") || "").toLowerCase();
    const text = (el.text() || "").toLowerCase();

    if (type === "text/template" && (id.includes("borlabs") || id.includes("brlbs"))) {
      el.remove();
      return;
    }

    if (
      src.includes("borlabs") ||
      id.includes("borlabs") ||
      id.includes("brlbs") ||
      text.includes("borlabs") ||
      text.includes("brlbs") ||
      el.attr("data-borlabs-cookie-script-blocker-id") !== undefined ||
      el.attr("data-borlabs-cookie-script-blocker-handle") !== undefined
    ) {
      el.remove();
      return;
    }

    if (src.match(/\/?(consents|observer|vue)\.[a-z0-9_-]+\.min\.js$/)) {
      el.remove();
      return;
    }
  });

  $("style").each((_, element) => {
    const el = $(element);
    const css = el.html() || "";
    if (css.includes("brlbs-") || css.toLowerCase().includes("borlabs")) {
      el.remove();
    }
  });

  const body = $("body");
  const style = body.attr("style");
  if (style && style.includes("overflow: hidden")) {
    body.attr("style", style.replace(/overflow:\s*hidden\s*;?/g, "overflow: auto;"));
  }

  const html = $("html");
  const htmlStyle = html.attr("style");
  if (htmlStyle && htmlStyle.includes("overflow: hidden")) {
    html.attr("style", htmlStyle.replace(/overflow:\s*hidden\s*;?/g, "overflow: auto;"));
  }

  body.removeClass("no-scroll");
  html.removeClass("no-scroll");

  const hideCss = `
    #BorlabsCookieBox, #BorlabsCookieBoxWrap, #BorlabsCookieBoxWidget, #BorlabsCookieWidget,
    [data-borlabs-cookie-content-blocker-id], [data-borlabs-cookie-script-blocker-id],
    [data-borlabs-cookie-style-blocker-id], [data-borlabs-cookie-style-blocker-href],
    [data-borlabs-cookie-content], [class*="brlbs-"] { display: none !important; }
    html, body { overflow: auto !important; }
  `.trim();
  if (hideCss) {
    const head = $("head");
    if (head.length > 0 && head.find("style[data-scrape-consent-hide]").length === 0) {
      head.append(`<style data-scrape-consent-hide>${hideCss}</style>`);
    }
  }
};

export const inlineHtmlAssets = (
  html: string,
  pageUrl: string,
  pagePath: string,
  responses: Map<string, { contentType: string | null; body: Buffer }>,
  resourceMap: Map<string, string>,
  singleFile: boolean
): string => {
  const $ = load(html);

  $("link[rel=\"stylesheet\"][href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const resolved = resolveUrl(href, pageUrl);
    if (!resolved) return;
    const response =
      responses.get(resolved) ||
      (resourceMap.get(resolved)
        ? { contentType: "text/css", body: readFileSync(resourceMap.get(resolved)!) }
        : null);
    if (!response) return;
    const styleTag = $("<style></style>");
    const rewritten = rewriteCss(
      response.body.toString("utf8"),
      resolved,
      pagePath,
      resourceMap,
      responses,
      singleFile
    );
    styleTag.text(rewritten);
    $(element).replaceWith(styleTag);
  });

  $("link[rel=\"modulepreload\"]").remove();
  $("link[rel=\"preload\"][as=\"script\"]").remove();
  $("link[rel=\"preload\"][as=\"style\"]").remove();

  return $.html();
};
