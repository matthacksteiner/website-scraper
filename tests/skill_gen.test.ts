import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { MiniCdReport } from '../src/mini_cd';
import { writeSkill } from '../src/skill_gen';

const makeReport = (): MiniCdReport => ({
	sourceUrl: 'https://www.example.com',
	generatedAt: '2026-04-09T10:00:00.000Z',
	stats: {
		html: {
			pages: 3,
			elements: 1200,
			externalStylesheets: 4,
			inlineStyleElements: 2,
			inlineStyleAttributes: 15,
		},
		selectors: {
			styleRules: 500,
			selectors: 800,
			typeSelectors: 100,
			idSelectors: 10,
			classSelectors: 400,
			attributeSelectors: 20,
			pseudoSelectors: 50,
		},
	},
	colors: {
		all: [
			{ value: '#1c1c1e', count: 120 },
			{ value: '#ffffff', count: 100 },
			{ value: '#f07e00', count: 80 },
		],
		text: [{ value: '#1c1c1e', count: 100 }],
		background: [{ value: '#ffffff', count: 90 }],
		border: [{ value: '#e6e6e6', count: 50 }],
		fill: [{ value: '#f07e00', count: 20 }],
		other: [],
	},
	fonts: {
		all: [{ value: 'Source Sans Pro', count: 200 }],
		brand: [{ value: 'Source Sans Pro', count: 200 }],
		generic: [{ value: 'sans-serif', count: 100 }],
	},
	typography: {
		fontSizes: [{ value: '16px', count: 80 }],
		fontWeights: [{ value: '400', count: 120 }],
		lineHeights: [{ value: '1.5', count: 90 }],
	},
	layout: {
		spacing: [{ value: '16px', count: 60 }],
		borderRadius: [{ value: '8px', count: 20 }],
	},
	media: {
		queries: [{ value: '(max-width: 768px)', count: 20 }],
		breakpoints: [{ value: 'max-width 768px', count: 20 }],
	},
	headings: [],
	totals: {
		uniqueColors: 3,
		uniqueFonts: 1,
		uniqueFontSizes: 1,
		uniqueFontWeights: 1,
		uniqueLineHeights: 1,
		uniqueSpacingValues: 1,
		uniqueBorderRadiusValues: 1,
		mediaQueries: 1,
		breakpoints: 1,
	},
});

describe('writeSkill', () => {
	it('writes only a design.md file (no SKILL.md, no references/)', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'));
		try {
			await writeSkill(tmp, 'www.example.com', 'https://www.example.com', makeReport());
			const entries = await fs.readdir(tmp);
			expect(entries).toEqual(['design.md']);
			const content = await fs.readFile(path.join(tmp, 'design.md'), 'utf8');
			expect(content).toStartWith('---\n');
			expect(content).toContain('version: alpha');
			expect(content).toContain('name: example.com');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
