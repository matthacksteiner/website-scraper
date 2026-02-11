#!/usr/bin/env node
import http from "http";
import path from "path";
import { promises as fs } from "fs";
import * as mime from "mime-types";
import { Command } from "commander";

const toNumber = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const safeJoin = (root: string, urlPath: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const normalized = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(root, normalized);
  const rel = path.relative(root, resolved);
  if (rel === "") return resolved;
  if (rel.startsWith("..") || rel.includes(`..${path.sep}`)) return null;
  return resolved;
};

const program = new Command();
program
  .name("serve-scrape")
  .description("Serve a scrape output directory over HTTP (avoids file:// CORS issues)")
  .option("--dir <dir>", "Directory to serve", ".")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <number>", "Port to listen on", "4173");

program.parse(process.argv);
const opts = program.opts();

const rootDir = path.resolve(String(opts.dir));
const host = String(opts.host);
const port = toNumber(String(opts.port), 4173);

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || "/", `http://${host}:${port}`);
    const filePath = safeJoin(rootDir, reqUrl.pathname);
    if (!filePath) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    let targetPath = filePath;
    if (stat.isDirectory()) {
      targetPath = path.join(filePath, "index.html");
      try {
        await fs.access(targetPath);
      } catch {
        if (reqUrl.pathname === "/" || reqUrl.pathname.endsWith("/")) {
          const listing = await renderDirectoryListing(rootDir, filePath, reqUrl.pathname);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(listing);
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
    }

    const body = await fs.readFile(targetPath);
    const contentType = mime.lookup(targetPath) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": `${contentType}${String(contentType).startsWith("text/") ? "; charset=utf-8" : ""}`,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end((error as Error).message || "Internal error");
  }
});

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ensureTrailingSlash = (value: string): string => (value.endsWith("/") ? value : `${value}/`);

const renderDirectoryListing = async (root: string, dir: string, requestPath: string): Promise<string> => {
  const rel = path.relative(root, dir) || ".";
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const rows: { href: string; name: string }[] = [];
  const basePath = ensureTrailingSlash(requestPath);

  if (basePath !== "/") {
    const parent = basePath.replace(/[^/]+\/$/, "");
    rows.push({ href: parent, name: ".." });
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const suffix = entry.isDirectory() ? "/" : "";
    rows.push({ href: `${basePath}${encodeURIComponent(entry.name)}${suffix}`, name: `${entry.name}${suffix}` });
  }

  const recommended: { href: string; name: string }[] = [];
  if (rel === "." || rel === "") {
    const pagesDir = path.join(root, "pages");
    try {
      const hostDirs = (await fs.readdir(pagesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .slice(0, 20);
      for (const hostName of hostDirs) {
        const candidate = `/pages/${encodeURIComponent(hostName)}/root/index.html`;
        recommended.push({ href: candidate, name: `${hostName} (root)` });
      }
    } catch {
      // ignore
    }
  }

  const recommendedHtml =
    recommended.length > 0
      ? `<h2>Recommended</h2><ul>${recommended
          .map((item) => `<li><a href="${item.href}">${escapeHtml(item.name)}</a></li>`)
          .join("")}</ul>`
      : "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Index of ${escapeHtml(basePath)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; padding: 16px; }
    code { background: #f4f4f5; padding: 2px 6px; border-radius: 6px; }
    ul { padding-left: 18px; }
  </style>
</head>
<body>
  <h1>Index of <code>${escapeHtml(basePath)}</code></h1>
  <p>Serving <code>${escapeHtml(path.resolve(root))}</code></p>
  ${recommendedHtml}
  <h2>Browse</h2>
  <ul>
    ${rows.map((item) => `<li><a href="${item.href}">${escapeHtml(item.name)}</a></li>`).join("")}
  </ul>
</body>
</html>`;
};

server.listen(port, host, () => {
  console.log(`Serving: ${rootDir}`);
  console.log(`URL: http://${host}:${port}/`);
});
