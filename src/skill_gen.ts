import { promises as fs } from 'fs';
import path from 'path';
import { MiniCdReport } from './mini_cd';
import { renderDesignMarkdown } from './design_md';

export const writeSkill = async (
	outputDir: string,
	_domain: string,
	_sourceUrl: string,
	report: MiniCdReport,
): Promise<string> => {
	await fs.mkdir(outputDir, { recursive: true });
	await fs.writeFile(
		path.join(outputDir, 'design.md'),
		renderDesignMarkdown(report),
		'utf8',
	);
	return outputDir;
};
