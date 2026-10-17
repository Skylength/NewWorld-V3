import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
const directory = new URL("../../web/exploration/", import.meta.url);
const files: Record<string, [string, string]> = {
  "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"],
  "/debug-data.js": ["debug-data.js", "text/javascript"],
};
export async function serveExplorationAsset(pathname: string, response: ServerResponse): Promise<boolean> {
  const asset = Object.hasOwn(files, pathname) ? files[pathname] : undefined;
  if (!asset) return false;
  const content = await readFile(new URL(asset[0], directory));
  response.writeHead(200, {
    "Content-Type": asset[1] + "; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(content); return true;
}
