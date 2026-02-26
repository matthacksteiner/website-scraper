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
  private active = 0;
  private limit;

  constructor(private options: CrawlOptions) {
    const concurrency = Number.isFinite(options.concurrency)
      ? Math.max(1, Math.floor(options.concurrency))
      : 1;
    const maxPages = Number.isFinite(options.maxPages)
      ? Math.max(1, Math.floor(options.maxPages))
      : 1;
    this.options = { concurrency, maxPages };
    this.limit = pLimit(this.options.concurrency);
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

  pendingCount(): number {
    return this.queue.length;
  }

  activeCount(): number {
    return this.active;
  }

  discoveredCount(): number {
    return this.enqueued.size;
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
          this.active += 1;
          try {
            await handler(item);
          } finally {
            this.active -= 1;
          }
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
