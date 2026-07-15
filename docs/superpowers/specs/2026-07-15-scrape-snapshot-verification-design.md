# Scrape-Snapshot-Verification — Design

**Datum:** 2026-07-15
**Status:** Umgesetzt (inkl. Codex-Review-Befund, Dedup- und `server.close`-Fix)

## Problem

Ein frisch gescrapetes Snapshot kann beim lokalen Öffnen viele Console-Errors,
JS-Exceptions und fehlende Assets (404) produzieren — ohne dass der Scrape-Lauf
das meldet. Der letzte Lauf hatte „sehr viele Console-Errors", die erst beim
manuellen Ansehen auffielen. Es fehlt ein automatischer Qualitäts-Check am Ende.

## Ziel

Ein Verifikations-Schritt, der das **erzeugte lokale Snapshot** so lädt, wie der
Nutzer es real ansieht (`npx http-server`), pro Seite Console-Errors,
JS-Exceptions und fehlgeschlagene Requests sammelt und einen Bericht schreibt.

- Läuft **automatisch am Ende von `bun run start`** (abschaltbar via `--no-verify`).
- Zusätzlich als **Standalone-Befehl `bun run verify`** für bestehende Scrapes.
- **Report + Warnung**: schreibt `verify-report.json` + `verify-report.md`, gibt
  eine Konsolen-Zusammenfassung aus, **Exit-Code bleibt 0** (rein informativ).
- Prüft **alle im Manifest erfassten Seiten**.

## Nicht-Ziele

- Kein automatisches Reparieren, kein Fail/Threshold (Exit-Code immer 0).
- Kein visueller Diff gegen die Live-Seite.
- Keine Änderung am Scrape- oder Serve-Verhalten selbst.

## Codex-Review-Befund (2026-07-15)

Ein Codex-Review am echten Output (`scrape-rausch.ch`, `no-single-file`) hat einen
zentralen Punkt aufgedeckt, der ins Report-Modell eingearbeitet wird:

- Die Snapshots sind **nicht** „statisch ohne Runtime-JS". `rewrite.ts` entfernt nur
  **Consent-Skripte**; App-Skripte bleiben erhalten (im Beispiel 182 Script-Tags,
  120 inline). Beim lokalen Öffnen läuft die App-JS erneut — ohne Backend — und
  erzeugt inhärent viele Console-Errors/Exceptions.
- Snapshots enthalten weiterhin **absolute Remote-URLs**; deren Requests gehen ins
  echte Netz, nicht an den lokalen Server.

**Konsequenz:** Der Verifier muss Befunde **nach Herkunft/Art trennen**, sonst
ertrinkt das eigentliche Signal (fehlende _lokale_ Ressourcen) im Runtime-Rauschen:

1. **Lokale fehlende Ressourcen** — Requests an den lokalen Server mit Status ≥ 400
   (v. a. 404 auf `assets/…`). **Actionable** = echtes Scrape-Qualitätssignal.
2. **Externe Requests** — Requests an fremde Hosts (absolute URLs). **Informativ.**
3. **Runtime-Diagnostik** — Console-Errors + JS-Exceptions. **Informativ**
   (erwartbar, wenn App-JS ohne Backend läuft).

Zusätzlich: Die README-Aussage „In this mode, runtime scripts are removed" ist
**falsch** und wird korrigiert (nur Consent-Skripte werden entfernt).

## Ansatz

**Gewählt: Lokaler statischer Server (in-process) + Playwright.**

Der Verifier startet einen **schlichten statischen Datei-Server** (kein
Manifest-Mapping), der `npx http-server` nachbildet, und lädt jede Seite in
Playwright. Damit reproduziert der Check exakt die Umgebung, in der der Nutzer
die Fehler sieht.

Verworfen:

- **`file://` + Playwright** — erzeugt CORS-Fehler (siehe README) → Fehlalarme.
- **`bun run serve` wiederverwenden** — dessen Manifest-Mapping (absolute
  `https://`-URLs → lokale Dateien) ist _nachsichtiger_ als `http-server` und
  würde real sichtbare Fehler verstecken. Der statische Server ist die strengere,
  ehrlichere Prüfung.
- **Statische HTML-Analyse ohne Browser** — fängt keine echten Console-/JS-Fehler.

## Architektur

### Neue/geänderte Module

- **`src/verify.ts`** _(neu, reine Funktionen — keine Klassen)_
  - `verifyScrape(rootDir, opts)` — Orchestrator: Manifest lesen → statischen
    Server starten → Playwright über alle Seiten → Report aggregieren → zurückgeben.
  - `buildVerifyReport(rawResults, meta)` — pure Aggregation der Rohergebnisse zu
    Totals + Report. **Unit-getestet.**
  - `renderVerifyMarkdown(report)` — pure Markdown-Erzeugung. **Unit-getestet.**
  - `startStaticServer(rootDir)` — kleiner statischer Server (Node `http` + `fs` +
    `mime-types`), ephemeral Port, gibt `{ url, close }` zurück.
- **`src/verify_cli.ts`** _(neu)_ — Standalone-CLI, analog zu `serve.ts` /
  `postprocess.ts`.
- **`src/scrape_dirs.ts`** _(neu)_ — `resolveLatestScrapeDir(scrapesDir)`, aktuell
  privat in `serve.ts`. Wird jetzt von `serve` **und** `verify` gebraucht → geteilt.
- **`src/serve.ts`** _(minimal geändert)_ — importiert `resolveLatestScrapeDir` aus
  `scrape_dirs.ts` statt lokaler Definition (2-Zeilen-Swap, Verhalten identisch).
- **`src/cli.ts`** _(geändert)_ — `--verify` (default) / `--no-verify`; nach
  `scraper.run()` Verify ausführen, Report schreiben, Summary ausgeben.
- **`src/types.ts`** _(geändert)_ — Verify-Report-Typen.
- **`package.json`** _(geändert)_ — Script `"verify": "bun dist/verify_cli.js"`.
- **`README.md`** _(geändert)_ — kurzer Abschnitt zum Verify-Schritt.

## Statischer Server (`startStaticServer`)

Bildet `npx http-server` für den Zweck nach:

- Root = Scrape-Output-Verzeichnis.
- Nur GET; Pfadauflösung mit Traversal-Schutz (`safeJoin`-Muster aus `serve.ts`).
- Verzeichnis-Request → `index.html` darin; fehlt sie → **404**.
- Datei-Request → Datei mit MIME-Type via `mime-types`; fehlt sie → **404**.
- **Kein** Manifest-Mapping (bewusst — spiegelt `http-server`).
- Bind an `127.0.0.1`, **ephemeral Port** (`0`), tatsächlichen Port aus
  `server.address()` lesen → kein Konflikt mit laufendem `http-server` (8080) oder
  `serve` (4173).

## Datenfluss

```
scrape → scrape-manifest.json
       → startStaticServer(root, ephemeral port)
       → für jede Seite (p-limit, concurrency):
            page.goto(localUrl, { waitUntil: 'networkidle', timeout })
            on('console')       → type==='error' | 'warning'
            on('pageerror')     → uncaught JS exception (message + stack)
            on('requestfailed') → url, method, resourceType, errorText
            on('response')      → status >= 400 → url, status, resourceType
       → buildVerifyReport(...)
       → verify-report.json + verify-report.md in den Scrape-Root
       → Konsolen-Summary (Exit 0)
```

Ein einzelner Browser, **eine `page` pro Task** (eigene Listener). Navigations-
Timeout aus `opts.timeoutMs`. Nach `goto` kurzer Settle (`waitForLoadState
('networkidle')` best-effort) für spät nachgeladene Requests.

## Datenstrukturen (`types.ts`)

```ts
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
  path: string; // lokaler Pfad, relativ zum Scrape-Root
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
```

## Was erkannt wird

Getrennt nach Herkunft/Art (siehe Codex-Befund):

**Actionable (Scrape-Qualität)**

- **Lokale fehlgeschlagene Requests** — Requests an den lokalen Server (gleicher
  Host:Port) mit Status ≥ 400 oder `requestfailed`. V. a. **404 auf `assets/…`** =
  fehlende/kaputte lokale Referenzen. **Headline-Signal.**

**Informativ (erwartbares Rauschen)**

- **Externe fehlgeschlagene Requests** — Requests an fremde Hosts (absolute URLs).
- **Console-Errors / -Warnings** — `console`-Events (`error` / `warning`).
- **JS-Exceptions** — `pageerror` (uncaught), mit Message + Stack.

**Sonstiges**

- **Navigations-Fehler** — `goto`-Timeout/Fehler → `navigated: false` + Grund.

Klassifikation `local` vs. `external`: Request-URL-Host/Port == lokaler
Server-Host/Port → `local`, sonst `external`.

## Report-Format

Beide Dateien im **Scrape-Root** (neben `design.md`, `scrape-manifest.json`):

- **`verify-report.json`** — vollständig, maschinenlesbar (`VerifyReport`).
- **`verify-report.md`** — menschenlesbar, klar nach Actionable/Informativ getrennt:
  - Kopf: `pagesChecked`, Actionable-Totals zuerst, dann informativ.
  - **Actionable:** lokale fehlende Ressourcen, gruppiert pro Seite.
  - **Informativ:** externe Requests, Console-Errors, JS-Exceptions (gezählt +
    Beispiele).

## Konsolen-Ausgabe (Report + Warnung)

Headline betont das **actionable** Signal. Exit-Code bleibt 0.

Mit lokalen Problemen:

```
Verify: 12 fehlende lokale Ressourcen auf 3/12 Seiten (actionable).
Zusätzlich (informativ): 5 externe Requests fehlgeschlagen, 27 Console-Errors,
2 JS-Exceptions. Details: <root>/verify-report.md
```

Ohne lokale Probleme:

```
Verify: keine fehlenden lokalen Ressourcen (12/12 Seiten).
Informativ: 27 Console-Errors, 5 externe Requests (Runtime-JS/Remote — erwartbar).
```

## CLI-Integration

### `bun run start`

- Neue Optionen: `--verify` (default `true`) / `--no-verify`.
- Nach `scraper.run()` und `"Scrape complete"`: bei aktivem Verify
  `verifyScrape(options.output, { concurrency, timeoutMs })`, Reports schreiben,
  Summary ausgeben.
- **Best-effort:** in `try/catch` gekapselt — schlägt Verify (Server/Browser)
  fehl, wird gewarnt, der Scrape bleibt erfolgreich (Exit 0).

### `bun run verify` (Standalone)

Optionen analog zu `serve`:

- `--dir <dir>` (default `.`)
- `--latest` + `--scrapes-dir <dir>` (default `scraped_sites`)
- `--concurrency <n>` (default 2)
- `--timeout-ms <n>` (default 30000)

## Fehlerbehandlung

- Verify ist **best-effort** und darf den Scrape nie fehlschlagen lassen.
- Kein Playwright verfügbar → Warnung, kein Report, Exit 0.
- Einzelne Seiten-Timeouts → Eintrag im Report (`navigated: false`), Lauf läuft weiter.
- Server/Browser werden in `finally` geschlossen.

## Tests

`tests/verify.test.ts` (pure Funktionen, kein Browser — konsistent mit
`design_md.test.ts` etc.):

- `buildVerifyReport` — Aggregation/Totals aus Fixture-Rohergebnissen
  (Null-Fall, gemischte Probleme, mehrere Seiten).
- `renderVerifyMarkdown` — Struktur/Inhalt für sauberen und für Problem-Report.

Der Playwright- und Server-Teil bleibt dünn und wird nicht unit-getestet.

## Offene Punkte

- Keine — alle Entscheidungen getroffen (lokales Snapshot, Report+Warnung, alle
  Seiten, `http-server`-Nachbildung, automatisch + standalone).
