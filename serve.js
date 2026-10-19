// Tiny static server for local testing: node serve.js [port]
// localhost counts as a secure context, so the service worker and install prompt work here.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.argv[2]) || 8080;
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8"
};

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if(p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if(!file.startsWith(root + path.sep)){ res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if(err){ res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    // no-cache so edits show up immediately; the service worker does the offline caching.
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}).listen(port, () => console.log(`Kulalog running at http://localhost:${port}/  (Ctrl+C to stop)`));
