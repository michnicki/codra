/**
 * Browser-safe loader for the production Vite/Tailwind bundle.
 *
 * Phase 20.1 WARNING 1 closure: the visual-backstops browser suite
 * (`test/browser/visual-backstops.spec.tsx`) loads the production CSS that `vite build`
 * emits instead of injecting hardcoded utility declarations.
 *
 * This helper is the *browser-context* half of that pipeline. It contains NO node-only
 * imports (no `node:fs`, `node:http`, `node:child_process`) so it can be statically imported
 * by a spec that runs inside the @vitest/browser-playwright Chromium harness without
 * triggering Vite's "module externalized for browser compatibility" failure.
 *
 * The *node-context* half — building the bundle — lives in
 * `test/support/visual-backstop-build.ts` and is invoked by
 * `test/support/visual-backstop-global-setup.ts` (a vitest `globalSetup` script that runs
 * before any test). Serving `dist/client/` over HTTP is handled by the
 * `visualBackstopPlugin` Vite plugin (see `test/support/visual-backstop-vite-plugin.ts`),
 * which exposes the build output at `${window.__VISUAL_BACKSTOP_BASE__}/*` on the vitest
 * server origin. The browser harness derives that origin from `window.location.origin`.
 *
 * Contract:
 *   - `loadProductionStylesheet(bundleUrl, document)` fetches `/index.html` from `bundleUrl`,
 *     extracts the hashed CSS asset reference, fetches the CSS file, and injects it as a
 *     real `<link rel="stylesheet">` on the target document. Returns the link element so
 *     the caller can remove it in `afterAll`.
 *   - `removeProductionStylesheet(link)` removes a previously-injected stylesheet link.
 *
 * Both functions are pure: they perform no I/O outside the served origin and no global
 * mutation beyond the DOM element they create/remove.
 */

const CSS_HREF_PATTERN = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/i;

export type StylesheetLink = HTMLLinkElement;

/**
 * The path segment where `dist/client/` is mounted on the vitest server origin. The Vite
 * plugin (`test/support/visual-backstop-vite-plugin.ts`) and the browser test must agree on
 * this string; both import it from this module so they cannot drift.
 */
export const VISUAL_BACKSTOP_PATH_SEGMENT = '/__visual-backstop__';

/**
 * The `window.*` key the Vite plugin uses to inject the base path into the test document.
 * The browser spec reads `window[VISUAL_BACKSTOP_WINDOW_KEY]` to discover where to fetch the
 * production CSS from.
 */
export const VISUAL_BACKSTOP_WINDOW_KEY = '__VISUAL_BACKSTOP_BASE__';

/**
 * Fetch the served index.html, discover the hashed CSS asset, fetch it, and inject the
 * resulting stylesheet into the target document as a real `<link>` element.
 *
 * The function is intentionally synchronous from the caller's perspective: it awaits the
 * network round-trips and returns the link element so the caller can remove it in
 * `afterAll`.
 *
 * Throws if:
 *   - `bundleUrl` does not return 200 on GET /
 *   - the served HTML does not reference a CSS asset
 *   - the referenced CSS asset does not return 200
 *   - the loaded stylesheet is removed from `<head>` after load
 *   - the production CSS is loaded but the `.break-all` utility does not apply to a probe
 *     element (this catches Tailwind-purge misconfigs and CSS-layer specificity issues
 *     before the suite hits cryptic computed-style mismatches downstream)
 *
 * The `bundleUrl` is the full base path including the vite-plugin mount point (e.g.
 * `http://localhost:63315/__visual-backstop__`). The cssHref parsed from the served
 * index.html is concatenated onto it — NOT resolved via the URL constructor, which would
 * discard the mount point for absolute references.
 */
export async function loadProductionStylesheet(
  bundleUrl: string,
  target: Document = document,
): Promise<StylesheetLink> {
  const origin = bundleUrl.replace(/\/+$/, '');

  const indexResponse = await fetch(origin + '/index.html');
  if (!indexResponse.ok) {
    throw new Error(
      `loadProductionStylesheet: GET ${origin}/index.html returned ${indexResponse.status}`,
    );
  }
  const indexHtml = await indexResponse.text();

  const cssHrefMatch = indexHtml.match(CSS_HREF_PATTERN);
  if (!cssHrefMatch) {
    throw new Error(
      `loadProductionStylesheet: served index.html did not reference a CSS asset:\n${indexHtml}`,
    );
  }
  const cssHref = cssHrefMatch[1];
  // The cssHref from the served index.html is an absolute path (e.g. "/assets/index-XXX.css")
  // relative to the bundle origin. The vite plugin mounts dist/client/ under the bundle base
  // path (e.g. "/__visual-backstop__"), so we must concat the cssHref onto the bundle URL —
  // NOT resolve it via the URL constructor, which would discard the base path for absolute
  // references. Concatenation preserves the plugin's mount point.
  const cssUrl = `${origin}${cssHref.startsWith('/') ? '' : '/'}${cssHref}`;

  // Confirm the CSS endpoint actually serves before we wire the link into the document —
  // a 404 on the asset would otherwise leave the test asserting against an empty stylesheet.
  const cssHead = await fetch(cssUrl, { method: 'HEAD' });
  if (!cssHead.ok) {
    throw new Error(
      `loadProductionStylesheet: GET ${cssUrl} returned ${cssHead.status}`,
    );
  }

  const link = target.createElement('link');
  link.rel = 'stylesheet';
  link.href = cssUrl;
  link.dataset.productionBundle = 'codra-tailwind';
  target.head.appendChild(link);

  // Wait for the stylesheet to actually load before resolving. Without this, the test's
  // getComputedStyle() calls can race the CSSOM attach and observe empty declarations.
  // We listen for the `load` event and reject on `error` so a 404 or parse failure fails
  // the suite loudly rather than silently producing a flaky pass.
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      link.removeEventListener('load', onLoad);
      link.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`loadProductionStylesheet: stylesheet at ${cssUrl} failed to load`));
    };
    link.addEventListener('load', onLoad, { once: true });
    link.addEventListener('error', onError, { once: true });
  });

  // Sanity probe: verify the production CSS rules actually apply to the test document.
  // If a `.break-all` element does not compute to `word-break: break-all`, the suite has
  // loaded the wrong stylesheet, hit a Tailwind-purge misconfig, or fallen into a CSS-layer
  // ordering bug. Fail loudly so the diagnostic surfaces in CI instead of as cryptic
  // computed-style mismatches in the per-element assertions below.
  const probe = target.createElement('div');
  probe.className = 'break-all';
  probe.style.position = 'absolute';
  probe.style.left = '-9999px';
  probe.style.width = '10px';
  probe.style.height = '10px';
  target.body.appendChild(probe);
  const probeStyle = target.defaultView?.getComputedStyle(probe).wordBreak ?? null;
  probe.remove();
  if (probeStyle !== 'break-all') {
    throw new Error(
      [
        `loadProductionStylesheet: production CSS loaded but a .break-all probe returned "${probeStyle}" — rules are not applying.`,
        `cssUrl=${cssUrl}`,
        `Loaded stylesheets: ${Array.from(target.styleSheets)
          .map((sheet) => `${sheet.href ?? '(inline)'} (${(() => { try { return sheet.cssRules.length; } catch { return 'cross-origin'; } })()} rules)`)
          .join(', ')}`,
      ].join('\n'),
    );
  }

  return link;
}

/**
 * Remove a stylesheet link previously returned by `loadProductionStylesheet`. Safe to call
 * with `null` (idempotent).
 */
export function removeProductionStylesheet(link: StylesheetLink | null): void {
  link?.remove();
}