const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const PAGES = ['lobby.html', 'index.html', 'table.html', 'poker.html', 'players.html'];
const localScripts = (html) => [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

test('F11: the manifest is installable and its icons exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.name, 'Blackjack');
  assert.equal(m.start_url, './lobby.html');
  assert.equal(m.scope, './');
  assert.equal(m.id, './index.html');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) {
    const png = fs.readFileSync(path.join(__dirname, i.src));
    assert.equal(png.readUInt32BE(16), Number(i.sizes.split('x')[0]), `${i.src} width matches`);
  }
});

test('AC2: every page links the manifest and an apple-touch-icon', () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/, `${p} manifest`);
    assert.match(html, /<link rel="apple-touch-icon"/, `${p} apple-touch-icon`);
    assert.match(html, /<meta name="theme-color" content="#0f5132">/, `${p} theme-color`);
  }
});

test('F11: the service worker caches every file every page needs', () => {
  const sw = read('sw.js');
  const icons = JSON.parse(read('manifest.webmanifest')).icons.map((i) => i.src);
  // Page-relative paths: './x' for the web UI's own files, '../engine/x' for the shared engine.
  const cached = (f) => sw.includes(f.startsWith('../') ? `'${f}'` : `'./${f}'`);
  for (const p of PAGES) {
    const html = read(p);
    const needed = [
      ...localScripts(html),
      ...[...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]),
      p, 'manifest.webmanifest', ...icons,
    ];
    for (const f of needed) {
      assert.ok(cached(f), `${p}: ${f} is cached`);
      assert.ok(fs.existsSync(path.join(__dirname, f)), `${p}: ${f} exists`);
    }
  }
});

test('AC4: every page registers the service worker behind an http(s) guard', () => {
  for (const p of PAGES) {
    const srcs = [read(p), ...localScripts(read(p)).filter((s) => !s.startsWith('../')).map(read)];
    assert.ok(srcs.some((s) => /\/\^https\?:\$\/\.test\(location\.protocol\)[\s\S]{0,120}serviceWorker\.register\('sw\.js'\)/.test(s)), `${p} registers sw.js`);
  }
});

test('AC5: sw.js never touches /api/ and falls back to lobby.html for navigations', () => {
  const sw = read('sw.js');
  const api = sw.indexOf("url.pathname.startsWith('/api/')");
  assert.ok(api > 0 && api < sw.indexOf('event.respondWith'));
  assert.match(sw, /req\.mode === 'navigate'[^\n]*caches\.match\('\.\/lobby\.html'\)/);
  assert.ok(!sw.includes("caches.match('./index.html')"));
});

test('AC7: the cache name changed', () => {
  const m = read('sw.js').match(/const CACHE = 'blackjack-v(\d+)'/);
  assert.ok(m, 'sw.js must define CACHE as blackjack-v<N>');
  assert.ok(Number(m[1]) > 9, `cache version must be above v9, got v${m[1]}`);
});

test('AC6: the solo page links back to the lobby', () => {
  const html = read('index.html');
  const a = [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].find((m) => /href="lobby\.html"/.test(m[1]));
  assert.ok(a, 'index.html has a link to lobby.html');
  assert.doesNotMatch(a[1], /\btarget=/);
  assert.ok(a[2].trim().length > 0, 'link has text');
});

test('AC6: no page opens in-app pages in a new window', () => {
  for (const p of PAGES) {
    const html = read(p);
    const sources = [[p, html], ...localScripts(html).map((s) => [s, read(s)])];
    for (const [name, src] of sources) {
      assert.doesNotMatch(src, /target\s*=\s*["']_blank["']/, `${name} target=_blank`);
      assert.doesNotMatch(src, /window\.open\(/, `${name} window.open`);
    }
  }
});
