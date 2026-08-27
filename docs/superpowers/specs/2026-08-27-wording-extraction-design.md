# Wording-Extraktion — Design

**Datum:** 2026-08-27
**Status:** Spezifiziert (zwei Codex-Reviews eingearbeitet: Plan und Spec)

## Problem

Ein Scrape liefert Design-Tokens (`design.md`) und einen Seiten-Index
(`agent/context.*`), aber nichts über die **Sprache** der Seite. Wer die Seite
neu baut oder textlich überarbeitet, muss die vorhandenen Beschriftungen —
CTAs, Überschriften, Navigation, Formularfelder, Meta-Texte — von Hand aus dem
HTML klauben. Genau dieses Material ist beim Redesign die Grundlage dafür, die
bestehende Ansprache zu treffen statt sie versehentlich zu wechseln.

## Ziel

Nach jedem Scrape entsteht **`wording.md`** im Scrape-Root: das gesammelte
Textmaterial der Seite als Belegmaterial, plus **genau eine** Auswertung — die
Anrede (du / Sie / gemischt / unbestimmt).

- Quelle ist der bereits gerenderte DOM aus `capturePage`. **Kein zweiter Crawl.**
- **Keine LLM-Aufrufe**, kein API-Key, keine neuen Abhängigkeiten.
- Eigene Datei. **Nicht** in `design.md` — die folgt dem
  [google-labs-code/design.md](https://github.com/google-labs-code/design.md)-Spec
  und wird gelintet (`bun run design:lint`); freier Fließtext bricht sie.
- Abschaltbar via `--no-wording`, Default an.

## Nicht-Ziele

- Keine Tonalitäts-, Lesbarkeits- oder SEO-Bewertung. Die Datei ist
  Belegmaterial, kein Befund.
- Keine Umformulierungsvorschläge, kein Textgenerieren.
- Keine Volltext-Extraktion des Fließtexts — nur die unten genannten Korpora.
- Kein Eingriff in `design.md`, `verify-report.*` oder das Snapshot-HTML.
- Kein Nachziehen durch `bun run postprocess` (siehe „Bekannte Grenzen").

## Codex-Reviews

### Plan-Review (2026-08-27)

Drei Befunde haben die Architektur geändert:

1. **Cheerio allein trägt nicht.** Die Anforderung „Text aus `display:none`
   verwerfen" ist ohne `getComputedStyle` grundsätzlich nicht erfüllbar. Eine
   Klassen-Namensliste (`sr-only` & Co.) deckt weder Utility-Klassen noch
   Breakpoint-Regeln, geschlossene Dropdowns oder versteckte Vorfahren ab.
   → **Browserseitige Erhebung ist der Hauptpfad**, Cheerio nur der Fetch-Fallback.
2. **`captured.html` ist nicht das gespeicherte HTML.** `rewriteHtml()` entfernt
   danach noch Consent-DOM und schreibt URLs um. Im Browser-Pfad ist das
   unkritisch (der Consent-Layer ist per CSS versteckt und fällt durch den
   Sichtbarkeitsfilter); im Fetch-Fallback muss die Consent-Bereinigung
   **explizit** nachgeholt werden.
3. **Icon-Buttons sind oft korrekt beschriftet** — über `aria-label`,
   `aria-labelledby`, `title` oder `<img alt>`. Ein reiner Symbolfilter würde sie
   fälschlich verwerfen. → Erst **Accessible Name** bestimmen, dann filtern.

Weitere eingearbeitete Befunde: Unicode-Wortgrenzen statt `\b`, Marker-Zählung
**vor** dem Dedup, Dedup-Schlüssel mit Subtyp und kanonisiertem Ziel,
`pages` als Set, Sprache pro Seite statt nur Root, Markdown-Escaping,
Context-Verweis erst nach erfolgreichem Schreiben, `we/our/us` zählt nicht als
Anrede-Marker.

### Spec-Review (2026-08-27)

Der wichtigste Befund betrifft den **Zeitpunkt** der Erhebung:

- `capturePage` liest `page.content()` **vor** `collectComputedSnapshot()`, und
  jener Aufruf setzt die Viewport-Breite sechsmal um. Responsive JavaScript kann
  den DOM dabei umbauen, und die Wiederherstellung der Ursprungsbreite steht
  nicht in einem `finally` — bricht die Schleife ab, bleibt die Seite auf der
  letzten Breite stehen.
  → **`collectWordingSnapshot` läuft direkt nach `page.content()`**, vor jedem
  Resize. Damit beschreiben `wording.md` und das gespeicherte HTML denselben
  DOM-Zustand. Zusätzlich wandert die Viewport-Wiederherstellung in
  `collectComputedSnapshot` in ein `finally` — ein eigenständiger Bugfix, der
  nichts mit Wording zu tun hat, aber an derselben Stelle sitzt.

Weiter eingearbeitet: Sichtbarkeitsprüfung läuft die **ganze** Vorfahrenkette mit
`getComputedStyle` ab; `CapturedPage.wording` ist `WordingPageSnapshot | null`
und im Fetch-Pfad explizit `null`; `collectionMode` gehört ins Datenmodell;
`placeholder`/`content` sind eigene Textquellen; `href`-Regeln entwirrt
(`normalizeUrl` wirft bei relativen Werten); Marker-Liste bereinigt; `order` ist
Einfügereihenfolge; `buildAgentContextDocument` bekommt einen vierten Parameter;
Post-Tasks als zwei parallele Ketten.

## Ansatz

**Zwei Erhebungspfade, ein gemeinsames Rohformat, eine gemeinsame reine Pipeline.**

```
                          ┌─ Playwright ────────────> collectWordingSnapshot(page, url)
capturePage/capturePageFetch                           (page.evaluate: sichtbar + a11y-Name)
                          └─ Fetch-Fallback ────────> extractWordingFromHtml({url, html})
                                                       (cheerio, unvollständig)
                                   │
                                   ▼
                           WordingPageSnapshot[]   ← Rohitems, ungeputzt
                                   │
                                   ▼   src/wording.ts, reine Funktionen
              cleanWordingText → filter → detectSalutation → buildWordingDocument
                                   │
                                   ▼
                          renderWordingMarkdown → wording.md
```

Der Browser-Pfad bleibt **dünn** (DOM-Abfrage, Sichtbarkeit, Accessible Name —
kein Aufräumen, keine Bewertung), dasselbe Muster wie `collectComputedSnapshot`.
Alles Testbare liegt in `src/wording.ts` und wird browserfrei unit-getestet, wie
`design_md.test.ts` es vorgibt.

**Verworfen:** ein einziger Cheerio-Pfad (sieht `display:none` nicht);
Index-Abgleich zwischen Browser-`querySelectorAll` und Cheerio-Parse (bricht,
sobald parse5 den DOM anders normalisiert als der Browser).

## Neue/geänderte Module

- **`src/wording.ts`** _(neu, reine Funktionen — keine Klassen)_
  - `extractWordingFromHtml({ url, html, stripConsent })` → `WordingPageSnapshot`
    (Cheerio-Fallback; zugleich die Testoberfläche).
  - `cleanWordingText(raw)` → normalisierter Text.
  - `isIconOnlyLabel(text)` → `boolean`.
  - `detectSalutation(texts)` → `WordingSalutation`. **Unit-getestet.**
  - `buildWordingDocument(sourceUrl, pages)` → `WordingDocument`. **Unit-getestet.**
  - `renderWordingMarkdown(doc)` → Markdown. **Unit-getestet.**
- **`src/playwright_capture.ts`** _(geändert)_ — `collectWordingSnapshot(page, url)`,
  `CaptureOptions.collectWording`, `CapturedPage.wording`; `finally` für die
  Viewport-Wiederherstellung in `collectComputedSnapshot`.
- **`src/fetch_capture.ts`** _(geändert, 1 Zeile)_ — `wording: null` im Rückgabewert.
- **`src/rewrite.ts`** _(geändert, 1 Wort)_ — `stripConsentArtifacts` wird
  exportiert, damit der Fetch-Fallback dieselbe Consent-Bereinigung nutzt statt
  einer zweiten Selektorliste.
- **`src/types.ts`** _(geändert)_ — Wording-Typen + `ScrapeOptions.wording`.
- **`src/scraper.ts`** _(geändert)_ — `pageWordings[]`, `writeWordingFile()`,
  Fehler-Phase `'wording'`.
- **`src/agent_context.ts`** _(geändert)_ — optionales `wordingFile` in
  `AgentContextDocument` + Verweis in „Start Here".
- **`src/cli.ts`** _(geändert)_ — `--wording` (Default) / `--no-wording`.
- **`README.md`**, **`AGENTS.md`** _(geändert)_ — Feature, Output-Baum, Optionen,
  Modul-Map.
- **`tests/wording.test.ts`** _(neu)_.

## Datenstrukturen (`types.ts`)

```ts
export type WordingCorpus = 'cta' | 'heading' | 'nav' | 'form' | 'meta';

export type WordingCollectionMode = 'playwright' | 'fetch-fallback';

/** Ein Rohtreffer aus dem gerenderten DOM — ungeputzt, ungefiltert. */
export interface WordingRawItem {
  corpus: WordingCorpus;
  /** Subtyp: 'h1'|'h2'|'h3' | 'button'|'link'|'submit' | 'link'|'menuitem'
   *  | 'label'|'placeholder'|'legend'|'option'|'submit' | 'title'|'description' */
  kind: string;
  text: string;
  /** Kanonisiertes Ziel, nur bei CTA/Nav (siehe „Erhebung → href"). */
  href?: string;
  /** Einfügereihenfolge der Rohitems innerhalb der Seite, ab 0. */
  order: number;
}

export interface WordingPageSnapshot {
  url: string;
  /** <html lang>, lowercase+getrimmt, oder null. */
  lang: string | null;
  collectionMode: WordingCollectionMode;
  items: WordingRawItem[];
}

export interface WordingEntry {
  corpus: WordingCorpus;
  kind: string;
  text: string;
  href?: string;
  /** Seiten-URLs, auf denen der Eintrag vorkommt (dedupliziert, sortiert). */
  pages: string[];
  /** pages.length */
  pageCount: number;
  /** Gesamtvorkommen über alle Seiten (kann > pageCount sein). */
  occurrences: number;
  /** pageCount > 1 — derselbe Text auf mehreren Seiten. */
  global: boolean;
}

export type WordingSalutationForm = 'du' | 'Sie' | 'gemischt' | 'unbestimmt';

export interface WordingSalutation {
  form: WordingSalutationForm;
  /** Starke formelle Marker (Ihnen, Ihre, Ihrem, …), Gewicht 2. */
  formalStrongHits: number;
  /** Schwache formelle Marker (Sie, Ihr), Gewicht 1. */
  formalWeakHits: number;
  /** formalStrongHits + formalWeakHits */
  formalHits: number;
  informalHits: number;
  /** Englische Anrede (you/your/yours) — informativ, entscheidet nichts. */
  englishAddressHits: number;
  /** Englische Selbstbezeichnung (we/our/us/ours) — informativ. */
  englishWeHits: number;
  /** Tatsächlich gefundene Marker je Gruppe, alphabetisch, max. 12. */
  markers: { formal: string[]; informal: string[]; english: string[] };
}

export interface WordingDocument {
  generatedAt: string;
  sourceUrl: string;
  pagesAnalyzed: number;
  /** Häufigste <html lang> über alle Seiten, oder null. */
  language: string | null;
  /** Alle vorgefundenen Sprachen mit Seitenzahl, absteigend. */
  languages: Array<{ value: string; count: number }>;
  /** 'playwright' | 'fetch-fallback' | 'gemischt' */
  collectionMode: WordingCollectionMode | 'gemischt';
  salutation: WordingSalutation;
  entries: WordingEntry[];
}
```

Weiter:

- `ScrapeOptions.wording: boolean`.
- `CapturedPage.wording: WordingPageSnapshot | null` — `capturePageFetch` gibt
  hier explizit `null` zurück, damit das Feld Pflicht bleiben kann.
- `AgentContextDocument.wordingFile?: string` (posix, relativ zum Scrape-Root).

## Erhebung — was gesammelt wird

Beide Pfade liefern dieselben Korpora. `order` ist die **Einfügereihenfolge der
Rohitems** einer Seite (ab 0, über alle Korpora fortlaufend) — nicht der
DOM-Index, weil die Erhebung über mehrere Selektorgruppen nacheinander läuft und
ein Element in zwei Korpora landen darf. Innerhalb einer Selektorgruppe ist die
Reihenfolge die des DOM.

| Korpus    | Selektoren                                                                                                                | `kind`                                                   | `href`       |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------ |
| `heading` | `h1, h2, h3`                                                                                                              | Tagname                                                  | –            |
| `cta`     | `button`, `[role="button"]`, `input[type="submit"]`, `input[type="button"]`, `input[type="image"]`, `a` mit Button-Klasse | `button` / `link` / `submit`                             | ja (bei `a`) |
| `nav`     | `nav a`, `nav button`, `[role="navigation"] a`, `[role="navigation"] button`, `[role="menuitem"]`                         | `link` / `menuitem`                                      | ja (bei `a`) |
| `form`    | je `form`: `label`, `[placeholder]`, `legend`, `option`, Submit-Control                                                   | `label` / `placeholder` / `legend` / `option` / `submit` | –            |
| `meta`    | `title`, `meta[name="description"]`                                                                                       | `title` / `description`                                  | –            |

**H1–H3 bewusst, nicht H1–H6:** so vorgegeben; H4–H6 sind auf den meisten Seiten
Struktur-Rauschen (Footer-Spaltenköpfe, Karten-Titel in Listen) und würden das
Belegmaterial verwässern. Die Grenze steht in der Datei.

**Button-Klasse** (bewusst eng, gegen Fehlklassifikation durch
`[class*="btn"]`): ein Klassen-**Token**, das exakt `btn`, `button` oder `cta`
lautet oder mit `btn-`, `btn_`, `button-` oder `cta-` beginnt.

**Doppelerfassung:** Ein Element kann in mehreren Korpora landen (ein
`nav a.btn` ist Nav **und** CTA). Das ist gewollt — die Korpora sind Sichten,
keine Partition. Innerhalb eines Korpus wird jedes Element genau einmal erfasst.

### Textquelle je `kind`

| `kind`        | Text                                                  |
| ------------- | ----------------------------------------------------- |
| `placeholder` | Attributwert `placeholder`                            |
| `description` | Attributwert `content` von `meta[name="description"]` |
| `title`       | Textinhalt von `<title>`                              |
| `option`      | Textinhalt, ersatzweise Attribut `label`              |
| alle übrigen  | **Accessible Name**, siehe unten                      |

**Accessible Name** (erster nicht-leerer gewinnt):

1. sichtbarer Textinhalt des Elements (versteckte Nachfahren ausgelassen)
2. `aria-label`
3. `aria-labelledby` → Text der referenzierten Elemente, per Leerzeichen verbunden
4. `value` (bei `input`)
5. `alt` — bei `input[type="image"]` und bei einem einzelnen `<img>` im Element
6. `title`

Für `label` wird die `for`/Control-Zuordnung **nicht** modelliert — die
Beschriftung ist das Belegmaterial, nicht die Feldbindung.

### `href`

`normalizeUrl()` aus `src/url.ts` erwartet eine absolute URL und wirft sonst.
Deshalb gilt:

- Der Rohwert kommt aus `getAttribute('href')`, nicht aus `element.href`
  (das der Browser bereits auflöst und dabei `#`/`javascript:` verfälscht).
- Ist der Wert leer → kein `href` im Item.
- Beginnt er mit `mailto:`, `tel:`, `javascript:` oder `#` → **unverändert**
  übernehmen.
- Sonst gegen die Seiten-URL zu einer absoluten URL auflösen. Ist das Ergebnis
  `http(s)`, zusätzlich durch `normalizeUrl()` schicken (entfernt Fragment,
  vereinheitlicht den Trailing Slash), damit `/kontakt` und
  `https://example.com/kontakt/` denselben Eintrag treffen. Schlägt das
  Auflösen fehl, den Rohwert übernehmen.

### Browser-Pfad (`collectWordingSnapshot`)

Ein `page.evaluate`, ausgeführt **direkt nach `page.content()`** und damit
**vor** `collectComputedSnapshot()` und dessen Viewport-Resizes. Grund: die
Resize-Schleife kann responsive JS-Umbauten auslösen; liefe Wording danach,
beschriebe es einen anderen DOM als das gespeicherte HTML.

Sichtbarkeit wird über die **gesamte Vorfahrenkette** geprüft — für das Element
und jeden Vorfahren bis `document.documentElement`:

- `getComputedStyle(el).display === 'none'`
- `visibility` ist `hidden` oder `collapse`
- `opacity === '0'`
- `el.hidden`, `[aria-hidden="true"]`, `[inert]`

Trifft eines davon irgendwo in der Kette, gilt das Element als versteckt und
liefert kein Item. Beim Einsammeln des Textinhalts werden **versteckte
Nachfahren übersprungen**, damit `.textContent` nichts einsammelt, was die Seite
nie zeigt.

Von der Sichtbarkeitsprüfung ausgenommen: `title` und `meta` (nie gerendert)
sowie `option` (im geschlossenen `select` unsichtbar, aber Beschriftung).

**Visually-Hidden zählt nicht als Name.** Ein `<span class="sr-only">Menü
öffnen</span>` in einem Icon-Button ist per `display:none`/`clip` unsichtbar und
fällt damit aus dem sichtbaren Textinhalt heraus. Der Button bekommt seinen
Namen dann nur noch aus `aria-label`/`aria-labelledby`/`title`/`alt`; hat er
keinen, fällt er raus. Das ist die Konsequenz aus „Text aus sr-only verwerfen"
und steht in der Datei.

### Fetch-Fallback (`extractWordingFromHtml`)

Cheerio über `captured.html`, nur wenn Playwright nicht startet.
Vorher `stripConsentArtifacts($)`, wenn `stripConsent` aktiv ist — sonst landen
Cookie-Banner-Texte im Korpus.

Erkennt als versteckt (am Element **oder** an einem Vorfahren): `[hidden]`,
`[aria-hidden="true"]`, `[inert]`, inline `style` mit `display:none` /
`visibility:hidden` / `opacity:0`, sowie Klassen-Tokens aus einer festen Liste:
`sr-only`, `sr-only-focusable`, `visually-hidden`, `visuallyhidden`,
`screen-reader-text`, `screen-reader-only`, `a11y-hidden`, `hidden`, `is-hidden`,
`d-none`.

**Dieser Pfad ist ausdrücklich unvollständig** (CSS-getriebenes `display:none`
ist unsichtbar) und wird in `wording.md` über `collectionMode` gekennzeichnet.

## Aufräumen — Reihenfolge

Pro Rohitem, in genau dieser Reihenfolge:

1. **Sichtbarkeit** — bereits bei der Erhebung entschieden; versteckte Elemente
   **und** versteckte Nachfahren-Texte kommen gar nicht erst ins Rohitem.
2. **Unsichtbare Zeichen entfernen** — `U+200B`, `U+200C`, `U+200D`, `U+FEFF`,
   dazu Soft-Hyphen `U+00AD` (derselbe Effekt: unsichtbares Zeichen im Wort) und
   C0-Steuerzeichen, damit kein Trennzeichen im Dedup-Schlüssel kollidiert.
3. **Whitespace kollabieren** — `\s+` inkl. `U+00A0` → ein Leerzeichen, trimmen.
4. **Leer verwerfen** — nach dem Trimmen leerer Text fällt raus.
5. **Icon-Beschriftung verwerfen** — Text ohne einen einzigen Buchstaben und ohne
   Ziffer: `!/[\p{L}\p{N}]/u.test(text)`. Trifft `→`, `★`, `»`, `✕`, `…`, Emoji,
   reine Interpunktion. Ein `1` (Paginierung) oder `OK` bleibt drin.

Schritt 2–5 laufen in `wording.ts` und gelten für **beide** Erhebungspfade — die
reine Pipeline ist die einzige Stelle, die putzt.

## Dedup, Zähler, `global`

**Schlüssel:** `JSON.stringify([corpus, kind, text, href ?? ''])`. Kein
Trennzeichen, das in einem der Teile vorkommen könnte — `href` wird bei
`mailto:`/`tel:`/`javascript:`/`#` unverändert übernommen und ist damit nicht
von Steuerzeichen bereinigt, ein Trenner-Ansatz wäre dort nicht kollisionssicher.

**Zähler:**

- `pages` — intern `Set<normalizedPageUrl>`, am Ende sortiertes Array.
- `pageCount` — `pages.length`.
- `occurrences` — jedes Rohitem zählt, auch mehrfach auf derselben Seite.
- `global` — `pageCount > 1`.

`global` heißt hier „auf mehreren Seiten identisch", nicht „auf allen". Die
Legende sagt das wörtlich, und gerendert wird `global, 5/7 Seiten`, damit die
Zahl den Begriff korrigiert.

**Sortierung** innerhalb eines Korpus: `pageCount` absteigend, dann
`occurrences` absteigend, dann Text alphabetisch (`localeCompare('de')`).
Headings zusätzlich nach Level gruppiert (h1 → h2 → h3).

## Anrede-Erkennung — die eine Auswertung

Korpus: **alle gereinigten Rohitem-Texte aller Seiten, vor dem Dedup** — sonst
zählte eine auf fünf Seiten wiederholte Navigation nur einmal und die Zahlen
wären weder Vorkommen noch Seitenzahl.

Wortgrenzen über Unicode-Lookarounds statt `\b` (das bleibt auch mit `/u`-Flag
ASCII-orientiert und trennt an `ä`/`ü`/`ß` falsch):

```
(?<![\p{L}\p{N}_])MARKER(?![\p{L}\p{N}_])
```

**Formell stark** (eindeutig Anrede), Gewicht 2:
`Ihnen`, `Ihre`, `Ihrem`, `Ihren`, `Ihrer`, `Ihres`, `Ihrerseits`.

**Formell schwach** (am Satzanfang mehrdeutig — `Sie` kann „they" sein, `Ihr`
das Possessivpronomen der 3. Person Plural), Gewicht 1: `Sie`, `Ihr`.

Beide formellen Gruppen werden **case-sensitiv** gematcht: bei orthografisch
korrekter formeller Anrede ist die Großschreibung verpflichtend, und
kleingeschriebenes `sie`/`ihr`/`ihre` ist fast immer 3. Person.

**Informell**, case-insensitiv, Gewicht 1:
`du`, `dich`, `dir`, `dein`, `deine`, `deinem`, `deinen`, `deiner`, `deines`,
`deins`, `euch`, `euer`, `eure`, `eurem`, `euren`, `eurer`, `eures`,
`eurerseits`.

`ihr` steht **nicht** in dieser Liste: als informelle Anrede der 2. Person
Plural ist es von der 3. Person Singular/Plural nicht zu unterscheiden.

**Englisch** — informativ, entscheidet nie:
Anrede `you`, `your`, `yours`; Selbstbezeichnung `we`, `our`, `us`, `ours`.
`we/our/us` sind keine Anrede-Marker und fließen in **keinen** deutschen Zähler.

**Verdikt:**

```
formalScore = 2 * formalStrongHits + formalWeakHits
isFormal    = formalScore >= 2
isInformal  = informalHits >= 1

isFormal && isInformal  → 'gemischt'   (beide Zähler ausgeben, nicht raten)
isFormal                → 'Sie'
isInformal              → 'du'
sonst                   → 'unbestimmt'
```

Die Schwelle `>= 2` fängt den Einwand „`Sie` kann _they_ heißen" ab, ohne das
Signal zu zerstören: ein einzelnes `Sie` reicht nicht, ein einzelnes `Ihnen`
oder zwei `Sie` reichen. Ein Satzanfangs-Filter wäre hier wertlos — fast jeder
Eintrag dieses Korpus (Heading, CTA, Label) beginnt ohne vorangehenden Satz und
würde verworfen.

Das Ergebnis heißt in `wording.md` ausdrücklich **Marker-Heuristik**, mit den
gefundenen Markern als Beleg.

## Sprache

`<html lang>` wird **pro Seite** erhoben (lowercase, getrimmt, leer → `null`).
`languages` listet alle Werte mit Seitenzahl absteigend, `language` ist der
häufigste. Bei mehr als einem Wert nennt die Kopfzeile alle, damit mehrsprachige
Scrapes nicht auf eine Sprache eingedampft werden.

## `wording.md` — Format

Im Scrape-Root, neben `design.md` und `verify-report.md`.

```markdown
# Wording — example.com

- Sprache: `de` (7 Seiten)
- Anrede: **gemischt** — formell 14 Treffer (10 stark, 4 schwach), informell 6 Treffer
- Englisch: Anrede 0 · Selbstbezeichnung 0
- Marker: formell `Ihnen`, `Ihre`, `Sie` · informell `dein`, `du`
- Seiten: 7 · Einträge: 132 · Erhebung: gerenderter DOM (Playwright)
- Generiert: 2026-08-27T09:12:44.201Z

> Belegmaterial, kein Befund. Gesammelte Originaltexte aus dem gerenderten DOM
> des Scrapes — nach Consent-Dismissal und Lazy-Load, also nicht zwingend
> identisch mit dem, was ein Erstbesucher sofort sieht.
> Die Anrede ist eine Marker-Heuristik, keine linguistische Analyse.
> `global` heißt: derselbe Text kommt auf mehreren Seiten vor.

## CTAs

- „Jetzt anfragen" → `/kontakt` — global, 7/7 Seiten
- „Mehr erfahren" → `/leistungen` — `/`

## Überschriften

### H1

- „Willkommen bei Example" — `/`

### H2

- „Unsere Leistungen" — `/`, `/leistungen`

## Navigation

- „Startseite" → `/` — global, 7/7 Seiten

## Formulare

- Label: „E-Mail-Adresse" — `/kontakt`
- Placeholder: „Ihre Nachricht" — `/kontakt`
- Submit: „Absenden" — `/kontakt`

## Meta

- Title: „Example — Startseite" — `/`
- Description: „Wir helfen Ihnen bei…" — `/`
```

**Rendern:**

- Seiten-URL wird relativ zur Origin der `sourceUrl` gekürzt (`/kontakt` statt
  `https://example.com/kontakt`), wenn die Origin übereinstimmt.
- Bei `global`: `global, N/M Seiten` statt einer langen URL-Liste. Sonst bis zu
  drei Seiten aufzählen, darüber die ersten drei plus `+N weitere`.
- Leerer Korpus → `_Keine Einträge._`
- **Escaping:** Texte stehen in `„…"`; vorher werden `\`, `` ` ``, `*`, `_`,
  `[`, `]`, `<`, `>`, `|` escaped. Zeilenumbrüche sind durch das
  Whitespace-Kollabieren schon weg. `href` steht in Backticks; enthält es selbst
  einen Backtick, wird es escaped statt in Code gesetzt.
- Maximal **400 Einträge pro Korpus**. Wird gekappt, steht darunter
  `_… +N weitere Einträge (gekappt)._` — kein stilles Abschneiden.
- `Erhebung:` zeigt `gerenderter DOM (Playwright)`,
  `Fetch-Fallback (Sichtbarkeit nur eingeschränkt prüfbar)` oder `gemischt`.

## Pipeline-Verdrahtung (`scraper.ts`)

`capturePage` bekommt `collectWording: this.options.wording`. In `processPage`,
direkt nachdem `captured.computedSnapshot` verarbeitet wurde:

```ts
if (this.options.wording) {
  this.pageWordings.push(
    captured.wording ??
      extractWordingFromHtml({
        url: item.url,
        html: captured.html,
        stripConsent: this.options.stripConsent,
      }),
  );
}
```

Die Rohitems entstehen damit **vor** `rewriteHtml()` — mit den originalen
Link-Zielen statt der lokalen Snapshot-Pfade. Das ist gewollt: `wording.md`
beschreibt die Live-Seite, nicht die Ordnerstruktur des Snapshots.

**Post-Tasks:** zwei parallele Ketten in `Promise.allSettled`, damit der
Context-Verweis nur entsteht, wenn die Datei auch existiert:

```ts
const designTask = this.writeDesignFile(report).catch((error) => {
  this.storage.recordError({
    /* … phase: 'design' */
  });
});

const contextTask = (async () => {
  const wordingFile = await this.writeWordingFile(); // string | null
  await this.writeAgentContext(wordingFile);
})().catch((error) => {
  this.storage.recordError({
    /* … phase: 'agent-context' */
  });
});

await Promise.allSettled([designTask, contextTask]);
```

`writeWordingFile()` fängt eigene Fehler, meldet sie über
`storage.recordError({ phase: 'wording' })` und gibt `null` zurück — ein
fehlgeschlagenes Wording darf den Agent-Context nicht mitreißen. Bei
`--no-wording` wird gar nicht geschrieben und `wordingFile` ist `null`.

Event-Log: `{ type: 'wording-written', wordingPath, entries, salutation }`.

## Agent-Context-Verweis

`buildAgentContextDocument` bekommt einen vierten, optionalen Parameter:

```ts
buildAgentContextDocument(sourceUrl, rootPagePath, pages, wordingFile?: string | null)
```

- `context.json`: `wordingFile: "wording.md"` — das Feld fehlt, wenn nicht
  geschrieben.
- `context.md`, „Start Here": neuer Punkt **2** nach dem `design.md`-Punkt —
  `Read root \`wording.md\` for existing copy (CTAs, headings, nav, forms) and the
  detected salutation before rewriting any text.` Die folgenden Punkte rücken auf
  3–6. Fehlt die Datei, bleibt die Liste unverändert bei 1–5.

## CLI

Commander, analog zu `--verify`, **ohne** interaktiven Prompt und ohne
Raw-Args-Sonderlogik:

```ts
.option('--wording', 'Extract page copy into wording.md', true)
.option('--no-wording', 'Skip wording extraction')
```

→ `wording: Boolean(opts.wording)` in `ScrapeOptions`.

## Tests (`tests/wording.test.ts`)

Im Stil von `design_md.test.ts`: HTML-Fixtures durch `extractWordingFromHtml`,
dann `buildWordingDocument` + `renderWordingMarkdown`, alles browserfrei.

| Fixture                             | Prüft                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Deutscher Sie-Text                  | `form === 'Sie'`, `formalStrongHits > 0`, `informalHits === 0`                                                |
| Deutscher du-Text                   | `form === 'du'`                                                                                               |
| Gemischte Anrede                    | `form === 'gemischt'`, **beide** Zähler > 0 und im Markdown sichtbar                                          |
| Identischer Header über zwei Seiten | ein Eintrag, `pageCount === 2`, `global === true`, `occurrences === 2`; Markdown enthält `global, 2/2 Seiten` |
| Nur Icon-Buttons                    | `→`/`★`/Emoji-Button fällt raus; Button mit `aria-label` bleibt mit dem Accessible Name                       |

Zusätzlich, weil die Regeln sonst ungeprüft blieben:

- Zero-Width, Soft-Hyphen, `&nbsp;` und Mehrfach-Whitespace werden zusammengefasst.
- `aria-hidden="true"` und ein Vorfahre mit `hidden` verwerfen den Text.
- Ein einzelnes `Sie` ohne weiteren Marker ergibt `unbestimmt` (Schwelle).
- `we/our/us` allein ergibt `unbestimmt` und erhöht keinen deutschen Zähler.
- `href`: relativer Link wird kanonisiert, `mailto:`/`#` bleiben unverändert.
- Markdown-Escaping: ein Text mit `*`, `[`, `` ` `` bricht die Liste nicht.
- Leerer Korpus rendert `_Keine Einträge._`.
- `buildAgentContextDocument` / `renderAgentContextMarkdown` mit und ohne
  `wordingFile`: Feld gesetzt bzw. fehlend, „Start Here" 1–6 bzw. 1–5.

Der Playwright-Teil (`collectWordingSnapshot`) bleibt dünn und wird nicht
unit-getestet — dasselbe Vorgehen wie bei `collectComputedSnapshot` und dem
Server/Browser-Teil von `verify.ts`. Das Risiko „falscher DOM-Zustand" wird
nicht durch einen Test abgefangen, sondern durch die Platzierung direkt nach
`page.content()`, also vor jedem Viewport-Resize.

## Verifikation vor der Fertigmeldung

`bun test`, `bun run typecheck`, `bun run lint`, `bun run format:check`,
`bun run build` — und ein **echter CLI-Scrape** gegen eine reale Seite, einmal
mit Default und einmal mit `--no-wording`, plus ein Blick in die erzeugte
`wording.md`.

## Bekannte Grenzen

- **Fetch-Fallback sieht kein CSS.** Ohne Playwright werden nur Attribut- und
  Inline-Style-basierte Verstecke erkannt. `collectionMode` sagt, welcher Pfad lief.
- **`capturePage` hat den DOM bereits angefasst** — Consent-Dismissal,
  Lazy-Load-Materialisierung, Auto-Scroll, Reload. `wording.md` beschreibt den
  aufbereiteten Capture-Zustand, nicht den unberührten Erstaufruf.
- **`bun run postprocess` zieht `wording.md` nicht nach.** Die Datei beschreibt
  den Stand des ursprünglichen Scrapes; Postprocessing ändert nur
  Asset-Referenzen, keine Texte — macht sie also nicht falsch, aber auch nicht
  aktueller.
- **Die Anrede ist eine Heuristik.** Marker-Zählung, keine Grammatikanalyse.
  Zitate, Fremdsprachen und Eigennamen können sie verschieben; deshalb stehen
  die Zähler und die gefundenen Marker mit in der Datei.

## Offene Punkte

Keine — alle Entscheidungen getroffen.
