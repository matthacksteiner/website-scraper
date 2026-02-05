import robotsParser from "robots-parser";

interface RobotsEntry {
  parser: ReturnType<typeof robotsParser>;
  fetchedAt: number;
}

export class RobotsClient {
  private cache = new Map<string, RobotsEntry>();

  async canFetch(url: string, userAgent: string): Promise<boolean> {
    const origin = new URL(url).origin;
    let entry = this.cache.get(origin);
    if (!entry) {
      const robotsUrl = new URL("/robots.txt", origin).toString();
      let text = "";
      try {
        const res = await fetch(robotsUrl, {
          headers: {
            "User-Agent": userAgent,
            "Accept": "text/plain",
          },
        });
        if (res.ok) {
          text = await res.text();
        }
      } catch {
        text = "";
      }

      entry = {
        parser: robotsParser(robotsUrl, text),
        fetchedAt: Date.now(),
      };
      this.cache.set(origin, entry);
    }

    const allowed = entry.parser.isAllowed(url, userAgent);
    if (typeof allowed === "boolean") {
      return allowed;
    }
    return true;
  }
}
