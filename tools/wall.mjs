#!/usr/bin/env node
// The live wall: your app on a wall of the town square.
//
//   node tools/wall.mjs <url> [--port 4311] [--id app] [--viewport 1024x640] [--fps 15]
//
// A headless browser opens the page. The game fetches its newest picture and sends back the player's mouse and keys,
// on 127.0.0.1 only:
//   GET  /state                 the screens on offer
//   GET  /frame/<id>?after=<n>  the newest picture (PNG) once it is newer than n, waited for up to a second
//   POST /input/<id>            {type:'mouse', action:'move'|'down'|'up'|'wheel', x, y (fractions of the page), dy}
//                               | {type:'key', action:'down'|'up', code} | {type:'text', text}
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(path.join(root, 'foreman', 'package.json'))('playwright');

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const url = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!url) { console.error('usage: node tools/wall.mjs <url> [--port 4311] [--id app] [--viewport 1024x640] [--fps 15]'); process.exit(2); }
const PORT = Number(flag('--port', '4311')), ID = flag('--id', 'app');
const GAP = 1000 / Math.max(0.5, Math.min(30, Number(flag('--fps', '15'))));
const [width, height] = String(flag('--viewport', '1024x640')).split('x').map(Number);
if (!/^[A-Za-z0-9_-]{1,64}$/.test(ID)) { console.error('--id: letters, digits, - and _'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const context = await browser.newContext({ viewport: { width, height } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

// the newest picture, and who is waiting for one (the game decodes every picture it is given, so at most --fps a second)
const wall = { seq: 0, frame: null, at: 0, waiters: new Set() };
cdp.on('Page.screencastFrame', (e) => {
  cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
  if (Date.now() - wall.at < GAP - 2) return;
  wall.at = Date.now(); wall.frame = Buffer.from(e.data, 'base64'); wall.seq++;
  for (const wake of wall.waiters) wake();
  wall.waiters.clear();
});
await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

// one input at a time, in the order the game sent them
let chain = Promise.resolve();
async function input(m) {
  const px = (v, size) => Math.max(0, Math.min(size - 1, Math.round(Number(v) * size)));
  if (m.type === 'key' && /^[A-Za-z0-9]{1,24}$/.test(m.code ?? '')) { if (m.action === 'down') await page.keyboard.down(m.code); else await page.keyboard.up(m.code); }
  else if (m.type === 'text' && typeof m.text === 'string' && m.text.length <= 200) await page.keyboard.insertText(m.text);
  else if (m.type === 'mouse') {
    const x = px(m.x, width), y = px(m.y, height);
    if (m.action === 'move') await page.mouse.move(x, y);
    else if (m.action === 'down') { await page.mouse.move(x, y); await page.mouse.down(); }
    else if (m.action === 'up') await page.mouse.up();
    else if (m.action === 'wheel') await page.mouse.wheel(0, Number(m.dy) || 0);
    else throw new Error('unknown mouse action');
  } else throw new Error('unknown input');
}

const server = http.createServer((req, res) => {
  const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const at = new URL(req.url, 'http://127.0.0.1'), parts = at.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && parts[0] === 'state') return reply(200, { screens: [{ id: ID, seq: wall.seq, width, height }] });
  if (req.method === 'GET' && parts[0] === 'frame' && parts[1] === ID) {
    const after = Number(at.searchParams.get('after') ?? -1);
    const send = () => {
      if (wall.seq <= after || !wall.frame) { res.writeHead(204, { 'x-seq': String(wall.seq) }); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/png', 'x-seq': String(wall.seq), 'cache-control': 'no-store' }); res.end(wall.frame);
    };
    if (wall.seq > after && wall.frame) return send();
    const wake = () => { clearTimeout(timer); send(); };
    const timer = setTimeout(() => { wall.waiters.delete(wake); send(); }, 1000);
    wall.waiters.add(wake);
    return;
  }
  if (req.method === 'POST' && parts[0] === 'input' && parts[1] === ID) {
    let text = '';
    req.on('data', (d) => { text += d; if (text.length > 65536) req.destroy(); });
    req.on('end', () => {
      let m; try { m = JSON.parse(text || '{}'); } catch { return reply(400, { ok: false }); }
      chain = chain.then(() => input(m), () => input(m));
      chain.then(() => reply(200, { ok: true, seq: wall.seq }), (e) => reply(400, { ok: false, error: String(e.message || e) }));
    });
    return;
  }
  reply(404, { ok: false, error: 'no such screen' });
});

async function shutdown() { server.close(); await browser.close().catch(() => undefined); process.exit(0); }
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
console.log(`wall "${ID}" on http://127.0.0.1:${PORT}, showing ${url}`);
// a dev server that is still starting is tried again once a second
for (;;) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); console.log('loaded', page.url()); break; }
  catch { await sleep(1000); }
}
