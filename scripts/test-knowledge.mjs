import assert from "node:assert/strict";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = join(projectRoot, "dist");
const wikiPath = join(distRoot, "wiki", "index.html");
const postPath = join(distRoot, "posts", "home-ai-platform-series", "index.html");
const rssPath = join(distRoot, "rss.xml");
const pagefindPath = join(distRoot, "pagefind", "pagefind.js");

for (const path of [wikiPath, postPath, rssPath, pagefindPath]) {
  assert.ok(existsSync(path), `missing build artifact: ${path}`);
}

const wikiHtml = readFileSync(wikiPath, "utf8");
assert.match(wikiHtml, /개인 홈 AI 플랫폼 만들기: 전체 구조와 운영 원칙/);
assert.match(wikiHtml, /href="\/posts\/home-ai-platform-series"/);
assert.match(wikiHtml, /href="\/wiki"[^>]*aria-current="page"/);

const postHtml = readFileSync(postPath, "utf8");
assert.match(postHtml, /href="\/posts"[^>]*aria-current="page"/);
assert.doesNotMatch(postHtml, /href="\/wiki"[^>]*aria-current="page"/);

const rss = readFileSync(rssPath, "utf8");
assert.match(rss, /home-ai-platform-series/);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const requestPath = normalize(pathname).replace(/^[/\\]+/, "");
  const candidate = resolve(distRoot, requestPath);
  const candidateRelative = relative(distRoot, candidate);
  const escapedDist =
    candidateRelative === ".." ||
    candidateRelative.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelative);

  if (escapedDist || !existsSync(candidate)) {
    response.writeHead(404).end("not found");
    return;
  }

  const resolved = statSync(candidate).isDirectory() ? join(candidate, "index.html") : candidate;
  if (!existsSync(resolved)) {
    response.writeHead(404).end("not found");
    return;
  }

  response.writeHead(200, {
    "content-type": mimeTypes[extname(resolved)] ?? "application/octet-stream",
  });
  createReadStream(resolved).pipe(response);
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const pagefind = await import(pathToFileURL(pagefindPath).href);
  const instance = pagefind.createInstance({
    basePath: `${origin}/pagefind/`,
    baseUrl: origin,
    language: "ko",
  });
  const search = await instance.search("개인 홈 AI 플랫폼");
  const results = await Promise.all(search.results.slice(0, 10).map(result => result.data()));
  assert.ok(
    results.some(result => result.url.includes("/posts/home-ai-platform-series")),
    "Pagefind did not return the wiki-classified post"
  );
  await instance.destroy();
} finally {
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
}
