import pLimit from 'p-limit';
import { normalizeUrl } from './url';

export interface CrawlItem {
  url: string;
  depth: number;
}

interface CrawlOptions {
  concurrency: number;
  maxPages: number;
}

export class Crawler {
  private queue: CrawlItem[] = [];
  private visited = new Set<string>();
  private enqueued = new Set<string>();
  private limit;

  constructor(private options: CrawlOptions) {
    this.limit = pLimit(options.concurrency);
  }

  enqueue(url: string, depth: number): boolean {
    const normalized = normalizeUrl(url);
    if (this.enqueued.has(normalized) || this.visited.has(normalized)) {
      return false;
    }
    this.queue.push({ url: normalized, depth });
    this.enqueued.add(normalized);
    return true;
  }

  hasSeen(url: string): boolean {
    const normalized = normalizeUrl(url);
    return this.enqueued.has(normalized) || this.visited.has(normalized);
  }

  async run(handler: (item: CrawlItem) => Promise<void>): Promise<void> {
    const running: Promise<void>[] = [];

    while (
      (this.queue.length > 0 || running.length > 0) &&
      this.visited.size < this.options.maxPages
    ) {
      while (
        this.queue.length > 0 &&
        running.length < this.options.concurrency &&
        this.visited.size + running.length < this.options.maxPages
      ) {
        const item = this.queue.shift()!;
        const task = this.limit(async () => {
          this.visited.add(normalizeUrl(item.url));
          await handler(item);
        });
        running.push(task);
        task.finally(() => {
          const index = running.indexOf(task);
          if (index >= 0) running.splice(index, 1);
        });
      }

      if (running.length > 0) {
        await Promise.race(running);
      }
    }

    await Promise.all(running);
  }
}
