/**
 * Unit tests for the production-build + serve helper.
 *
 * Phase 20.1 WARNING 1 closure: the visual backstop now loads the production Vite/Tailwind
 * build (`dist/client/`) instead of injecting hardcoded utility CSS. The helper at
 * `test/support/visual-backstop-build.ts` is the seam — these tests pin the build, serve, and
 * cleanup behavior so a regression in the helper is caught before the browser suite fails.
 *
 * Each test corresponds to a behavior listed in the plan (Tests 11-16):
 *   11. buildProductionBundle calls vite build via child_process.spawnSync; returns exit code 0.
 *   12. buildProductionBundle produces dist/client/index.html on disk.
 *   13. serveProductionBundle starts http.createServer on an OS-assigned port (port 0); returns a URL.
 *   14. serveProductionBundle returns 200 on GET /.
 *   15. serveProductionBundle returns the bundled CSS file referenced from the served index.html.
 *   16. cleanProductionBuild removes dist/client/.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  buildProductionBundle,
  cleanProductionBuild,
  findBundledCssPath,
  serveProductionBundle,
} from './visual-backstop-build';

afterAll(() => {
  cleanProductionBuild();
});

describe('visual-backstop-build helper', () => {
  it('Test 11: buildProductionBundle returns exitCode 0', () => {
    const result = buildProductionBundle();
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) {
      // Surface stderr in the failure message so a CI run is diagnosable.
      throw new Error(`vite build failed (exit ${result.exitCode}):\n${result.stderr}`);
    }
  }, 180_000);

  it('Test 12: dist/client/index.html exists after buildProductionBundle', () => {
    const result = buildProductionBundle();
    expect(result.exitCode).toBe(0);
    const indexHtmlPath = path.join(
      path.resolve(path.dirname(__filename), '..', '..'),
      'dist',
      'client',
      'index.html',
    );
    expect(existsSync(indexHtmlPath)).toBe(true);
  }, 180_000);

  it('Test 13: serveProductionBundle returns a handle with a URL', async () => {
    buildProductionBundle();
    const handle = await serveProductionBundle();
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(typeof handle.close).toBe('function');
    } finally {
      await handle.close();
    }
  }, 180_000);

  it('Test 14: GET on the served URL returns 200', async () => {
    buildProductionBundle();
    const handle = await serveProductionBundle();
    try {
      const status = await fetchStatus(handle.url + '/');
      expect(status).toBe(200);
    } finally {
      await handle.close();
    }
  }, 180_000);

  it('Test 15: GET on the bundled CSS URL returns 200 with a non-empty body', async () => {
    buildProductionBundle();
    const handle = await serveProductionBundle();
    try {
      const cssPath = findBundledCssPath();
      const cssFileName = path.basename(cssPath);
      const cssUrl = handle.url + '/assets/' + cssFileName;
      const { status, body } = await fetchBody(cssUrl);
      expect(status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
      // Sanity-check: the production CSS must contain at least one Tailwind utility we depend on.
      // `.line-clamp-2` is the load-bearing class asserted in visual-backstops.spec.tsx for the
      // two-line title geometry test. If Tailwind drops it from the production build, the visual
      // backstop must fail — this test pins that contract.
      expect(body).toMatch(/line-clamp-2/);
    } finally {
      await handle.close();
    }
  }, 180_000);

  it('Test 16: cleanProductionBuild removes dist/client/', () => {
    buildProductionBundle();
    const distPath = path.join(
      path.resolve(path.dirname(__filename), '..', '..'),
      'dist',
      'client',
    );
    expect(existsSync(distPath)).toBe(true);
    cleanProductionBuild();
    expect(existsSync(distPath)).toBe(false);
  }, 180_000);
});

// --- helpers ---

function fetchStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
}

function fetchBody(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
  });
}

// Re-export so the test file can be tree-shaken correctly under `noUncheckedIndexedAccess` etc.
export const __loaded__ = readFileSync;