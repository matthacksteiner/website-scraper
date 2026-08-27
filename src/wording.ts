import { load } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { stripConsentArtifacts } from './rewrite';
import { isHttpUrl, normalizeUrl } from './url';
import {
  WordingCollectionMode,
  WordingCorpus,
  WordingDocument,
  WordingEntry,
  WordingPageSnapshot,
  WordingRawItem,
  WordingSalutation,
} from './types';

type Cheerio$ = ReturnType<typeof load>;

/** Klassen-Token, die im Fetch-Fallback als "versteckt" gelten. */
const HIDDEN_CLASS_TOKENS = new Set([
  'sr-only',
  'sr-only-focusable',
  'visually-hidden',
  'visuallyhidden',
  'screen-reader-text',
  'screen-reader-only',
  'a11y-hidden',
  'hidden',
  'is-hidden',
  'd-none',
]);

const BUTTON_CLASS_TOKENS = new Set(['btn', 'button', 'cta']);
const BUTTON_CLASS_PREFIXES = ['btn-', 'btn_', 'button-', 'cta-'];

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u00AD]/g;
// C0/C1-Steuerzeichen (ohne die Whitespace-Varianten, die Schritt 3 ohnehin frisst).
// Steuerzeichen zu matchen ist hier der Zweck, nicht ein Versehen.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export const cleanWordingText = (raw: string): string => {
  return String(raw ?? '')
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
};

/** Reine Icon-/Symbolbeschriftung: kein einziger Buchstabe, keine Ziffer. */
export const isIconOnlyLabel = (text: string): boolean => {
  if (!text) return true;
  return !/[\p{L}\p{N}]/u.test(text);
};

const hasButtonClass = (classAttr: string | undefined): boolean => {
  if (!classAttr) return false;
  for (const token of classAttr.split(/\s+/)) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (BUTTON_CLASS_TOKENS.has(lower)) return true;
    if (BUTTON_CLASS_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  }
  return false;
};

/**
 * href-Kanonisierung. `normalizeUrl` erwartet eine absolute URL und wirft sonst,
 * darum werden Nicht-Navigations-Ziele unverändert durchgereicht.
 */
export const canonicalizeHref = (
  rawHref: string | undefined,
  pageUrl: string,
): string | undefined => {
  const value = (rawHref ?? '').trim();
  if (!value) return undefined;
  if (/^(mailto:|tel:|javascript:|#)/i.test(value)) return value;
  try {
    const absolute = new URL(value, pageUrl).toString();
    return isHttpUrl(absolute) ? normalizeUrl(absolute) : absolute;
  } catch {
    return value;
  }
};

// ---------------------------------------------------------------------------
// Fetch-Fallback: cheerio über das gerenderte HTML.
// Sieht kein CSS — erkennt nur attribut- und inline-style-basierte Verstecke.
// ---------------------------------------------------------------------------

const isHiddenNode = ($: Cheerio$, element: Element): boolean => {
  const node = $(element);
  if (node.attr('hidden') !== undefined) return true;
  if (node.attr('inert') !== undefined) return true;
  if ((node.attr('aria-hidden') || '').toLowerCase() === 'true') return true;
  const style = (node.attr('style') || '').toLowerCase().replace(/\s+/g, '');
  if (
    style.includes('display:none') ||
    style.includes('visibility:hidden') ||
    style.includes('opacity:0')
  ) {
    return true;
  }
  const classAttr = node.attr('class');
  if (classAttr) {
    for (const token of classAttr.split(/\s+/)) {
      if (token && HIDDEN_CLASS_TOKENS.has(token.toLowerCase())) return true;
    }
  }
  return false;
};

const isHiddenWithAncestors = ($: Cheerio$, element: Element): boolean => {
  let current: AnyNode | null = element;
  while (current && current.type === 'tag') {
    if (isHiddenNode($, current as Element)) return true;
    current = current.parent as AnyNode | null;
  }
  return false;
};

/** Textinhalt ohne versteckte Nachfahren. */
const visibleText = ($: Cheerio$, element: Element): string => {
  const parts: string[] = [];
  const walk = (node: AnyNode): void => {
    if (node.type === 'text') {
      parts.push((node as unknown as { data: string }).data || '');
      return;
    }
    if (node.type !== 'tag') return;
    const tag = node as Element;
    if (isHiddenNode($, tag)) return;
    for (const child of tag.children as AnyNode[]) walk(child);
  };
  for (const child of element.children as AnyNode[]) walk(child);
  return parts.join(' ');
};

/** Minimales Escaping für IDs in Selektoren — cheerio hat kein CSS.escape. */
const escapeSelectorId = (value: string): string => value.replace(/["\\\]]/g, '\\$&');

const accessibleName = ($: Cheerio$, element: Element): string => {
  const node = $(element);
  const candidates: Array<string | undefined> = [
    visibleText($, element),
    node.attr('aria-label'),
  ];

  const labelledBy = node.attr('aria-labelledby');
  if (labelledBy) {
    const referenced = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => {
        const target = $(`#${escapeSelectorId(id)}`).first();
        return target.length > 0 ? visibleText($, target[0] as Element) : '';
      })
      .filter(Boolean);
    candidates.push(referenced.join(' '));
  }

  candidates.push(node.attr('value'));
  const tag = element.tagName?.toLowerCase();
  if (tag === 'input') {
    candidates.push(node.attr('alt'));
  } else {
    const images = node.find('img[alt]');
    if (images.length === 1) candidates.push(images.first().attr('alt'));
  }
  candidates.push(node.attr('title'));

  for (const candidate of candidates) {
    const cleaned = cleanWordingText(candidate ?? '');
    if (cleaned) return cleaned;
  }
  return '';
};

export interface ExtractWordingInput {
  url: string;
  html: string;
  stripConsent?: boolean;
}

export const extractWordingFromHtml = (
  input: ExtractWordingInput,
): WordingPageSnapshot => {
  const $ = load(input.html);
  if (input.stripConsent) {
    stripConsentArtifacts($);
  }

  const items: WordingRawItem[] = [];
  const push = (
    corpus: WordingCorpus,
    kind: string,
    text: string,
    href?: string,
  ): void => {
    items.push({ corpus, kind, text, ...(href ? { href } : {}), order: items.length });
  };

  // meta — nie gerendert, daher ohne Sichtbarkeitsprüfung.
  push('meta', 'title', $('title').first().text() || '');
  push(
    'meta',
    'description',
    $('meta[name="description"]').first().attr('content') || '',
  );

  const visibleElements = (selector: string): Element[] =>
    $(selector)
      .toArray()
      .filter((element) => !isHiddenWithAncestors($, element as Element)) as Element[];

  for (const element of visibleElements('h1, h2, h3')) {
    push('heading', element.tagName.toLowerCase(), accessibleName($, element));
  }

  const ctaSeen = new Set<Element>();
  const ctaSelector = [
    'button',
    '[role="button"]',
    'input[type="submit"]',
    'input[type="button"]',
    'input[type="image"]',
    'a[class]',
  ].join(', ');
  for (const element of visibleElements(ctaSelector)) {
    if (ctaSeen.has(element)) continue;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && !hasButtonClass($(element).attr('class'))) continue;
    ctaSeen.add(element);
    const kind = tag === 'a' ? 'link' : tag === 'input' ? 'submit' : 'button';
    const href =
      tag === 'a' ? canonicalizeHref($(element).attr('href'), input.url) : undefined;
    push('cta', kind, accessibleName($, element), href);
  }

  const navSeen = new Set<Element>();
  const navSelector = [
    'nav a',
    'nav button',
    '[role="navigation"] a',
    '[role="navigation"] button',
    '[role="menuitem"]',
  ].join(', ');
  for (const element of visibleElements(navSelector)) {
    if (navSeen.has(element)) continue;
    navSeen.add(element);
    const tag = element.tagName.toLowerCase();
    const kind = tag === 'a' ? 'link' : 'menuitem';
    const href =
      tag === 'a' ? canonicalizeHref($(element).attr('href'), input.url) : undefined;
    push('nav', kind, accessibleName($, element), href);
  }

  for (const form of visibleElements('form')) {
    const scope = $(form);
    for (const element of scope.find('label').toArray() as Element[]) {
      if (isHiddenWithAncestors($, element)) continue;
      push('form', 'label', accessibleName($, element));
    }
    for (const element of scope.find('legend').toArray() as Element[]) {
      if (isHiddenWithAncestors($, element)) continue;
      push('form', 'legend', accessibleName($, element));
    }
    for (const element of scope.find('[placeholder]').toArray() as Element[]) {
      if (isHiddenWithAncestors($, element)) continue;
      push('form', 'placeholder', $(element).attr('placeholder') || '');
    }
    // option: im geschlossenen select unsichtbar, aber Beschriftung.
    for (const element of scope.find('option').toArray() as Element[]) {
      const node = $(element);
      push('form', 'option', node.text() || node.attr('label') || '');
    }
    const submits = scope
      .find('button[type="submit"], input[type="submit"], button:not([type])')
      .toArray() as Element[];
    for (const element of submits) {
      if (isHiddenWithAncestors($, element)) continue;
      push('form', 'submit', accessibleName($, element));
    }
  }

  const lang = ($('html').first().attr('lang') || '').trim().toLowerCase();

  return {
    url: input.url,
    lang: lang || null,
    collectionMode: 'fetch-fallback',
    items,
  };
};

// ---------------------------------------------------------------------------
// Anrede-Erkennung
// ---------------------------------------------------------------------------

const FORMAL_STRONG = ['Ihnen', 'Ihre', 'Ihrem', 'Ihren', 'Ihrer', 'Ihres', 'Ihrerseits'];
const FORMAL_WEAK = ['Sie', 'Ihr'];
const INFORMAL = [
  'du',
  'dich',
  'dir',
  'dein',
  'deine',
  'deinem',
  'deinen',
  'deiner',
  'deines',
  'deins',
  'euch',
  'euer',
  'eure',
  'eurem',
  'euren',
  'eurer',
  'eures',
  'eurerseits',
];
const ENGLISH_ADDRESS = ['you', 'your', 'yours'];
const ENGLISH_WE = ['we', 'our', 'us', 'ours'];

/**
 * Unicode-Wortgrenzen. `\b` bleibt auch mit /u-Flag ASCII-orientiert und würde
 * an Umlauten falsch trennen.
 */
const markerRegex = (marker: string, caseSensitive: boolean): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_])${marker}(?![\\p{L}\\p{N}_])`,
    caseSensitive ? 'gu' : 'giu',
  );

const countMarkers = (
  text: string,
  markers: string[],
  caseSensitive: boolean,
): { total: number; found: string[] } => {
  let total = 0;
  const found: string[] = [];
  for (const marker of markers) {
    const matches = text.match(markerRegex(marker, caseSensitive));
    if (matches && matches.length > 0) {
      total += matches.length;
      found.push(marker);
    }
  }
  return { total, found };
};

const limitMarkers = (values: string[]): string[] =>
  Array.from(new Set(values))
    .sort((a, b) => a.localeCompare(b, 'de'))
    .slice(0, 12);

export const detectSalutation = (texts: string[]): WordingSalutation => {
  const corpus = texts.join('\n');

  const strong = countMarkers(corpus, FORMAL_STRONG, true);
  const weak = countMarkers(corpus, FORMAL_WEAK, true);
  const informal = countMarkers(corpus, INFORMAL, false);
  const englishAddress = countMarkers(corpus, ENGLISH_ADDRESS, false);
  const englishWe = countMarkers(corpus, ENGLISH_WE, false);

  const formalScore = 2 * strong.total + weak.total;
  const isFormal = formalScore >= 2;
  const isInformal = informal.total >= 1;

  const form =
    isFormal && isInformal
      ? 'gemischt'
      : isFormal
        ? 'Sie'
        : isInformal
          ? 'du'
          : 'unbestimmt';

  return {
    form,
    formalStrongHits: strong.total,
    formalWeakHits: weak.total,
    formalHits: strong.total + weak.total,
    informalHits: informal.total,
    englishAddressHits: englishAddress.total,
    englishWeHits: englishWe.total,
    markers: {
      formal: limitMarkers([...strong.found, ...weak.found]),
      informal: limitMarkers(informal.found),
      english: limitMarkers([...englishAddress.found, ...englishWe.found]),
    },
  };
};

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const HEADING_ORDER: Record<string, number> = { h1: 0, h2: 1, h3: 2 };

const entryKey = (item: {
  corpus: WordingCorpus;
  kind: string;
  text: string;
  href?: string;
}): string => JSON.stringify([item.corpus, item.kind, item.text, item.href ?? '']);

const normalizePageUrl = (url: string): string => {
  try {
    return normalizeUrl(url);
  } catch {
    return url;
  }
};

export const buildWordingDocument = (
  sourceUrl: string,
  pages: WordingPageSnapshot[],
): WordingDocument => {
  const buckets = new Map<
    string,
    { entry: WordingEntry; pages: Set<string>; order: number }
  >();
  const salutationCorpus: string[] = [];
  const languageCounts = new Map<string, number>();
  const modes = new Set<WordingCollectionMode>();

  for (const page of pages) {
    modes.add(page.collectionMode);
    if (page.lang) {
      languageCounts.set(page.lang, (languageCounts.get(page.lang) ?? 0) + 1);
    }
    const pageUrl = normalizePageUrl(page.url);

    for (const item of page.items) {
      const text = cleanWordingText(item.text);
      if (!text || isIconOnlyLabel(text)) continue;
      salutationCorpus.push(text);

      const key = entryKey({
        corpus: item.corpus,
        kind: item.kind,
        text,
        href: item.href,
      });
      const existing = buckets.get(key);
      if (existing) {
        existing.entry.occurrences += 1;
        existing.pages.add(pageUrl);
        continue;
      }
      buckets.set(key, {
        order: buckets.size,
        pages: new Set([pageUrl]),
        entry: {
          corpus: item.corpus,
          kind: item.kind,
          text,
          ...(item.href ? { href: item.href } : {}),
          pages: [],
          pageCount: 0,
          occurrences: 1,
          global: false,
        },
      });
    }
  }

  const entries = Array.from(buckets.values()).map(({ entry, pages: pageSet }) => {
    entry.pages = Array.from(pageSet).sort((a, b) => a.localeCompare(b));
    entry.pageCount = entry.pages.length;
    entry.global = entry.pageCount > 1;
    return entry;
  });

  entries.sort((a, b) => {
    if (a.corpus !== b.corpus) return a.corpus.localeCompare(b.corpus);
    const levelA = HEADING_ORDER[a.kind] ?? 0;
    const levelB = HEADING_ORDER[b.kind] ?? 0;
    if (a.corpus === 'heading' && levelA !== levelB) return levelA - levelB;
    if (a.pageCount !== b.pageCount) return b.pageCount - a.pageCount;
    if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
    return a.text.localeCompare(b.text, 'de');
  });

  const languages = Array.from(languageCounts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const collectionMode: WordingDocument['collectionMode'] =
    modes.size === 1
      ? Array.from(modes)[0]
      : modes.size === 0
        ? 'playwright'
        : 'gemischt';

  return {
    generatedAt: new Date().toISOString(),
    sourceUrl,
    pagesAnalyzed: pages.length,
    language: languages[0]?.value ?? null,
    languages,
    collectionMode,
    salutation: detectSalutation(salutationCorpus),
    entries,
  };
};

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const MAX_ENTRIES_PER_CORPUS = 400;

const escapeMarkdown = (value: string): string =>
  value.replace(/([\\`*_[\]<>|])/g, '\\$1');

const quote = (value: string): string => `„${escapeMarkdown(value)}"`;

const renderHref = (href: string): string =>
  href.includes('`') ? escapeMarkdown(href) : `\`${href}\``;

const deriveName = (sourceUrl: string): string => {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, '');
    return host || sourceUrl;
  } catch {
    return sourceUrl;
  }
};

const shortenPage = (pageUrl: string, origin: string | null): string => {
  if (!origin || !pageUrl.startsWith(origin)) return pageUrl;
  const rest = pageUrl.slice(origin.length);
  return rest || '/';
};

const renderPages = (
  entry: WordingEntry,
  totalPages: number,
  origin: string | null,
): string => {
  if (entry.global) return `global, ${entry.pageCount}/${totalPages} Seiten`;
  const shown = entry.pages.slice(0, 3).map((page) => `\`${shortenPage(page, origin)}\``);
  const rest = entry.pages.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} weitere` : shown.join(', ');
};

const KIND_LABEL: Record<string, string> = {
  label: 'Label',
  placeholder: 'Placeholder',
  legend: 'Legende',
  option: 'Option',
  submit: 'Submit',
  title: 'Title',
  description: 'Description',
};

const renderEntry = (
  entry: WordingEntry,
  totalPages: number,
  origin: string | null,
  withKindLabel: boolean,
): string => {
  const prefix =
    withKindLabel && KIND_LABEL[entry.kind] ? `${KIND_LABEL[entry.kind]}: ` : '';
  const target = entry.href ? ` → ${renderHref(entry.href)}` : '';
  return `- ${prefix}${quote(entry.text)}${target} — ${renderPages(entry, totalPages, origin)}`;
};

const renderCorpus = (
  entries: WordingEntry[],
  totalPages: number,
  origin: string | null,
  withKindLabel: boolean,
): string[] => {
  if (entries.length === 0) return ['_Keine Einträge._'];
  const shown = entries.slice(0, MAX_ENTRIES_PER_CORPUS);
  const lines = shown.map((entry) =>
    renderEntry(entry, totalPages, origin, withKindLabel),
  );
  const dropped = entries.length - shown.length;
  if (dropped > 0) {
    lines.push('', `_… +${dropped} weitere Einträge (gekappt)._`);
  }
  return lines;
};

const COLLECTION_MODE_LABEL: Record<WordingDocument['collectionMode'], string> = {
  playwright: 'gerenderter DOM (Playwright)',
  'fetch-fallback': 'Fetch-Fallback (Sichtbarkeit nur eingeschränkt prüfbar)',
  gemischt: 'gemischt (Playwright + Fetch-Fallback)',
};

const renderSalutationLine = (salutation: WordingSalutation): string => {
  const parts = [
    `formell ${salutation.formalHits} Treffer (${salutation.formalStrongHits} stark, ${salutation.formalWeakHits} schwach)`,
    `informell ${salutation.informalHits} Treffer`,
  ];
  return `- Anrede: **${salutation.form}** — ${parts.join(', ')}`;
};

const renderMarkerLine = (salutation: WordingSalutation): string | null => {
  const groups: string[] = [];
  if (salutation.markers.formal.length > 0) {
    groups.push(`formell ${salutation.markers.formal.map((m) => `\`${m}\``).join(', ')}`);
  }
  if (salutation.markers.informal.length > 0) {
    groups.push(
      `informell ${salutation.markers.informal.map((m) => `\`${m}\``).join(', ')}`,
    );
  }
  if (salutation.markers.english.length > 0) {
    groups.push(
      `englisch ${salutation.markers.english.map((m) => `\`${m}\``).join(', ')}`,
    );
  }
  return groups.length > 0 ? `- Marker: ${groups.join(' · ')}` : null;
};

const renderLanguageLine = (doc: WordingDocument): string => {
  if (doc.languages.length === 0) return '- Sprache: unbekannt (kein `<html lang>`)';
  return `- Sprache: ${doc.languages
    .map((lang) => `\`${lang.value}\` (${lang.count} Seiten)`)
    .join(', ')}`;
};

export const renderWordingMarkdown = (doc: WordingDocument): string => {
  const origin = (() => {
    try {
      return new URL(doc.sourceUrl).origin;
    } catch {
      return null;
    }
  })();

  const byCorpus = (corpus: WordingCorpus, kind?: string): WordingEntry[] =>
    doc.entries.filter((e) => e.corpus === corpus && (!kind || e.kind === kind));

  const lines: string[] = [];
  lines.push(`# Wording — ${deriveName(doc.sourceUrl)}`);
  lines.push('');
  lines.push(renderLanguageLine(doc));
  lines.push(renderSalutationLine(doc.salutation));
  lines.push(
    `- Englisch: Anrede ${doc.salutation.englishAddressHits} · Selbstbezeichnung ${doc.salutation.englishWeHits}`,
  );
  const markerLine = renderMarkerLine(doc.salutation);
  if (markerLine) lines.push(markerLine);
  lines.push(
    `- Seiten: ${doc.pagesAnalyzed} · Einträge: ${doc.entries.length} · Erhebung: ${COLLECTION_MODE_LABEL[doc.collectionMode]}`,
  );
  lines.push(`- Generiert: ${doc.generatedAt}`);
  lines.push('');
  lines.push(
    '> Belegmaterial, kein Befund. Gesammelte Originaltexte aus dem gerenderten DOM',
  );
  lines.push('> des Scrapes — nach Consent-Dismissal und Lazy-Load, also nicht zwingend');
  lines.push('> identisch mit dem, was ein Erstbesucher sofort sieht.');
  lines.push('> Die Anrede ist eine Marker-Heuristik, keine linguistische Analyse.');
  lines.push('> `global` heißt: derselbe Text kommt auf mehreren Seiten vor.');
  lines.push('');

  lines.push('## CTAs');
  lines.push('');
  lines.push(...renderCorpus(byCorpus('cta'), doc.pagesAnalyzed, origin, false));
  lines.push('');

  lines.push('## Überschriften');
  lines.push('');
  const headings = byCorpus('heading');
  if (headings.length === 0) {
    lines.push('_Keine Einträge._');
    lines.push('');
  } else {
    // Die Kappung gilt für den Korpus, nicht je Level — sonst stünden hier bis zu
    // dreimal so viele Einträge wie in jedem anderen Abschnitt.
    const shown = headings.slice(0, MAX_ENTRIES_PER_CORPUS);
    for (const level of ['h1', 'h2', 'h3']) {
      const entries = shown.filter((entry) => entry.kind === level);
      if (entries.length === 0) continue;
      lines.push(`### ${level.toUpperCase()}`);
      lines.push('');
      lines.push(
        ...entries.map((entry) => renderEntry(entry, doc.pagesAnalyzed, origin, false)),
      );
      lines.push('');
    }
    const dropped = headings.length - shown.length;
    if (dropped > 0) {
      lines.push(`_… +${dropped} weitere Einträge (gekappt)._`);
      lines.push('');
    }
  }

  lines.push('## Navigation');
  lines.push('');
  lines.push(...renderCorpus(byCorpus('nav'), doc.pagesAnalyzed, origin, false));
  lines.push('');

  lines.push('## Formulare');
  lines.push('');
  lines.push(...renderCorpus(byCorpus('form'), doc.pagesAnalyzed, origin, true));
  lines.push('');

  lines.push('## Meta');
  lines.push('');
  lines.push(...renderCorpus(byCorpus('meta'), doc.pagesAnalyzed, origin, true));
  lines.push('');

  return `${lines.join('\n')}\n`.replace(/\n{3,}/g, '\n\n');
};
