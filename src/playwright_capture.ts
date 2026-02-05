import { BrowserContext } from "playwright";
import { CapturedResponse } from "./types";
import { isHttpUrl, normalizeUrl } from "./url";

export interface CapturedPage {
  html: string;
  status: number | null;
  contentType: string | null;
  responses: CapturedResponse[];
}

interface CaptureOptions {
  timeoutMs: number;
}

export const capturePage = async (
  context: BrowserContext,
  url: string,
  options: CaptureOptions
): Promise<CapturedPage> => {
  const page = await context.newPage();
  const responses: CapturedResponse[] = [];
  const seenResponses = new Set<string>();

  page.on("response", async (response) => {
    try {
      const responseUrl = response.url();
      if (!isHttpUrl(responseUrl)) return;
      const normalized = normalizeUrl(responseUrl);
      if (seenResponses.has(normalized)) return;
      const request = response.request();
      const resourceType = request.resourceType();
      if (resourceType === "document" && normalizeUrl(responseUrl) === normalizeUrl(url)) {
        return;
      }
      const body = await response.body();
      const contentType = response.headers()["content-type"] || null;
      seenResponses.add(normalized);
      responses.push({
        url: responseUrl,
        status: response.status(),
        contentType,
        body,
      });
    } catch {
      return;
    }
  });

  const mainResponse = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });

  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch {
    // best-effort
  }

  const html = await page.content();
  const status = mainResponse ? mainResponse.status() : null;
  const contentType = mainResponse ? mainResponse.headers()["content-type"] || null : null;

  await page.close();

  return {
    html,
    status,
    contentType,
    responses,
  };
};
