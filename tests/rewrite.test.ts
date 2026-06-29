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
