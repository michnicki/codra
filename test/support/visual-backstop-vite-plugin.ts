/**
 * Vite plugin that serves the production Vite/Tailwind build (`dist/client/`) from inside the
 * vitest server itself, so the browser harness can `fetch()` the bundled CSS from a known
 * path on the vitest server origin.
 *
 * Phase 20.1 WARNING 1 closure: the visual backstop at `test/browser/visual-backstops.spec.tsx`
 * needs the production CSS the build emits. The browser runs inside @vitest/browser-playwright
 * chromium and cannot:
 *
 *   - Run `vite build` (uses `node:child_process`).
 *   - Start an `http.createServer` (node-only API).
 *   - Read `process.env.*` (vitest strips the global in browser context).
 *
 * The cleanest portable bridge is a Vite plugin: vitest already exposes a server in the node
 * worker that the browser navigates to. We attach a middleware that serves files from
 * `dist/client/` at `/__visual-backstop__/*`. The browser test derives the origin from
 * `window.location.origin` and fetches `${origin}/__visual-backstop__/index.html` to discover
 * the hashed CSS asset. The vite plugin does NOT rebuild the bundle — that's the globalSetup's
 * job (it runs once, in node, before any test, so the directory is populated by the time the
 * browser harness loads any HTML).
 *
 * The plugin also sets `window.__VISUAL_BACKSTOP_BASE__` via `transformIndexHtml` so the
 * browser test can discover the base path without hardcoding the segment name in two places.
 *
 * NOTE: this file is intentionally side-effect-free — it exports a Vite plugin factory. Vitest
 * loads it transitively from `vitest.config.ts` via the static `import`. The plugin is only
 * attached when running vitest; it has no effect on production builds.
 */
import type { Plugin, ViteDevServer } from 'vite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  VISUAL_BACKSTOP_PATH_SEGMENT,
  VISUAL_BACKSTOP_WINDOW_KEY,
} from './visual-backstop-runtime';

export function visualBackstopPlugin(): Plugin {
  return {
    name: 'codra:visual-backstop-static-serve',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const distClientPath = path.resolve(process.cwd(), 'dist', 'client');

      server.middlewares.use(VISUAL_BACKSTOP_PATH_SEGMENT, (req, res, next) => {
        if (!req.url) {
          next();
          return;
        }
        // Strip the query string; treat `/` as `/index.html`.
        const rawPath = req.url.split('?')[0] || '/';
        const normalized = rawPath === '/' ? '/index.html' : rawPath;
        const safeRelative = path.posix.normalize(normalized).replace(/^[/\\]+/, '');
        const absolute = path.join(distClientPath, safeRelative);
        if (!absolute.startsWith(distClientPath)) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        if (!existsSync(absolute) || !statSync(absolute).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const body = readFileSync(absolute);
        const ext = path.extname(absolute).toLowerCase();
        res.setHeader('Content-Type', mimeFor(ext));
        res.setHeader('Content-Length', String(body.byteLength));
        res.statusCode = 200;
        res.end(body);
      });
    },
    transformIndexHtml(html) {
      // Inject the base path so the browser test can read it without hardcoding the segment
      // name in two places. The script tag is a string literal so the value is immutable.
      const injected = `<script>window.${VISUAL_BACKSTOP_WINDOW_KEY}=${JSON.stringify(VISUAL_BACKSTOP_PATH_SEGMENT)};</script>`;
      if (html.includes('</head>')) {
        return html.replace('</head>', `${injected}</head>`);
      }
      return `${injected}${html}`;
    },
  };
}

function mimeFor(ext: string): string {
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}