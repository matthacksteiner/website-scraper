import { describe, expect, it } from 'bun:test';
import { Crawler } from '../src/crawler';

describe('Crawler', () => {
  it('guards invalid concurrency and maxPages values', async () => {
    const crawler = new Crawler({
      concurrency: 0,
      maxPages: 0,
    });

    crawler.enqueue('https://example.com', 0);
    crawler.enqueue('https://example.com/about', 0);

    const processed: string[] = [];
    await crawler.run(async (item) => {
      processed.push(item.url);
    });

    expect(processed.length).toBe(1);
    expect(processed[0]).toBe('https://example.com/');
  });
});
