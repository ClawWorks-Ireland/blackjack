// Static file server for `npm start` and for UI checks that take a URL.
// Usage: node qa/serve.js <dir> [port]   (binds 127.0.0.1, default port 8765)
//
// Use this instead of `python3 -m http.server`: Python's server resets
// connections when Chrome fetches the game's ~20 scripts at once, so a script
// fails to load and app.js throws at startup (T2 in backlog.md).
const http = require('http'), fs = require('fs'), path = require('path');

const dir = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8765);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(dir, rel.endsWith('/') ? rel + 'index.html' : rel);
  if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`serving ${dir} on http://127.0.0.1:${port}/`));
