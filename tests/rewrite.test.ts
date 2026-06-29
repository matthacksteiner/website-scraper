import { describe, expect, it } from 'bun:test';
import { load } from 'cheerio';
import { rewriteHtml } from '../src/rewrite';

describe('rewriteHtml base tag handling', () => {
	it('removes <base href> so document-relative asset paths resolve locally', () => {
		const html = `<!doctype html><html><head>
			<base href="https://www.example.com/">
			<link rel="stylesheet" href="https://www.example.com/css/style.css">
		</head><body></body></html>`;

		const pageUrl = 'https://www.example.com/de/magazin/luftwechselrate';
		const pagePath = '/tmp/scrape/pages/de/magazin/luftwechselrate/index.html';
		const resourceMap = new Map<string, string>([
			[
				'https://www.example.com/css/style.css',
				'/tmp/scrape/pages/de/magazin/luftwechselrate/assets/css/style.css',
			],
		]);

		const result = rewriteHtml(
			html,
			pageUrl,
			pagePath,
			resourceMap,
			new Map(),
			false,
			false,
		);

		const $ = load(result);
		// The base tag must not point back at the live origin, otherwise the
		// browser resolves every relative asset URL against it and the local
		// files never load.
		expect($('base[href^="http"]').length).toBe(0);

		// The stylesheet should be rewritten to a document-relative local path.
		const cssHref = $('link[rel="stylesheet"]').attr('href');
		expect(cssHref).toBe('assets/css/style.css');
	});
});

describe('rewriteHtml consent stripping', () => {
	it('removes TYPO3 dp-consent-management banner and popup', () => {
		const html = `<!doctype html><html><head></head><body>
			<main><h1>Page</h1></main>
			<div class="dp-consent-management consent-banner">
				<div class="consent-banner-content">
					<button class="accept-consents">Accept</button>
				</div>
			</div>
			<dialog id="dp-consent-management-popup" class="dp-consent-management consent-popup-wrapper">
				<div class="dp-consent-management consent-popup">Settings</div>
			</dialog>
		</body></html>`;

		const result = rewriteHtml(
			html,
			'https://www.example.com/de/page',
			'/tmp/scrape/pages/de/page/index.html',
			new Map(),
			new Map(),
			false,
			true,
		);

		const $ = load(result);
		expect($('.consent-banner').length).toBe(0);
		expect($('#dp-consent-management-popup').length).toBe(0);
		expect($('[class*="dp-consent-management"]').length).toBe(0);
		// Real page content must survive.
		expect($('main h1').text()).toBe('Page');
	});

	it('removes content-blocker overlay and dangling consent controls, keeping media', () => {
		const html = `<!doctype html><html><head></head><body>
			<div class="video-wrapper">
				<video><source src="https://www.example.com/loop.mp4" type="video/mp4"></video>
				<div class="cookie-not-set-disclaimer" style="display: flex;">
					<p>Beim Laden können Daten von YouTube erhoben werden.</p>
					<button class="button configure-consents">Cookie-Einstellungen</button>
				</div>
			</div>
			<footer><a href="#" class="configure-consents">Cookie Einstellungen</a></footer>
		</body></html>`;

		const result = rewriteHtml(
			html,
			'https://www.example.com/de/page',
			'/tmp/scrape/pages/de/page/index.html',
			new Map(),
			new Map(),
			false,
			true,
		);

		const $ = load(result);
		expect($('.cookie-not-set-disclaimer').length).toBe(0);
		expect($('.configure-consents').length).toBe(0);
		// The underlying video must remain.
		expect($('video source').attr('src')).toBe('https://www.example.com/loop.mp4');
	});
});
