/**
 * Production-build + static-serve helper for the visual-backstops browser suite.
 *
 * Phase 20.1 WARNING 1 closure: the visual backstop at
 * `test/browser/visual-backstops.spec.tsx` previously injected hardcoded Tailwind utility CSS
 * into the test document. The computed-style assertions proved the real surface node had the
 * expected class AND the test stylesheet assigned the expected declaration — but did NOT prove
 * the production Vite/Tailwind build (`vite build` output) contained or applied that CSS.
 *
 * This helper makes the production-CSS smoke test first-class:
 *
 *   1. `buildProductionBundle()` runs `npx vite build` synchronously against the repo root and
 *      produces `dist/client/` (the exact same output the worker ships to Cloudflare Workers
 *      Assets). Exit code, stdout, and stderr are captured so failures are diagnosable.
 *
 *   2. `serveProductionBundle()` starts an `http.createServer` on an OS-assigned port (`port: 0`)
 *      and serves the built `dist/client/` tree as static files. Returns `{ url, close }` so the
 *      caller can fetch the bundled CSS / JS from a real HTTP origin in the browser harness.
 *      The HTTP server fixture proves the production bundle is deployable (status 200 on `/`,
 *      status 200 on the referenced CSS asset) — exactly what Workers Assets would deliver.
 *
 *   3. `cleanProductionBuild()` removes `dist/client/` so the suite leaves no transient
 *      artifact behind. Called from `afterAll`.
 *
 * The helper uses Node built-ins only (`node:child_process`, `node:http`, `node:fs`,
 * `node:path`, `node:url`) — no new dependency. The build invocation shells out to the
 * `vite` CLI shipped in the repo's devDependencies so the production bundle matches what
 * `npm run build` produces.
 *
 * See: `.planning/phases/20.1-close-gap-blockers-1-5-warning-1-successor-routing-privacy-r/20.1-05-PLAN.md`
 * (D-20/D-21/D-22 — production-CSS smoke test).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distClientPath = path.join(repoRoot, 'dist', 'client');

export type BuildResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ServeHandle = {
  url: string;
  close: () => Promise<void>;
};

/**
 * Build the production Vite/Tailwind bundle (`npm run build`'s `vite build` step).
 *
 * Synchronous so the test setup can fail fast. Uses `spawnSync` with `stdio: 'pipe'` so we
 * capture stdout/stderr for diagnostics. The cwd is the repo root (not the test directory) so
 * `vite build` resolves `vite.config.ts` the same way it would in CI.
 *
 * The output is written to `dist/client/` (the `build.outDir` in `vite.config.ts`). The
 * `cf-typegen` step that normally follows in `npm run build` is intentionally NOT invoked —
 * this helper exists to load the client bundle, not to regenerate Worker types. If the build
 * fails, the returned `exitCode` is non-zero and `stderr` describes why.
 */
export function buildProductionBundle(): BuildResult {
  const result: SpawnSyncReturns<string> = spawnSync('npx', ['vite', 'build'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Start a static HTTP server that serves `dist/client/` on an OS-assigned port.
 *
 * Returns once the server is listening. The `url` is the origin (`http://127.0.0.1:<port>/`)
 * — the caller can `fetch(url + '/index.html')`, `fetch(url + '/assets/index-<hash>.css')`,
 * etc. The `close()` function gracefully shuts the server down.
 *
 * Port 0 lets the kernel pick a free port, avoiding the parallel-port-race noted in the
 * project's project_constraints. If the build has not yet run, this function still starts a
 * server but `GET /` will 404 — callers should run `buildProductionBundle()` first.
 */
export async function serveProductionBundle(): Promise<ServeHandle> {
  if (!existsSync(distClientPath)) {
    // The dist tree may have been wiped by `cleanProductionBuild` between build and serve
    // (e.g. when a test reorders the lifecycle). Re-create it as an empty directory so the
    // server's fs.stat calls don't throw on missing paths.
    mkdirSync(distClientPath, { recursive: true });
  }

  const server = http.createServer((req, res) => {
    const requestUrl = req.url ?? '/';
    // Strip the query string; map "/" or empty to "/index.html" so static serving matches
    // Vite's build output layout (`dist/client/index.html` + `dist/client/assets/*`).
    const rawPath = requestUrl.split('?')[0] || '/';
    const normalized = rawPath === '/' ? '/index.html' : rawPath;
    const safeRelative = path.posix.normalize(normalized).replace(/^[/\\]+/, '');
    const absolute = path.join(distClientPath, safeRelative);
    if (!absolute.startsWith(distClientPath)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    if (!existsSync(absolute)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const stat = statSync(absolute);
    if (!stat.isFile()) {
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

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('serveProductionBundle: could not resolve listening port');
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Remove the transient `dist/client/` build output. Called from `afterAll` so the repo
 * working tree is clean after the suite runs.
 *
 * Uses `force: true` so a missing directory does not throw. The `recursive: true` flag
 * descends into `dist/client/assets/`.
 */
export function cleanProductionBuild(): void {
  rmSync(distClientPath, { recursive: true, force: true });
}

/**
 * Resolve the path to the bundled CSS file (`dist/client/assets/index-<hash>.css`).
 *
 * Vite emits a single hashed CSS file per entry. We scan the `assets/` directory for the
 * first `*.css` file. Throws if the build has not been run yet (or if the build did not
 * emit any CSS — which would be a Tailwind configuration regression).
 */
export function findBundledCssPath(): string {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const assetsDir = path.join(distClientPath, 'assets');
  if (!existsSync(assetsDir)) {
    throw new Error(`findBundledCssPath: ${assetsDir} does not exist — run buildProductionBundle() first`);
  }
  const cssFile = readdirSync(assetsDir).find((name) => name.endsWith('.css'));
  if (!cssFile) {
    throw new Error(`findBundledCssPath: no .css file found in ${assetsDir} — Tailwind did not emit a CSS bundle`);
  }
  return path.join(assetsDir, cssFile);
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

export const __testing__ = {
  repoRoot,
  distClientPath,
};