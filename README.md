# Osysharp.BarcodeScanner — a live barcode and QR scanner

A control that opens the camera, reads QR codes and barcodes as they come into view, and tells your app what it read.
Decoding runs in the browser with ZXing compiled to WebAssembly — no scanning service, and nothing leaves the device.

## Use case

Any app where someone points a phone at a code instead of typing it: checking tickets in at an event door, receiving
stock in a warehouse by scanning the carton's barcode, looking up an asset by the QR label on it, pairing a device from
the code on its box. The control owns the camera and the decode loop; your app supplies a box to draw it in and an
action to run with what it read.

There is no screenshot here: what the scanner shows is your camera's live picture, and a picture of a test pattern
would say nothing true about it.

## Install

```osy
// app.osy
app Warehouse {
  use Osysharp.BarcodeScanner@1;
  model "model/**/*.osy";
}
```

```console
osy lock      # resolves the package and pins its content address in osyrin.lock
```

## Using it

```osy
using Osysharp.BarcodeScanner;

action Found(string text, string format) { code = text; }

render {
  Stack(h: "16rem") {
    BarcodeScanner(scanned: Found, formats: qr);
  }
}
```

That is the whole surface. The control opens the camera, watches the picture, and raises `scanned(text, format)`
when it reads something: once per code, so holding a label in view does not repeat it. `failed(reason)` fires once
per cause, such as a camera the person did not allow.

## What it ships

| file | what it is |
|---|---|
| `scan.osy` | the `control BarcodeScanner` declaration — props, events, chunks, probe |
| `scan.ts` → `scan.js` | the shim (3 KB): the camera, the frame loop, the decoder handshake |
| `zxing-core.js` | chunk **Core** — [zxing-wasm](https://github.com/Sec-ant/zxing-wasm)'s Emscripten glue, 37 KB |
| `zxing-reader.wasm` | chunk **Wasm** — ZXing's C++ decoder compiled to WebAssembly, 1.07 MB |

A page that never activates a scanner downloads neither chunk.

## Props worth knowing about

| prop | default | why it exists |
|---|---|---|
| `active` | `true` | `false` releases the camera and stops the loop — the browser's recording indicator goes out, which is the only signal a person has |
| `formats` | `any` | `qr` · `linear` · `any`. ZXing spends time proportional to the families it must try, so narrowing is materially faster on a phone |
| `facing` | `back` | a scanner is pointed *at* something. A preference, not a demand — a laptop with one camera ignores it |
| `intervalMs` | `250` | four looks a second. Not a frame rate: decoding is synchronous work on the main thread |
| `repeatAfterMs` | `2000` | **the prop that makes it usable.** A label held in shot is read on every pass; without suppression one label produces forty events. `0` opts out |

## Build your own on top

**Wrap it.** The scanner is one call, so a component of yours can own the rest of the flow — a `TicketCheckIn` that
scans, looks the code up, and shows a green or red result — and your pages use that.

**Fork it.** Fork this repository into your own GitHub account or organisation and rename the package to match —
`package Acme.Barcode` lives at `github.com/acme/barcode`, because a package's owner *is* its GitHub owner. The
control is a small TypeScript shim over zxing-wasm, built with the ordinary CLI:

```console
npm install
npx playwright install chromium   # once — the browser `npm run verify` drives
npm run chunks      # rebuild the Core and Wasm chunks from node_modules
osy control build   # regenerate the typed ABI, type-check the shim against it, bundle it, re-pin osyrin.lock
npm run verify      # a real Chromium, a real camera stream carrying a real QR code
osy publish         # check the package and create the release
```

`npm run verify` is the measurement this kit rests on. It serves the kit's own chunks with the platform's exact
page policy, encodes a QR with ZXing's *writer*, paints it onto a canvas, hands the control that canvas's
`captureStream()` as its camera, and requires:

- exactly **one** `scanned` event carrying the payload and `QRCode` — one, not one per frame, which is the repeat
  suppression doing its job;
- `destroy()` leaving no live camera track;
- and then it runs the whole thing again with `'wasm-unsafe-eval'` **removed** and requires the scanner to fail, so a
fork that breaks how the decoder loads fails here rather than on someone's phone.

### How the decoder is loaded

Everything hard is in one function, `loadDecoder` in `scan.ts`:

```ts
const mod = await import(host.chunkUrl('Core'));
await mod.prepareZXingModule({
  overrides: { locateFile: () => host.chunkUrl('Wasm') },   // ← the whole kit turns on this line
  fireImmediately: true,
});
```

Emscripten glue does not embed its module; it **asks**, at run time, through `locateFile()`. zxing-wasm's default
answer is a jsDelivr URL — which an app page may not fetch (`default-src 'self'`, correctly). Handing it a
same-origin content address is what makes a native library a first-class control asset instead of a CDN dependency.

A page that runs it needs a content-security policy that admits WebAssembly (`'wasm-unsafe-eval'`); an Osy# app's
pages already carry it.

## Two shapes in the shim worth not undoing

**The loop is chained, not an interval.** The next look is scheduled when the previous one *finishes*, so there is
never more than one decode in flight — by construction, with no flag to get wrong. `setInterval` would queue a second
decode on a device that fell behind, and then a third.

**`failed` is raised once per cause.** The loop runs four times a second and a dead camera fails on every pass; an
unguarded emit is four toasts a second for as long as the page is open.

## Licence

MIT &mdash; see [`LICENSE`](LICENSE). The `.osy` source is yours to read, copy, fork and ship.

ZXing (zxing-cpp) is Apache-2.0; `zxing-wasm` is MIT. Both are vendored as compiled artifacts, pinned by content
address in `osyrin.lock`, and keep their own terms.
