import { BrowserContext } from 'playwright';
import {
  CapturedResponse,
  ComputedStyleSnapshot,
  WordingPageSnapshot,
  WordingRawItem,
} from './types';
import { canonicalizeHref } from './wording';
import { isHttpUrl, normalizeUrl } from './url';

export interface CapturedPage {
  html: string;
  status: number | null;
  contentType: string | null;
  responses: CapturedResponse[];
  computedSnapshot: ComputedStyleSnapshot | null;
  wording: WordingPageSnapshot | null;
}

interface CaptureOptions {
  timeoutMs: number;
  collectComputedSnapshot?: boolean;
  collectWording?: boolean;
  /**
   * Extra time to allow late-loading/lazy assets (e.g. sliders) to finish requesting resources.
   * Best-effort: the capture continues even if timeouts are hit.
   */
  settleMs?: number;
}

const CONSENT_UNBLOCK_CSS = `
  html, body { overflow: auto !important; }
  #BorlabsCookieBox, #BorlabsCookieBoxWrap, #BorlabsCookieBoxWidget, #BorlabsCookieWidget,
  [data-borlabs-cookie-content-blocker-id], [data-borlabs-cookie-script-blocker-id],
  [data-borlabs-cookie-style-blocker-id], [data-borlabs-cookie-style-blocker-href],
  [data-borlabs-cookie-content], [class*="brlbs-"],
  [data-acris-cookie-consent], .acris-cookie-consent,
  #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay, [data-cookieconsent],
  #onetrust-consent-sdk, #onetrust-banner-sdk, .onetrust-pc-dark-filter,
  #cmplz-cookiebanner-container, .cmplz-cookiebanner,
  .klaro, #klaro,
  #cookie-law-info-bar, #cookie-law-info-again, .cky-consent-container,
  #usercentrics-root,
  .qc-cmp2-container, #qcCmpUi,
  #tarteaucitronRoot, #tarteaucitronAlertBig,
  .osano-cm-window,
  [id*="cookie-banner"], [id*="cookie-consent"], [id*="cookie-notice"],
  [class*="cookie-banner"], [class*="cookie-consent"], [class*="cookie-notice"],
  [class*="gdpr-banner"], [class*="cc-banner"] { display: none !important; }
`.trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tryDismissConsent = async (page: any): Promise<void> => {
  // Generic best-effort click on common consent buttons; silently ignore failures.
  const labels = [
    'accept all',
    'accept',
    'i accept',
    'agree',
    'allow all',
    'alle akzeptieren',
    'akzeptieren',
    'zustimmen',
    'einverstanden',
    'ok',
  ];

  try {
    await page.evaluate((needleLabels: string[]) => {
      const norm = (s: string) =>
        String(s || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();

      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el as any);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = (el as any).getBoundingClientRect?.();
        if (!rect) return true;
        return rect.width > 2 && rect.height > 2;
      };

      const candidates = Array.from(
        document.querySelectorAll(
          [
            'button',
            "a[role='button']",
            "[role='button']",
            "input[type='button']",
            "input[type='submit']",
          ].join(','),
        ),
      ).filter(isVisible);

      for (const el of candidates) {
        const text =
          (el as any).innerText ||
          (el as any).value ||
          (el as any).getAttribute?.('aria-label') ||
          '';
        const t = norm(text);
        if (!t) continue;
        if (needleLabels.some((l) => t === l || t.includes(l))) {
          (el as HTMLElement).click();
          return;
        }
      }
    }, labels);
  } catch {
    // ignore
  }

  // If a consent layer still blocks scrolling, hide common overlays and re-enable scrolling.
  try {
    await page.addStyleTag({ content: CONSENT_UNBLOCK_CSS });
  } catch {
    // ignore
  }
};

const materializeLazyDom = async (page: any): Promise<void> => {
  // Convert common lazy attributes into real src/srcset/background-image so that
  // resources actually get requested during capture.
  try {
    await page.evaluate(() => {
      const pick = (el: Element, attrs: string[]) => {
        for (const attr of attrs) {
          const v = (el as any).getAttribute?.(attr);
          if (v) return v;
        }
        return null;
      };

      const setImgSrc = (img: HTMLImageElement) => {
        const lazySrc = pick(img, [
          'data-nectar-img-src',
          'data-src',
          'data-lazy-src',
          'data-original',
          'data-lazy',
        ]);
        if (
          lazySrc &&
          (!img.getAttribute('src') ||
            img.getAttribute('src') === '#' ||
            img.getAttribute('src') === 'about:blank')
        ) {
          img.setAttribute('src', lazySrc);
        }

        const lazySrcset = pick(img, [
          'data-nectar-img-srcset',
          'data-srcset',
          'data-lazy-srcset',
        ]);
        if (lazySrcset && !img.getAttribute('srcset')) {
          img.setAttribute('srcset', lazySrcset);
        }
      };

      document.querySelectorAll('img').forEach((el) => setImgSrc(el as HTMLImageElement));

      document.querySelectorAll('picture source').forEach((el) => {
        const source = el as HTMLSourceElement;
        const lazy = pick(source, [
          'data-srcset',
          'data-lazy-srcset',
          'data-nectar-img-srcset',
        ]);
        if (lazy && !source.getAttribute('srcset')) {
          source.setAttribute('srcset', lazy);
        }
      });

      const bgAttrs = [
        'data-nectar-img-src',
        'data-bg-src',
        'data-background-image',
        'data-background',
        'data-bg',
      ];
      document.querySelectorAll(bgAttrs.map((a) => `[${a}]`).join(',')).forEach((el) => {
        const anyEl = el as HTMLElement;
        const url = pick(el, bgAttrs);
        if (!url) return;
        const style = anyEl.getAttribute('style') || '';
        if (!/background-image\s*:/.test(style)) {
          anyEl.setAttribute(
            'style',
            `${style}${style.trim() && !style.trim().endsWith(';') ? ';' : ''} background-image: url(${url}); background-size: cover; background-position: 50% 50%; background-repeat: no-repeat;`,
          );
        }
      });
    });
  } catch {
    // ignore
  }
};

const autoScroll = async (page: any, maxSteps = 18, stepDelayMs = 250): Promise<void> => {
  try {
    await page.evaluate(
      async (args: { maxSteps: number; stepDelayMs: number }) => {
        const { maxSteps, stepDelayMs } = args;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const height = () =>
          Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        for (let i = 0; i < maxSteps; i++) {
          const y = Math.floor((height() * i) / maxSteps);
          window.scrollTo(0, y);
          window.dispatchEvent(new Event('scroll'));
          await sleep(stepDelayMs);
        }
        window.scrollTo(0, 0);
        window.dispatchEvent(new Event('scroll'));
      },
      { maxSteps, stepDelayMs },
    );
  } catch {
    // ignore
  }
};

const expandInteractiveMenus = async (page: any): Promise<void> => {
  const hoverSelectors = [
    'header nav li',
    'header nav a',
    'nav [aria-haspopup="true"]',
    'nav li',
    '.menu li',
    '.main-menu li',
    '.nav li',
    '.menu-item-has-children',
    '.has-submenu',
    '.dropdown',
    '[role="menubar"] [role="menuitem"]',
  ];

  try {
    const hoverCandidates = await page.$$(hoverSelectors.join(','));
    let hovered = 0;
    for (const element of hoverCandidates) {
      if (hovered >= 80) break;
      try {
        const box = await element.boundingBox();
        if (!box || box.width < 2 || box.height < 2) continue;
        await element.scrollIntoViewIfNeeded();
        await element.hover({ force: true, timeout: 1200 });
        hovered += 1;
        await sleep(90);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  try {
    // Move the pointer away so hover-only menus collapse before snapshotting DOM.
    const viewport = page.viewportSize();
    const x = Math.max(5, Math.floor((viewport?.width ?? 1280) * 0.02));
    const y = Math.max(5, Math.floor((viewport?.height ?? 720) * 0.98));
    await page.mouse.move(x, y);
    await page.keyboard.press('Escape');
    await sleep(120);
  } catch {
    // ignore
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // best-effort
  }
};

const VIEWPORT_BREAKPOINT_WIDTHS = [360, 480, 768, 1024, 1280, 1440];

const collectComputedSnapshot = async (
  page: any,
): Promise<ComputedStyleSnapshot | null> => {
  try {
    const base = (await page.evaluate(() => {
      const makeCounter = () => Object.create(null) as Record<string, number>;
      const inc = (target: Record<string, number>, raw: string) => {
        if (!raw) return;
        target[raw] = (target[raw] || 0) + 1;
      };

      const normalizeColor = (value: string) => {
        const compact = String(value || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '');
        if (
          !compact ||
          compact === 'transparent' ||
          compact === 'rgba(0,0,0,0)' ||
          compact === 'initial' ||
          compact === 'inherit' ||
          compact === 'currentcolor' ||
          compact.includes('var(')
        ) {
          return '';
        }
        return compact;
      };

      const normalizeFontFamily = (value: string) => {
        const first = String(value || '')
          .split(',')[0]
          .trim()
          .replace(/^['"]+|['"]+$/g, '');
        if (!first || first.toLowerCase() === 'inherit') return '';
        return first;
      };

      const normalizeLength = (value: string) => {
        const compact = String(value || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '');
        if (!compact || compact === 'initial' || compact === 'inherit') return '';
        return compact;
      };

      const isMeaningfulLength = (value: string) => {
        if (!value) return false;
        if (value === 'normal') return false;
        if (/^0(?:\.0+)?(?:[a-z%]+)?$/i.test(value)) return false;
        return true;
      };

      const textColors = makeCounter();
      const backgroundColors = makeCounter();
      const borderColors = makeCounter();
      const fillColors = makeCounter();
      const fontFamilies = makeCounter();
      const fontSizes = makeCounter();
      const fontWeights = makeCounter();
      const lineHeights = makeCounter();
      const spacing = makeCounter();
      const borderRadius = makeCounter();

      const spacingProps = [
        'marginTop',
        'marginRight',
        'marginBottom',
        'marginLeft',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'rowGap',
        'columnGap',
      ] as const;
      const radiusProps = [
        'borderTopLeftRadius',
        'borderTopRightRadius',
        'borderBottomRightRadius',
        'borderBottomLeftRadius',
      ] as const;

      const allElements = Array.from(document.querySelectorAll('*'));
      for (const element of allElements) {
        const style = window.getComputedStyle(element);
        inc(textColors, normalizeColor(style.color));
        inc(backgroundColors, normalizeColor(style.backgroundColor));
        inc(borderColors, normalizeColor(style.borderTopColor));
        inc(borderColors, normalizeColor(style.borderRightColor));
        inc(borderColors, normalizeColor(style.borderBottomColor));
        inc(borderColors, normalizeColor(style.borderLeftColor));

        const fill = normalizeColor((style as any).fill || '');
        if (fill && fill !== 'none') inc(fillColors, fill);
        const stroke = normalizeColor((style as any).stroke || '');
        if (stroke && stroke !== 'none') inc(fillColors, stroke);

        inc(fontFamilies, normalizeFontFamily(style.fontFamily));

        const size = normalizeLength(style.fontSize);
        if (isMeaningfulLength(size)) inc(fontSizes, size);

        const weight = normalizeLength(style.fontWeight);
        if (weight) inc(fontWeights, weight);

        const lineHeight = normalizeLength(style.lineHeight);
        if (isMeaningfulLength(lineHeight)) inc(lineHeights, lineHeight);

        for (const prop of spacingProps) {
          const value = normalizeLength(style[prop] || '');
          if (isMeaningfulLength(value)) inc(spacing, value);
        }

        for (const prop of radiusProps) {
          const value = normalizeLength(style[prop] || '');
          if (isMeaningfulLength(value)) inc(borderRadius, value);
        }
      }

      return {
        html: {
          elements: allElements.length,
          externalStylesheets: document.querySelectorAll('link[rel~="stylesheet"][href]')
            .length,
          inlineStyleElements: document.querySelectorAll('style').length,
          inlineStyleAttributes: document.querySelectorAll('[style]').length,
        },
        used: {
          colors: {
            text: textColors,
            background: backgroundColors,
            border: borderColors,
            fill: fillColors,
          },
          typography: {
            fontFamilies,
            fontSizes,
            fontWeights,
            lineHeights,
          },
          layout: {
            spacing,
            borderRadius,
          },
        },
      };
    })) as Omit<ComputedStyleSnapshot, 'headings'>;

    const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const widths = Array.from(
      new Set([...VIEWPORT_BREAKPOINT_WIDTHS, Number(originalViewport.width)]),
    )
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);

    const headings: ComputedStyleSnapshot['headings'] = [];
    try {
      for (const width of widths) {
        await page.setViewportSize({
          width,
          height: originalViewport.height,
        });
        await sleep(150);

        const headingAtWidth = (await page.evaluate((breakpoint: string) => {
          const makeCounter = () => Object.create(null) as Record<string, number>;
          const inc = (target: Record<string, number>, raw: string) => {
            if (!raw) return;
            target[raw] = (target[raw] || 0) + 1;
          };

          const normalizeFontFamily = (value: string) => {
            const first = String(value || '')
              .split(',')[0]
              .trim()
              .replace(/^['"]+|['"]+$/g, '');
            if (!first || first.toLowerCase() === 'inherit') return '';
            return first;
          };

          const normalizeLength = (value: string) => {
            const compact = String(value || '')
              .trim()
              .toLowerCase()
              .replace(/\s+/g, '');
            if (!compact || compact === 'initial' || compact === 'inherit') return '';
            return compact;
          };

          const isMeaningfulLength = (value: string) => {
            if (!value) return false;
            if (value === 'normal') return false;
            if (/^0(?:\.0+)?(?:[a-z%]+)?$/i.test(value)) return false;
            return true;
          };

          const bucketByHeading = new Map<
            string,
            {
              fontFamilies: Record<string, number>;
              fontSizes: Record<string, number>;
              fontWeights: Record<string, number>;
              lineHeights: Record<string, number>;
            }
          >();

          const elements = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
          for (const element of elements) {
            const heading = element.tagName.toLowerCase();
            const style = window.getComputedStyle(element);
            let bucket = bucketByHeading.get(heading);
            if (!bucket) {
              bucket = {
                fontFamilies: makeCounter(),
                fontSizes: makeCounter(),
                fontWeights: makeCounter(),
                lineHeights: makeCounter(),
              };
              bucketByHeading.set(heading, bucket);
            }

            inc(bucket.fontFamilies, normalizeFontFamily(style.fontFamily));
            const size = normalizeLength(style.fontSize);
            if (isMeaningfulLength(size)) inc(bucket.fontSizes, size);
            const weight = normalizeLength(style.fontWeight);
            if (weight) inc(bucket.fontWeights, weight);
            const lineHeight = normalizeLength(style.lineHeight);
            if (isMeaningfulLength(lineHeight)) inc(bucket.lineHeights, lineHeight);
          }

          return Array.from(bucketByHeading.entries()).map(([heading, tokenMaps]) => ({
            heading,
            breakpoint,
            fontFamilies: tokenMaps.fontFamilies,
            fontSizes: tokenMaps.fontSizes,
            fontWeights: tokenMaps.fontWeights,
            lineHeights: tokenMaps.lineHeights,
          }));
        }, `viewport <= ${width}px`)) as ComputedStyleSnapshot['headings'];

        headings.push(...headingAtWidth);
      }
    } finally {
      // Auch bei einem Abbruch mitten in der Schleife zurück auf die Ursprungsbreite,
      // sonst bleibt die Seite für alles Folgende auf der letzten Breakpoint-Breite.
      await page.setViewportSize(originalViewport).catch(() => undefined);
    }

    return {
      ...base,
      headings,
    };
  } catch {
    return null;
  }
};

/**
 * Sammelt die Wording-Korpora aus dem gerenderten DOM. Bewusst dünn: nur
 * DOM-Abfrage, Sichtbarkeit und Accessible Name — Aufräumen, Dedup und
 * Auswertung passieren in `wording.ts` (pure, unit-getestet).
 *
 * Muss VOR `collectComputedSnapshot` laufen: dessen Breakpoint-Schleife setzt
 * die Viewport-Breite mehrfach um und kann responsives JS den DOM umbauen lassen.
 */
const collectWordingSnapshot = async (
  page: any,
  url: string,
): Promise<WordingPageSnapshot | null> => {
  try {
    const raw = (await page.evaluate(() => {
      const items: Array<{
        corpus: string;
        kind: string;
        text: string;
        href?: string;
        order: number;
      }> = [];
      const push = (corpus: string, kind: string, text: string, href?: string) => {
        items.push({
          corpus,
          kind,
          text,
          ...(href ? { href } : {}),
          order: items.length,
        });
      };

      const isHiddenSelf = (el: Element): boolean => {
        const anyEl = el as HTMLElement;
        if (anyEl.hidden) return true;
        if (el.getAttribute('aria-hidden') === 'true') return true;
        if (el.hasAttribute('inert')) return true;
        const style = window.getComputedStyle(el);
        if (style.display === 'none') return true;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
        if (style.opacity === '0') return true;
        return false;
      };

      const isHidden = (el: Element): boolean => {
        let current: Element | null = el;
        while (current) {
          if (isHiddenSelf(current)) return true;
          current = current.parentElement;
        }
        return false;
      };

      /** Textinhalt ohne versteckte Nachfahren. */
      const visibleText = (el: Element): string => {
        const parts: string[] = [];
        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.nodeValue || '');
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const element = node as Element;
          if (isHiddenSelf(element)) return;
          node.childNodes.forEach(walk);
        };
        el.childNodes.forEach(walk);
        return parts.join(' ');
      };

      const clean = (value: string) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim();

      const accessibleName = (el: Element): string => {
        const candidates: Array<string | null> = [
          visibleText(el),
          el.getAttribute('aria-label'),
        ];

        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const referenced = labelledBy
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => {
              const target = document.getElementById(id);
              return target ? visibleText(target) : '';
            })
            .filter(Boolean);
          candidates.push(referenced.join(' '));
        }

        candidates.push((el as HTMLInputElement).value ?? null);
        if (el.tagName.toLowerCase() === 'input') {
          candidates.push(el.getAttribute('alt'));
        } else {
          const images = el.querySelectorAll('img[alt]');
          if (images.length === 1) candidates.push(images[0].getAttribute('alt'));
        }
        candidates.push(el.getAttribute('title'));

        for (const candidate of candidates) {
          const cleaned = clean(candidate || '');
          if (cleaned) return cleaned;
        }
        return '';
      };

      const buttonClassTokens = new Set(['btn', 'button', 'cta']);
      const buttonClassPrefixes = ['btn-', 'btn_', 'button-', 'cta-'];
      const hasButtonClass = (el: Element): boolean => {
        for (const token of Array.from(el.classList)) {
          const lower = token.toLowerCase();
          if (buttonClassTokens.has(lower)) return true;
          if (buttonClassPrefixes.some((prefix) => lower.startsWith(prefix))) return true;
        }
        return false;
      };

      const visible = (selector: string): Element[] =>
        Array.from(document.querySelectorAll(selector)).filter((el) => !isHidden(el));

      // meta/title werden nie gerendert — keine Sichtbarkeitsprüfung.
      push('meta', 'title', document.title || '');
      push(
        'meta',
        'description',
        document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      );

      for (const el of visible('h1, h2, h3')) {
        push('heading', el.tagName.toLowerCase(), accessibleName(el));
      }

      const ctaSeen = new Set<Element>();
      for (const el of visible(
        'button, [role="button"], input[type="submit"], input[type="button"], input[type="image"], a[class]',
      )) {
        if (ctaSeen.has(el)) continue;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a' && !hasButtonClass(el)) continue;
        ctaSeen.add(el);
        const kind = tag === 'a' ? 'link' : tag === 'input' ? 'submit' : 'button';
        push(
          'cta',
          kind,
          accessibleName(el),
          tag === 'a' ? el.getAttribute('href') || undefined : undefined,
        );
      }

      const navSeen = new Set<Element>();
      for (const el of visible(
        'nav a, nav button, [role="navigation"] a, [role="navigation"] button, [role="menuitem"]',
      )) {
        if (navSeen.has(el)) continue;
        navSeen.add(el);
        const tag = el.tagName.toLowerCase();
        push(
          'nav',
          tag === 'a' ? 'link' : 'menuitem',
          accessibleName(el),
          tag === 'a' ? el.getAttribute('href') || undefined : undefined,
        );
      }

      for (const form of visible('form')) {
        for (const el of Array.from(form.querySelectorAll('label'))) {
          if (!isHidden(el)) push('form', 'label', accessibleName(el));
        }
        for (const el of Array.from(form.querySelectorAll('legend'))) {
          if (!isHidden(el)) push('form', 'legend', accessibleName(el));
        }
        for (const el of Array.from(form.querySelectorAll('[placeholder]'))) {
          if (!isHidden(el))
            push('form', 'placeholder', el.getAttribute('placeholder') || '');
        }
        // option: im geschlossenen select unsichtbar, aber Beschriftung.
        for (const el of Array.from(form.querySelectorAll('option'))) {
          push('form', 'option', el.textContent || el.getAttribute('label') || '');
        }
        for (const el of Array.from(
          form.querySelectorAll(
            'button[type="submit"], input[type="submit"], button:not([type])',
          ),
        )) {
          if (!isHidden(el)) push('form', 'submit', accessibleName(el));
        }
      }

      return {
        lang: (document.documentElement.getAttribute('lang') || '').trim().toLowerCase(),
        items,
      };
    })) as { lang: string; items: WordingRawItem[] };

    return {
      url,
      lang: raw.lang || null,
      collectionMode: 'playwright',
      items: raw.items.map((item) => ({
        ...item,
        ...(item.href ? { href: canonicalizeHref(item.href, url) } : {}),
      })),
    };
  } catch {
    return null;
  }
};

export const capturePage = async (
  context: BrowserContext,
  url: string,
  options: CaptureOptions,
): Promise<CapturedPage> => {
  const page = await context.newPage();
  const responses: CapturedResponse[] = [];
  const seenResponses = new Set<string>();

  // Must be installed before first navigation so it applies to initial document scripts.
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });
  } catch {
    // ignore
  }

  page.on('response', async (response) => {
    try {
      const responseUrl = response.url();
      if (!isHttpUrl(responseUrl)) return;
      const normalized = normalizeUrl(responseUrl);
      if (seenResponses.has(normalized)) return;
      const request = response.request();
      const resourceType = request.resourceType();
      if (
        resourceType === 'document' &&
        normalizeUrl(responseUrl) === normalizeUrl(url)
      ) {
        return;
      }
      const body = await response.body();
      const contentType = response.headers()['content-type'] || null;
      seenResponses.add(normalized);
      responses.push({
        url: responseUrl,
        status: response.status(),
        contentType,
        body,
      });
    } catch {
      return;
    }
  });

  let mainResponse = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });
  const initialHtml = mainResponse ? await mainResponse.text().catch(() => null) : null;

  // Best-effort consent dismissal and lazy-load triggering to improve offline completeness.
  await tryDismissConsent(page);
  await materializeLazyDom(page);

  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    // best-effort
  }

  // Scroll to trigger intersection-based lazy loading and sliders that only request assets on interaction.
  await autoScroll(page);
  await materializeLazyDom(page);
  await expandInteractiveMenus(page);
  await materializeLazyDom(page);

  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    // best-effort
  }

  try {
    await page.waitForFunction(
      () => Array.from(document.images).every((img) => img.complete),
      { timeout: 8000 },
    );
  } catch {
    // best-effort
  }

  // Late-loading widgets sometimes request images after a short delay (e.g. sliders).
  // Give them a small best-effort window to finish without hard-failing the capture.
  const maxSettleMs = typeof options.settleMs === 'number' ? options.settleMs : 4000;
  const settleStart = Date.now();
  while (Date.now() - settleStart < maxSettleMs) {
    await materializeLazyDom(page);
    try {
      await page.waitForLoadState('networkidle', { timeout: 1500 });
    } catch {
      // best-effort
    }
    await sleep(350);
  }

  // Interactions above are useful for triggering lazy asset requests, but they can mutate
  // the DOM (e.g. opening/augmenting menus). Re-load once and snapshot a clean state.
  try {
    const reloadedMainResponse = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    if (reloadedMainResponse) {
      mainResponse = reloadedMainResponse;
    }
    await tryDismissConsent(page);
    await materializeLazyDom(page);
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      // best-effort
    }
  } catch {
    // best-effort: keep current DOM if reload fails
  }

  const html = (await page.content().catch(() => null)) ?? initialHtml ?? '';
  // Vor collectComputedSnapshot: dessen Viewport-Resizes können responsives JS
  // den DOM umbauen lassen, dann beschriebe das Wording ein anderes Dokument als
  // das oben gelesene HTML.
  const wording = options.collectWording ? await collectWordingSnapshot(page, url) : null;
  const computedSnapshot = options.collectComputedSnapshot
    ? await collectComputedSnapshot(page)
    : null;
  const status = mainResponse ? mainResponse.status() : null;
  const contentType = mainResponse
    ? mainResponse.headers()['content-type'] || null
    : null;

  await page.close();

  return {
    html,
    status,
    contentType,
    responses,
    computedSnapshot,
    wording,
  };
};
