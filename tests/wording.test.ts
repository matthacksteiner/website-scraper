import { describe, expect, it } from 'bun:test';
import {
  buildAgentContextDocument,
  renderAgentContextMarkdown,
} from '../src/agent_context';
import {
  buildWordingDocument,
  canonicalizeHref,
  cleanWordingText,
  detectSalutation,
  extractWordingFromHtml,
  isIconOnlyLabel,
  renderWordingMarkdown,
} from '../src/wording';

const page = (url: string, body: string, lang = 'de') =>
  extractWordingFromHtml({
    url,
    html: `<!doctype html><html lang="${lang}"><head><title>Beispiel</title>
      <meta name="description" content="Beschreibung der Seite">
    </head><body>${body}</body></html>`,
  });

const docFor = (...pages: ReturnType<typeof page>[]) =>
  buildWordingDocument('https://example.com', pages);

const textsOf = (snapshot: ReturnType<typeof page>, corpus: string) =>
  snapshot.items.filter((item) => item.corpus === corpus).map((item) => item.text);

describe('cleanWordingText', () => {
  it('collapses whitespace and strips invisible characters', () => {
    const raw = 'Jetzt​  an­fragen﻿\n\tund los';
    expect(cleanWordingText(raw)).toBe('Jetzt anfragen und los');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(cleanWordingText('  \n\t ')).toBe('');
  });
});

describe('isIconOnlyLabel', () => {
  it('rejects labels without letters or digits', () => {
    for (const value of ['→', '★', '»', '✕', '…', '🚀', '· ·']) {
      expect(isIconOnlyLabel(value)).toBeTrue();
    }
  });

  it('keeps labels with a letter or digit', () => {
    expect(isIconOnlyLabel('OK')).toBeFalse();
    expect(isIconOnlyLabel('1')).toBeFalse();
  });
});

describe('canonicalizeHref', () => {
  it('resolves and normalizes http targets', () => {
    expect(canonicalizeHref('/kontakt/', 'https://example.com/leistungen')).toBe(
      'https://example.com/kontakt',
    );
  });

  it('leaves non-navigational targets untouched', () => {
    expect(canonicalizeHref('mailto:hi@example.com', 'https://example.com')).toBe(
      'mailto:hi@example.com',
    );
    expect(canonicalizeHref('#main', 'https://example.com')).toBe('#main');
  });
});

describe('detectSalutation', () => {
  it('detects formal address from a German Sie text', () => {
    const doc = docFor(
      page(
        'https://example.com/',
        `<h1>Wir beraten Sie persönlich</h1>
         <h2>Ihre Vorteile auf einen Blick</h2>
         <button>Rufen Sie uns an</button>
         <form><label>Ihre E-Mail-Adresse</label>
           <input placeholder="Wie können wir Ihnen helfen?">
           <button type="submit">Absenden</button>
         </form>`,
      ),
    );
    expect(doc.salutation.form).toBe('Sie');
    expect(doc.salutation.formalStrongHits).toBeGreaterThan(0);
    expect(doc.salutation.informalHits).toBe(0);
  });

  it('detects informal address from a German du text', () => {
    const doc = docFor(
      page(
        'https://example.com/',
        `<h1>Finde deinen Kurs</h1>
         <h2>Das bekommst du</h2>
         <button>Jetzt loslegen</button>
         <form><label>Deine E-Mail</label>
           <input placeholder="Wie können wir dir helfen?">
         </form>`,
      ),
    );
    expect(doc.salutation.form).toBe('du');
    expect(doc.salutation.informalHits).toBeGreaterThan(0);
  });

  it('reports both counters for mixed address instead of guessing', () => {
    const doc = docFor(
      page(
        'https://example.com/',
        `<h1>Wir beraten Sie persönlich</h1>
         <h2>Ihre Vorteile</h2>
         <h3>Finde deinen Kurs</h3>
         <button>Jetzt loslegen und dir Zeit sparen</button>`,
      ),
    );
    expect(doc.salutation.form).toBe('gemischt');
    expect(doc.salutation.formalHits).toBeGreaterThan(0);
    expect(doc.salutation.informalHits).toBeGreaterThan(0);

    const markdown = renderWordingMarkdown(doc);
    expect(markdown).toContain('**gemischt**');
    expect(markdown).toContain(`formell ${doc.salutation.formalHits} Treffer`);
    expect(markdown).toContain(`informell ${doc.salutation.informalHits} Treffer`);
  });

  it('needs more than a single weak marker to call it formal', () => {
    const single = detectSalutation(['Sie kamen zu dritt']);
    expect(single.form).toBe('unbestimmt');
    expect(single.formalWeakHits).toBe(1);

    const twice = detectSalutation(['Sie sparen Zeit', 'Damit sind Sie schneller']);
    expect(twice.form).toBe('Sie');
  });

  it('does not count lowercase sie/ihr as formal address', () => {
    const result = detectSalutation(['sie kamen zu dritt und ihr Auto blieb stehen']);
    expect(result.formalHits).toBe(0);
    expect(result.form).toBe('unbestimmt');
  });

  it('never derives a German salutation from English pronouns', () => {
    const result = detectSalutation(['We build things for you and our clients']);
    expect(result.form).toBe('unbestimmt');
    expect(result.formalHits).toBe(0);
    expect(result.informalHits).toBe(0);
    expect(result.englishAddressHits).toBeGreaterThan(0);
    expect(result.englishWeHits).toBeGreaterThan(0);
  });
});

describe('extractWordingFromHtml', () => {
  it('drops hidden text, including a hidden ancestor', () => {
    const snapshot = page(
      'https://example.com/',
      `<h1>Sichtbar</h1>
       <h2 aria-hidden="true">Aria versteckt</h2>
       <h2 style="display:none">Inline versteckt</h2>
       <div hidden><h3>Vorfahre versteckt</h3></div>
       <div class="sr-only"><h3>Nur für Screenreader</h3></div>`,
    );
    expect(textsOf(snapshot, 'heading')).toEqual(['Sichtbar']);
  });

  it('keeps icon buttons with an accessible name and drops the rest', () => {
    const snapshot = page(
      'https://example.com/',
      `<button>→</button>
       <button>★</button>
       <button aria-label="Menü öffnen"><span aria-hidden="true">☰</span></button>
       <button><img src="x.svg" alt="Suche starten"></button>`,
    );
    const doc = docFor(snapshot);
    const ctas = doc.entries.filter((entry) => entry.corpus === 'cta').map((e) => e.text);
    expect(ctas.sort()).toEqual(['Menü öffnen', 'Suche starten']);
  });

  it('only treats real button classes as CTAs', () => {
    const snapshot = page(
      'https://example.com/',
      `<a class="btn" href="/a">Echter Button</a>
       <a class="subtle-btn-wrapper" href="/b">Kein Button</a>
       <a class="cta-primary" href="/c">CTA</a>`,
    );
    expect(textsOf(snapshot, 'cta').sort()).toEqual(['CTA', 'Echter Button']);
  });

  it('collects form labels, placeholders and the submit label', () => {
    const snapshot = page(
      'https://example.com/kontakt',
      `<form>
         <legend>Kontaktdaten</legend>
         <label for="mail">E-Mail-Adresse</label>
         <input id="mail" placeholder="name@example.com">
         <select><option>Bitte wählen</option></select>
         <button type="submit">Absenden</button>
       </form>`,
    );
    const items = snapshot.items.filter((item) => item.corpus === 'form');
    expect(items.map((item) => `${item.kind}:${item.text}`).sort()).toEqual([
      'label:E-Mail-Adresse',
      'legend:Kontaktdaten',
      'option:Bitte wählen',
      'placeholder:name@example.com',
      'submit:Absenden',
    ]);
  });
});

describe('buildWordingDocument', () => {
  it('folds an identical header across two pages into one global entry', () => {
    const header = `<nav><a href="/">Startseite</a></nav><h1>Willkommen</h1>`;
    const doc = docFor(
      page('https://example.com/', header),
      page('https://example.com/leistungen', header),
    );

    const nav = doc.entries.filter(
      (entry) => entry.corpus === 'nav' && entry.text === 'Startseite',
    );
    expect(nav).toHaveLength(1);
    expect(nav[0].pageCount).toBe(2);
    expect(nav[0].occurrences).toBe(2);
    expect(nav[0].global).toBeTrue();

    expect(renderWordingMarkdown(doc)).toContain('global, 2/2 Seiten');
  });

  it('counts salutation markers before dedup', () => {
    const body = '<h1>Wir beraten Sie und helfen Ihnen</h1>';
    const one = docFor(page('https://example.com/', body));
    const two = docFor(
      page('https://example.com/', body),
      page('https://example.com/b', body),
    );
    expect(two.salutation.formalHits).toBe(one.salutation.formalHits * 2);
  });

  it('reports every detected language', () => {
    const doc = docFor(
      page('https://example.com/', '<h1>Hallo</h1>', 'de'),
      page('https://example.com/en', '<h1>Hello</h1>', 'en'),
      page('https://example.com/b', '<h1>Servus</h1>', 'de'),
    );
    expect(doc.language).toBe('de');
    expect(doc.languages).toEqual([
      { value: 'de', count: 2 },
      { value: 'en', count: 1 },
    ]);
    expect(renderWordingMarkdown(doc)).toContain('`de` (2 Seiten), `en` (1 Seiten)');
  });

  it('marks the collection mode of the fetch fallback', () => {
    const doc = docFor(page('https://example.com/', '<h1>Hallo</h1>'));
    expect(doc.collectionMode).toBe('fetch-fallback');
    expect(renderWordingMarkdown(doc)).toContain('Fetch-Fallback');
  });
});

describe('renderWordingMarkdown', () => {
  it('escapes markdown metacharacters in collected copy', () => {
    const doc = docFor(
      page('https://example.com/', '<h1>Preis *ab* 10 [Euro] `netto`</h1>'),
    );
    const markdown = renderWordingMarkdown(doc);
    expect(markdown).toContain('\\*ab\\*');
    expect(markdown).toContain('\\[Euro\\]');
    expect(markdown).toContain('\\`netto\\`');
    expect(markdown).not.toContain('*ab*');
  });

  it('shortens page URLs against the source origin', () => {
    const doc = docFor(page('https://example.com/kontakt', '<h1>Kontakt</h1>'));
    expect(renderWordingMarkdown(doc)).toContain('`/kontakt`');
  });

  it('renders empty corpora explicitly', () => {
    const doc = buildWordingDocument('https://example.com', []);
    const markdown = renderWordingMarkdown(doc);
    expect(markdown).toContain('## CTAs');
    expect(markdown).toContain('_Keine Einträge._');
    expect(markdown).toContain('unbestimmt');
  });

  it('caps the heading corpus as a whole, not per level', () => {
    const body = Array.from(
      { length: 200 },
      (_, index) =>
        `<h1>Titel A ${index}</h1><h2>Titel B ${index}</h2><h3>Titel C ${index}</h3>`,
    ).join('');
    const doc = docFor(page('https://example.com/', body));
    expect(doc.entries.filter((entry) => entry.corpus === 'heading')).toHaveLength(600);

    const markdown = renderWordingMarkdown(doc);
    const headingSection = markdown.slice(
      markdown.indexOf('## Überschriften'),
      markdown.indexOf('## Navigation'),
    );
    const rendered = headingSection.split('\n').filter((line) => line.startsWith('- '));
    expect(rendered).toHaveLength(400);
    expect(headingSection).toContain('_… +200 weitere Einträge (gekappt)._');
  });

  it('contains the canonical sections in order', () => {
    const doc = docFor(page('https://example.com/', '<h1>Hallo</h1>'));
    const markdown = renderWordingMarkdown(doc);
    const sections = [
      '# Wording — example.com',
      '## CTAs',
      '## Überschriften',
      '## Navigation',
      '## Formulare',
      '## Meta',
    ];
    let lastIndex = -1;
    for (const heading of sections) {
      const index = markdown.indexOf(heading);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });
});

describe('agent context wording link', () => {
  const pages = [
    {
      url: 'https://example.com/',
      path: 'pages/index.html',
      depth: 0,
      status: 200,
      contentType: 'text/html',
      title: 'Beispiel',
      headings: ['Hallo'],
      htmlBytes: 100,
      elements: 10,
      stylesheets: 1,
      cssFiles: [],
      inlineCssFiles: [],
      inlineCssExtracted: 0,
      images: 0,
      scripts: 0,
    },
  ];

  it('references wording.md when the file was written', () => {
    const doc = buildAgentContextDocument(
      'https://example.com',
      'pages/index.html',
      pages,
      'wording.md',
    );
    expect(doc.wordingFile).toBe('wording.md');

    const markdown = renderAgentContextMarkdown(doc);
    expect(markdown).toContain('- Wording: wording.md');
    expect(markdown).toContain('2. Read root `wording.md`');
    expect(markdown).toContain('6. Avoid reading `scrape-log.jsonl`');
  });

  it('keeps the original numbering when there is no wording file', () => {
    const doc = buildAgentContextDocument(
      'https://example.com',
      'pages/index.html',
      pages,
    );
    expect(doc.wordingFile).toBeUndefined();

    const markdown = renderAgentContextMarkdown(doc);
    expect(markdown).not.toContain('wording.md');
    expect(markdown).toContain('2. Open root page HTML');
    expect(markdown).toContain('5. Avoid reading `scrape-log.jsonl`');
  });
});
