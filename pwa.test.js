const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

test('F11: the manifest is installable and its icons exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.name && m.start_url);
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) {
    const png = fs.readFileSync(path.join(__dirname, i.src));
    assert.equal(png.readUInt32BE(16), Number(i.sizes.split('x')[0]), `${i.src} width matches`);
  }
  assert.match(read('index.html'), /<link rel="manifest" href="manifest.webmanifest">/);
});

test('F11: the service worker caches every file the page needs', () => {
  const sw = read('sw.js');
  const html = read('index.html');
  const needed = [
    ...[...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]),
    'index.html', 'style.css', 'manifest.webmanifest',
    ...JSON.parse(read('manifest.webmanifest')).icons.map((i) => i.src),
  ];
  for (const f of needed) assert.ok(sw.includes(`'./${f}'`), `${f} is cached`);
  for (const f of needed) assert.ok(fs.existsSync(path.join(__dirname, f)), `${f} exists`);
});
