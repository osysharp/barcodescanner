// The BarcodeScanner control — a foreign-control shim (mount/update/destroy) over ZXing compiled to WebAssembly.
//
// The delicate part of a WebAssembly control is one function below: `loadDecoder`. Emscripten glue does not embed its
// `.wasm`; it ASKS where the module lives, at run time, through `locateFile()`, and zxing-wasm's default answer is a
// jsDelivr URL. An app page's content-security policy (`default-src 'self'`) refuses that fetch, so the shim hands the
// glue a same-origin address for the module the platform serves instead — `host.chunkUrl("Wasm")`.
//
// Type-check it with `npm run typecheck`. esbuild only STRIPS types, so a shim that disagrees with its generated ABI
// bundles happily and fails in a browser; `scan.control.check.ts` beside this file is what holds the two together.
//
// The Core chunk is never `import`ed statically. `import(host.chunkUrl("Core"))` is a dynamic import of a runtime
// string, which esbuild leaves alone — that is what keeps 37 KB of glue and 1.07 MB of decoder out of this bundle
// and out of every page that mounts a scanner it never activates.

import type { BarcodeScannerHandle, BarcodeScannerHost, BarcodeScannerProps } from './scan.control';

type Host = BarcodeScannerHost;
type Props = Partial<BarcodeScannerProps>;

// ── the Core chunk's surface, declared STRUCTURALLY ──────────────────────────────────────────────────────────────
//
// Deliberately not `import type … from 'zxing-wasm'`. The package is a BUILD dependency of this kit — the thing
// `scripts/build-chunks.mjs` copies bytes out of — and at run time the module arrives as a URL the platform minted,
// with no package resolution in play at all. Naming the two halves of that with one import would say they are one
// thing. What the shim needs is small enough to state, and stating it is what makes an upgrade that changes the
// signature a type error here rather than a silent `undefined` at the first scan.

/** One decode. `text` is the payload; `format` is ZXing's own name for the symbology (`QRCode`, `EAN-13`, …). */
interface ReadResult {
  readonly isValid: boolean;
  readonly text: string;
  readonly format: string;
}

interface ZXingReader {
  /** Instantiate the module, with `locateFile` pointed at the Wasm chunk. `fireImmediately` makes this the await. */
  prepareZXingModule(options: {
    overrides: { locateFile: (path: string) => string };
    fireImmediately: true;
  }): Promise<unknown>;
  readBarcodes(
    input: ImageData,
    options?: { formats?: string[]; tryHarder?: boolean; maxNumberOfSymbols?: number },
  ): Promise<ReadResult[]>;
}

/** The three `formats:` words the control declares, spelled as ZXing's format list.
 *
 *  `AllLinear` and `All` are ZXing META-formats, not formats — asking for the family by name is what lets this stay
 *  a three-word choice instead of a list of forty-three the app would have to keep in step with the decoder. */
const FORMATS: Readonly<Record<string, string[]>> = {
  any: ['All'],
  qr: ['QRCode', 'MicroQRCode'],
  linear: ['AllLinear'],
};

/** The longest edge, in pixels, a frame is decoded at.
 *
 *  Not the camera's resolution and not a quality knob — a bound on WORK. Decoding is synchronous C++ on the main
 *  thread and its cost is proportional to the pixel count, so an unbounded 1080p frame four times a second is a page
 *  that janks while it scans. 1024 is high enough that a 1-D barcode's narrow bars survive (they are the thing that
 *  disappears first when you downscale, long before a QR's modules do) and low enough that a decode stays inside a
 *  frame budget on a phone. */
const MaxEdge = 1024;

/** A camera hint. `environment`/`user` are the browser's words; `back`/`front` are the ones a person would use. */
const FACING: Readonly<Record<string, string>> = { back: 'environment', front: 'user' };

/** What went wrong, in words for a person rather than a `DOMException` name. The name is the only part of a
 *  getUserMedia rejection that is specified — the message is whatever the browser felt like — so it is what this
 *  reads, and everything unrecognised falls through to the browser's own text rather than to a shrug. */
function describe(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Camera access was refused. Allow the camera for this site and scan again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'This device has no camera available to scan with.';
  if (name === 'NotReadableError')
    return 'The camera is already in use by another app or tab.';
  return `The scanner could not start: ${String((err as { message?: string } | null)?.message ?? err)}`;
}

export function mount(el: HTMLElement, props: Props, host: Host): BarcodeScannerHandle {
  let current: Props = { ...props };

  // ── the viewfinder ────────────────────────────────────────────────────────────────────────────────────────────
  // `headless`, so every colour comes from the app's tokens: this control has no palette of its own, and the box it
  // is dropped into is the app's to size. `object-fit: cover` rather than `contain` because a scanner is aimed —
  // filling the box is what makes "point it at the label" mean what it looks like it means.
  //
  // The HOST is the platform's element, sized by the declaration's `sizing fill` — so the frame is drawn on
  // an element of this control's own, which fills it. The shim never styles the box it was handed.
  const frame = document.createElement('div');
  frame.style.position = 'relative';
  frame.style.overflow = 'hidden';
  frame.style.boxSizing = 'border-box';
  frame.style.width = '100%';
  frame.style.height = '100%';
  frame.style.background = host.tokens.cssVar('colors-surface');
  frame.style.border = `1px solid ${host.tokens.cssVar('colors-border')}`;
  el.appendChild(frame);

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('playsinline', '');    // iOS Safari reads the ATTRIBUTE, not the property, and full-screens without it
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'cover';
  video.style.display = 'block';
  frame.appendChild(video);

  // Off-screen and never in the document: it exists to hold one frame's pixels on the way to the decoder.
  const canvas = document.createElement('canvas');

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────
  let stream: MediaStream | null = null;
  let reader: ZXingReader | null = null;
  let loading: Promise<ZXingReader> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  let scanning = false;
  let scans = 0;
  let last: string | null = null;
  let failure: string | null = null;

  // The dedupe pair — see `repeatAfterMs` on the declaration. `lastEmittedAt` is when the CURRENT text was last reported,
  // not when the last frame was decoded.
  let lastEmitted: string | null = null;
  let lastEmittedAt = 0;

  /** Raise `failed` ONCE per cause. The loop runs four times a second and a dead camera fails on every pass, so an
   *  unguarded emit is four toasts a second for as long as the page is open. */
  function fail(reason: string): void {
    if (failure === reason) return;
    failure = reason;
    host.emit('failed', reason);
  }

  /** Load the glue and instantiate the module, pointing `locateFile` at the chunk the platform serves.
   *
   *  Without the override the glue fetches its `.wasm` from a CDN, which the app page's content-security policy
   *  refuses — and refuses SILENTLY as far as the app is concerned: the promise rejects somewhere inside Emscripten
   *  and the scanner simply never reads anything. */
  function loadDecoder(): Promise<ZXingReader> {
    // The PROMISE is cached, not the module: `active` can flip several times before the first load finishes, and
    // caching only the result would start a second 1.07 MB download for each flip.
    if (loading) return loading;
    loading = (async () => {
      const mod = (await import(/* @vite-ignore */ host.chunkUrl('Core'))) as ZXingReader;
      await mod.prepareZXingModule({
        overrides: { locateFile: () => host.chunkUrl('Wasm') },
        fireImmediately: true,
      });
      return mod;
    })();
    // A failed load must not be remembered as failed for ever — a page that comes back from an offline moment
    // should be able to try again the next time it is activated.
    loading.catch(() => { loading = null; });
    return loading;
  }

  /** Open the camera and start the loop. Safe to call when already running. */
  async function start(): Promise<void> {
    if (destroyed || scanning) return;
    scanning = true;

    const devices = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
    if (!devices?.getUserMedia) {
      scanning = false;
      fail('This browser cannot open a camera, so there is nothing to scan. A camera needs a secure (https) page.');
      return;
    }

    try {
      // `ideal`, never `exact`: a laptop has one camera and an `exact: "environment"` demand fails on it outright,
      // which would make the default value of `facing` refuse to run on every desktop.
      stream = await devices.getUserMedia({
        video: {
          facingMode: { ideal: FACING[current.facing ?? 'back'] ?? 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (err) {
      scanning = false;
      fail(describe(err));
      return;
    }

    // The person may have navigated away while the permission prompt was up.
    if (destroyed) { stop(); return; }

    video.srcObject = stream;
    try { await video.play(); } catch { /* a paused video still yields frames once it has data */ }

    let decoder: ZXingReader;
    try {
      decoder = await loadDecoder();
    } catch (err) {
      scanning = false;
      stop();
      fail(`The barcode decoder could not be loaded: ${String((err as { message?: string } | null)?.message ?? err)}`);
      return;
    }
    if (destroyed) { stop(); return; }

    reader = decoder;
    failure = null;
    schedule(0);
  }

  /** Release the camera and stop the loop. Safe to call when nothing is running — an app tearing down should not
   *  have to ask first. */
  function stop(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    video.srcObject = null;
    scanning = false;
  }

  /** Chained timeouts, not an interval, and that is the whole concurrency model. A decode is async and can take longer than
   *  `intervalMs` on a slow device; `setInterval` would then queue a second decode on top of the first, and a phone
   *  that fell behind would fall further behind on every tick until the page stopped responding. The next look is
   *  scheduled when the previous one FINISHES, so there is never more than one in flight — by construction, with no
   *  flag to get wrong. */
  function schedule(delay: number): void {
    if (destroyed || !scanning) return;
    timer = setTimeout(() => { void tick(); }, delay);
  }

  async function tick(): Promise<void> {
    timer = null;
    if (destroyed || !scanning || !reader) return;

    try {
      const frame = grabFrame();
      if (frame) {
        const results = await reader.readBarcodes(frame, {
          formats: FORMATS[current.formats ?? 'any'] ?? FORMATS.any,
          // The frame is a live camera picture, not a generated image, so the extra passes earn their time.
          tryHarder: true,
          // One code per look. A scanner is aimed at a thing; reporting the six barcodes that happened to share the
          // shelf would be noise, and the app has no way to know which one the person meant.
          maxNumberOfSymbols: 1,
        });
        for (const r of results) if (r.isValid && r.text) report(r);
      }
    } catch (err) {
      fail(`The barcode decoder failed while reading: ${String((err as { message?: string } | null)?.message ?? err)}`);
    }

    schedule(Math.max(0, current.intervalMs ?? 250));
  }

  /** Draw the current video frame into the canvas and read its pixels back, bounded by {@link MaxEdge}.
   *  Null before the camera has produced a frame — which is normal for the first tick or two. */
  function grabFrame(): ImageData | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const scale = Math.min(1, MaxEdge / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /** Report one read, unless the same text was reported too recently.
   *
   *  The suppression is not a nicety. A label left in front of the camera is read on EVERY pass — four times a
   *  second at the default interval — so an app that appends a row per scan would collect forty rows from one label
   *  held for ten seconds. `repeatAfterMs: 0` opts out, for an app that genuinely wants every read. */
  function report(r: ReadResult): void {
    const now = Date.now();
    const window_ = current.repeatAfterMs ?? 2000;
    if (r.text === lastEmitted && now - lastEmittedAt < window_) return;

    lastEmitted = r.text;
    lastEmittedAt = now;
    scans += 1;
    last = r.text;
    host.emit('scanned', r.text, r.format);
  }

  /** Apply what the app just changed. Only a `facing` change costs a camera restart — swapping the format list or
   *  the interval takes effect on the next look, with no permission prompt and no black frame. */
  function apply(next: Props): void {
    const wasActive = current.active ?? true;
    const facingChanged = (next.facing ?? 'back') !== (current.facing ?? 'back');
    current = { ...next };
    const nowActive = current.active ?? true;

    if (!nowActive) { stop(); return; }
    if (!wasActive || (facingChanged && scanning)) { stop(); void start(); return; }
    if (!scanning) void start();
  }

  if (current.active ?? true) void start();

  return {
    update(next: Props): void { if (!destroyed) apply(next); },
    destroy(): void {
      destroyed = true;
      stop();
      video.srcObject = null;
      el.replaceChildren();
    },
    probe() {
      return { scanning, scans, last, failure };
    },
  };
}
