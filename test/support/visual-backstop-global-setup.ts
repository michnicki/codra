/**
 * Vitest globalSetup for the visual backstop.
 *
 * Phase 20.1 WARNING 1 closure: the visual-backstops browser suite loads the production
 * Vite/Tailwind build instead of injecting hardcoded utility CSS. Building the production
 * bundle is a node-only operation (it uses `child_process.spawnSync` to invoke `vite build`).
 * The browser harness (chromium via @vitest/browser-playwright) can't perform the build itself.
 *
 * Vitest's `globalSetup` is the canonical seam: it runs ONCE in the node context before any
 * test file. This script:
 *
 *   1. Runs `buildProductionBundle()` — produces `dist/client/` with the same output
 *      `npm run build` would emit in CI.
 *   2. Returns a teardown function that removes `dist/client/` so the test run leaves no
 *      transient artifact on disk.
 *
 * Serving the bundle is handled by the `visualBackstopPlugin` Vite plugin (see
 * `test/support/visual-backstop-vite-plugin.ts`), which exposes `dist/client/` at a known
 * path on the vitest server origin. The browser harness fetches the bundled CSS from there —
 * no env-var passing, no separate http.createServer, no parallel-port race.
 *
 * The helper unit tests at `test/support/visual-backstop-build.spec.ts` exercise the helper
 * module directly and do their own build + serve in their `beforeAll`/`afterAll`; they
 * intentionally do not depend on this shared build.
 *
 * See: `.planning/phases/20.1-close-gap-blockers-1-5-warning-1-successor-routing-privacy-r/20.1-05-PLAN.md`
 * (D-20/D-21/D-22 — production-CSS smoke test).
 */
import { buildProductionBundle, cleanProductionBuild } from './visual-backstop-build';

export async function setup() {
  const build = buildProductionBundle();
  if (build.exitCode !== 0) {
    throw new Error(
      [
        'visual-backstop-global-setup: buildProductionBundle failed.',
        `vite build exit code: ${build.exitCode}`,
        `STDERR:\n${build.stderr}`,
        `STDOUT:\n${build.stdout}`,
      ].join('\n'),
    );
  }

  // eslint-disable-next-line no-console
  console.log('[visual-backstop] production bundle built at dist/client/');

  return async function teardown() {
    cleanProductionBuild();
  };
}