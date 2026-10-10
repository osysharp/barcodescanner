// An end-to-end check of the scanner in a real browser — run it with `npm run verify` after `npm install` and a
// one-time `npx playwright install chromium`.
//
// It drives the built `scan.js` in a real Chromium, under the content-security policy app pages are served with,
// serving the kit's own chunks over http the way the platform serves them (same content types, one URL per chunk).
// Nothing here is mocked except the camera, and even that is a genuine `MediaStream` — a canvas showing a QR code
// that this script encoded with ZXing's own writer, captured with `captureStream()`. So the whole path is under test:
//
//     mount → getUserMedia → <video> → canvas → getImageData → wasm decode → host.emit("scanned", …)
//
// It is a script rather than a unit test because every claim it checks is about a real browser: that the browser
// will COMPILE a WebAssembly module under this policy, that Emscripten's `locateFile` override reaches a
// content-addressed URL, that a decode of live video frames actually finds a code. A stub of any of those would only
// prove that the code called itself.
//
// The second pass re-runs everything with `'wasm-unsafe-eval'` REMOVED from the policy and requires the scanner to
// FAIL, which shows that this token is what lets the decoder load.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { prepareZXingModule, writeBarcode } from '../node_modules/zxing-wasm/dist/es/writer/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const kit = join(here, '..');

const PAYLOAD = 'OSY-BARCODE-KIT-OK';

// ── the QR, encoded by ZXing's own writer ────────────────────────────────────────────────────────────────────────
// A generated matrix rather than a checked-in image: the fixture then cannot drift from what the decoder in the
// other half of this file understands, and there is no binary in the tree whose provenance is a comment.
await prepareZXingModule({
  overrides: { wasmBinary: readFileSync(join(kit, 'node_modules/zxing-wasm/dist/writer/zxing_writer.wasm')) },
  fireImmediately: true,
});
const written = await writeBarcode(PAYLOAD, { format: 'QRCode' });
if (written.error) throw new Error(`could not encode the test QR: ${written.error}`);
const matrix = {
  width: written.symbol.width,
  height: written.symbol.height,
  // One byte per module, 0 = dark. Sent to the page as a plain array so it crosses `evaluate` unchanged.
  data: Array.from(written.symbol.data),
};

// ── the policy app pages are served with, reproduced here — keep it in step with the platform's ─────────────────
const THEME_INIT = "(function(){try{if(!document.documentElement.getAttribute('data-theme')){var t=localStorage.getItem('osy-theme');if(t)document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();";
const inlineHash = `'sha256-${createHash('sha256').update(THEME_INIT, 'utf8').digest('base64')}'`;
const policy = (wasm) => [
  "default-src 'self'",
  `script-src 'self'${wasm ? " 'wasm-unsafe-eval'" : ''} ${inlineHash}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────
// `mount` is imported from the built bundle, not from source: the bundle is what the platform ships, and a check
// that ran the TypeScript would not be checking the artifact.
// The boot script is an external file on purpose. The policy admits inline script only by the ONE hash it carries
// (the platform's theme bootstrap), so an inline `<script type="module">` here would be refused — silently, as a page
// that simply never boots. Serving it as a file puts it under `'self'`, which is where every real app's script lives.
const PAGE = `<!doctype html><meta charset=utf-8><title>barcode kit verify</title>
<div id="box" style="width:320px;height:240px"></div>
<script type="module" src="/page.js"></script>`;

const BOOT = `import { mount } from '/scan.js';
window.__mount = mount;
window.__ready = true;
`;

const files = {
  '/page.js': [Buffer.from(BOOT), 'text/javascript'],
  '/scan.js': [readFileSync(join(kit, 'scan.js')), 'text/javascript'],
  '/chunk/core.js': [readFileSync(join(kit, 'zxing-core.js')), 'text/javascript'],
  '/chunk/reader.wasm': [readFileSync(join(kit, 'zxing-reader.wasm')), 'application/wasm'],
};

/** Everything the page does once the bundle is loaded, as one function so both passes run identically. */
const DRIVE = ({ matrix, payload }) => new Promise((resolve) => {
  const events = [];

  // A canvas showing the QR on white, redrawn on a timer so `captureStream` keeps producing frames (a static canvas
  // emits one and stops). Quiet zone included: a QR with no margin is not reliably findable, and leaving it out
  // would make this test measure the fixture rather than the decoder.
  const quiet = 4;
  const modules = matrix.width + quiet * 2;
  const cell = 10;
  const src = document.createElement('canvas');
  src.width = 640;
  src.height = 480;
  const c = src.getContext('2d');
  const draw = () => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, src.width, src.height);
    const x0 = Math.round((src.width - modules * cell) / 2);
    const y0 = Math.round((src.height - modules * cell) / 2);
    c.fillStyle = '#000';
    for (let y = 0; y < matrix.height; y++) {
      for (let x = 0; x < matrix.width; x++) {
        if (matrix.data[y * matrix.width + x] === 0) {
          c.fillRect(x0 + (x + quiet) * cell, y0 + (y + quiet) * cell, cell, cell);
        }
      }
    }
  };
  draw();
  const redraw = setInterval(draw, 100);

  const stream = src.captureStream(15);
  navigator.mediaDevices.getUserMedia = async () => stream;

  const host = {
    contractVersion: '1.1',
    emit: (...args) => { events.push(args); },
    tokens: { cssVar: (t) => `var(--${t})`, get: () => '' },
    chunkUrl: (name) => (name === 'Core' ? '/chunk/core.js' : '/chunk/reader.wasm'),
  };

  const handle = window.__mount(document.getElementById('box'), { repeatAfterMs: 2000, intervalMs: 100 }, host);

  const started = Date.now();
  const poll = setInterval(() => {
    const scanned = events.filter((e) => e[0] === 'scanned');
    const probe = handle.probe();
    if (scanned.length > 0 || Date.now() - started > 12000) {
      clearInterval(poll);
      // Give the loop long enough to have looked several more times, so the repeat suppression is measured rather
      // than assumed: at intervalMs 100 the label is read ~12 more times inside the 2000ms window.
      setTimeout(() => {
        const after = handle.probe();
        clearInterval(redraw);
        handle.destroy();
        resolve({
          events, probe, after,
          liveTracksAfterDestroy: stream.getTracks().filter((t) => t.readyState === 'live').length,
        });
      }, 1300);
    }
  }, 100);
});

async function run(label, wasmAllowed) {
  const csp = policy(wasmAllowed);
  const server = createServer((req, res) => {
    const hit = files[req.url];
    if (hit) {
      res.writeHead(200, { 'content-type': hit[1], 'content-security-policy': csp });
      return res.end(hit[0]);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

  await page.goto(`http://127.0.0.1:${port}/`);
  // A FUNCTION, never a string: Playwright's string form goes through `eval`, which this very policy refuses —
  // the harness would then fail for the reason the page under test is supposed to be safe from.
  await page.waitForFunction(() => window.__ready === true);
  const out = await page.evaluate(DRIVE, { matrix, payload: PAYLOAD });

  await browser.close();
  await new Promise((r) => server.close(r));
  return { ...out, consoleErrors, csp };
}

const fails = [];
const check = (ok, what) => { console.log(`   ${ok ? '✓' : '✗'} ${what}`); if (!ok) fails.push(what); };

// ── pass 1: the policy the platform ships ───────────────────────────────────────────────────────────────────────
console.log("\n── WITH 'wasm-unsafe-eval' — the policy AppPageCsp ships");
const ok = await run('with', true);
const scanned = ok.events.filter((e) => e[0] === 'scanned');
console.log(`   events: ${JSON.stringify(ok.events)}`);
console.log(`   probe:  ${JSON.stringify(ok.after)}`);
check(scanned.length === 1, `exactly one scanned event (got ${scanned.length}) — the repeat suppression holds`);
check(scanned[0]?.[1] === PAYLOAD, `it carries the payload (${JSON.stringify(scanned[0]?.[1])})`);
check(scanned[0]?.[2] === 'QRCode', `it names the symbology (${JSON.stringify(scanned[0]?.[2])})`);
check(ok.events.every((e) => e[0] !== 'failed'), 'nothing failed');
check(ok.after.scanning === true, 'the probe reports a live scan');
check(ok.after.last === PAYLOAD, 'the probe reports what it read');
check(ok.liveTracksAfterDestroy === 0, 'destroy() released the camera — no track is left live');

// ── pass 2: the same policy without 'wasm-unsafe-eval' ──────────────────────────────────────────────────────────
console.log("\n── WITHOUT it — the policy before this kit, to prove the CSP line is load-bearing");
const no = await run('without', false);
console.log(`   events: ${JSON.stringify(no.events)}`);
const failedNo = no.events.filter((e) => e[0] === 'failed');
check(no.events.filter((e) => e[0] === 'scanned').length === 0, 'nothing is scanned');
check(failedNo.length === 1, `the failure is reported ONCE, not once per frame (got ${failedNo.length})`);
check(/decoder could not be loaded/i.test(failedNo[0]?.[1] ?? ''),
  `and it says the decoder could not load: ${JSON.stringify(failedNo[0]?.[1]?.slice(0, 90))}`);

console.log(fails.length === 0
  ? '\n✓ the barcode kit decodes a real QR from a real camera stream, and only because the CSP admits wasm.\n'
  : `\n✗ ${fails.length} check(s) failed:\n   - ${fails.join('\n   - ')}\n`);
process.exit(fails.length === 0 ? 0 : 1);
