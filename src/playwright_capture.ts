import { BrowserContext } from 'playwright';
import { CapturedResponse } from './types';
import { isHttpUrl, normalizeUrl } from './url';

export interface CapturedPage {
  html: string;
  status: number | null;
  contentType: string | null;
  responses: CapturedResponse[];
}

interface CaptureOptions {
  timeoutMs: number;
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
  [data-borlabs-cookie-content], [class*="brlbs-"] { display: none !important; }
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
  };
};
