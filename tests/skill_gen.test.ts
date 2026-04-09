import { describe, expect, it } from 'bun:test';
import { MiniCdReport } from '../src/mini_cd';
import {
	buildSkillMd,
	buildColorsRef,
	buildTypographyRef,
	buildLayoutRef,
	buildResponsiveRef,
} from '../src/skill_gen';

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
		text: [
			{ value: '#1c1c1e', count: 100 },
			{ value: '#ffffff', count: 40 },
		],
		background: [
			{ value: '#ffffff', count: 90 },
			{ value: '#f5f5f5', count: 30 },
		],
		border: [{ value: '#e6e6e6', count: 50 }],
		fill: [{ value: '#f07e00', count: 20 }],
		other: [],
	},
	fonts: {
		all: [
			{ value: 'Source Sans Pro', count: 200 },
			{ value: 'sans-serif', count: 100 },
		],
		brand: [{ value: 'Source Sans Pro', count: 200 }],
		generic: [{ value: 'sans-serif', count: 100 }],
	},
	typography: {
		fontSizes: [
			{ value: '16px', count: 80 },
			{ value: '14px', count: 60 },
			{ value: '18px', count: 40 },
		],
		fontWeights: [
			{ value: '700', count: 50 },
			{ value: '400', count: 120 },
		],
		lineHeights: [
			{ value: '1.5', count: 90 },
			{ value: '1.2', count: 40 },
		],
	},
	layout: {
		spacing: [
			{ value: '16px', count: 60 },
			{ value: '8px', count: 40 },
			{ value: '24px', count: 30 },
		],
		borderRadius: [
			{ value: '4px', count: 30 },
			{ value: '8px', count: 20 },
		],
	},
	media: {
		queries: [
			{ value: '(max-width: 768px)', count: 20 },
			{ value: '(min-width: 1024px)', count: 15 },
		],
		breakpoints: [
			{ value: 'max-width 768px', count: 20 },
			{ value: 'min-width 1024px', count: 15 },
		],
	},
	headings: [
		{
			heading: 'h1',
			breakpoint: 'default',
			fontFamilies: [{ value: 'Source Sans Pro', count: 10 }],
			fontSizes: [{ value: '32px', count: 10 }],
			fontWeights: [{ value: '700', count: 10 }],
			lineHeights: [{ value: '1.2', count: 10 }],
		},
	],
	totals: {
		uniqueColors: 3,
		uniqueFonts: 2,
		uniqueFontSizes: 3,
		uniqueFontWeights: 2,
		uniqueLineHeights: 2,
		uniqueSpacingValues: 3,
		uniqueBorderRadiusValues: 2,
		mediaQueries: 2,
		breakpoints: 2,
	},
});

describe('buildSkillMd', () => {
	it('generates valid frontmatter and design tokens', () => {
		const report = makeReport();
		const md = buildSkillMd('www.example.com', 'https://www.example.com', report);

		expect(md).toStartWith('---\n');
		expect(md).toContain('name: design-www.example.com');
		expect(md).toContain('description:');
		expect(md).toContain('# Design System: www.example.com');
		expect(md).toContain('Source: https://www.example.com');
		expect(md).toContain('Pages analyzed: 3');

		expect(md).toContain('#1c1c1e');
		expect(md).toContain('#ffffff');
		expect(md).toContain('Source Sans Pro');
		expect(md).toContain('16px');
		expect(md).toContain('700');
		expect(md).toContain('max-width 768px');
	});
});

describe('buildColorsRef', () => {
	it('includes all color categories', () => {
		const ref = buildColorsRef(makeReport());

		expect(ref).toContain('# Colors');
		expect(ref).toContain('## All Colors');
		expect(ref).toContain('## Text Colors');
		expect(ref).toContain('## Background Colors');
		expect(ref).toContain('## Border Colors');
		expect(ref).toContain('## Fill Colors');
		expect(ref).toContain('#1c1c1e');
		expect(ref).toContain('#f07e00');
		expect(ref).toContain('#e6e6e6');
	});
});

describe('buildTypographyRef', () => {
	it('includes fonts, sizes, weights and line heights', () => {
		const ref = buildTypographyRef(makeReport());

		expect(ref).toContain('# Typography');
		expect(ref).toContain('Source Sans Pro');
		expect(ref).toContain('sans-serif');
		expect(ref).toContain('16px');
		expect(ref).toContain('14px');
		expect(ref).toContain('700');
		expect(ref).toContain('400');
		expect(ref).toContain('1.5');
	});
});

describe('buildLayoutRef', () => {
	it('includes spacing and border radius', () => {
		const ref = buildLayoutRef(makeReport());

		expect(ref).toContain('# Layout');
		expect(ref).toContain('16px');
		expect(ref).toContain('8px');
		expect(ref).toContain('24px');
		expect(ref).toContain('4px');
	});
});

describe('buildResponsiveRef', () => {
	it('includes breakpoints, media queries and headings', () => {
		const ref = buildResponsiveRef(makeReport());

		expect(ref).toContain('# Responsive Design');
		expect(ref).toContain('max-width 768px');
		expect(ref).toContain('min-width 1024px');
		expect(ref).toContain('(max-width: 768px)');
		expect(ref).toContain('h1 / default');
		expect(ref).toContain('32px');
	});
});
