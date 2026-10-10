// Build the Barcode kit's two CHUNKS from the installed `zxing-wasm` package — the assets a page only pays for the
// first time something actually scans.
//
//   Core — ONE FILE. `zxing-wasm/reader`'s ESM entry bundled to a single module (esbuild --bundle). The published
//          entry imports a sibling `../share.js`, and a single-file chunk is served at its own content address with
//          no directory around it, so a relative specifier inside one has nothing to resolve against. Bundling is
//          what makes it a legal single-file chunk. 37 KB of Emscripten glue.
//   Wasm — ONE FILE, copied byte-for-byte. `zxing_reader.wasm`, the ZXing C++ decoder, 1.07 MB.
//
// The wasm is a sibling of the glue, not part of it. Emscripten glue asks `locateFile()` where its `.wasm` lives, and
// zxing-wasm's default answer is a jsDelivr URL — which an app page's content-security policy (`default-src 'self'`)
// refuses. The shim overrides it with `host.chunkUrl('Wasm')`, so the module the platform serves from its own origin
// is the one that runs. Getting this wrong fails neither the build nor the compile: it fails only in the browser.
//
// The wasm is copied rather than inlined as a data: URI on purpose. 1.07 MB of base64 is 1.43 MB of JavaScript
// source that must be parsed before a single byte is compiled, and it would land inside the Core chunk — so a page
// that loads the scanner's glue would pay for the decoder whether or not it ever got camera permission.
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kit = join(here, '..');
const pkg = join(kit, 'node_modules', 'zxing-wasm');

// Straight into the kit root, which is where the lock pins them — so there is exactly one copy of each asset in the
// tree and no question about which one is real.
const esbuild = join(kit, 'node_modules', '.bin', 'esbuild');
execFileSync(esbuild, [
  join(pkg, 'dist', 'es', 'reader', 'index.js'),
  '--bundle', '--format=esm', '--minify',
  `--outfile=${join(kit, 'zxing-core.js')}`,
], { stdio: 'inherit' });

copyFileSync(join(pkg, 'dist', 'reader', 'zxing_reader.wasm'), join(kit, 'zxing-reader.wasm'));

// FAIL LOUD if the glue still carries a cross-origin default we cannot see overridden. `locateFile` is overridden at
// run time by the shim, so this is not a correctness check — it is a check that the STRING we are reasoning about is
// still the one in the file. If zxing-wasm ever stops shipping a CDN default, this line is what says so, rather than
// a comment above quietly describing a version we no longer have.
const glue = readFileSync(join(kit, 'zxing-core.js'), 'utf8');
if (!glue.includes('jsdelivr')) {
  throw new Error(
    'zxing-core.js no longer contains a jsDelivr default for locateFile. That is probably good news, but this kit\'s '
    + 'shim and its comments are written against a build that had one — re-read `prepareZXingModule` before trusting '
    + 'the override, and update this check.');
}

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
console.log(`Core  ${kb(join(kit, 'zxing-core.js'))} KB  (zxing-core.js, Emscripten glue)`);
console.log(`Wasm  ${kb(join(kit, 'zxing-reader.wasm'))} KB  (zxing-reader.wasm, the ZXing decoder)`);
