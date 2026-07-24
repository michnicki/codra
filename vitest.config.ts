import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { resolve } from 'path';
import { visualBackstopPlugin } from './test/support/visual-backstop-vite-plugin';

export default defineConfig({
  // The real build-time value is computed in vite.config.ts from `git describe`, but the
  // vitest node/browser projects never load vite.config.ts, so settings.tsx's ambient
  // `__APP_VERSION__` read is otherwise undefined at render time. A static stand-in is enough —
  // no test asserts the actual version string.
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  plugins: [react(), visualBackstopPlugin()],
  resolve: {
    alias: {
      '@server': resolve(__dirname, './src/server'),
      '@client': resolve(__dirname, './src/client'),
      '@shared': resolve(__dirname, './src/shared'),
      '@': resolve(__dirname, './src/client'),
      'cloudflare:workers': resolve(__dirname, './test/mocks/cloudflare-workers.ts'),
    },
  },
  test: {
    globals: true,
    // Phase 20.1 WARNING 1 closure: build the production Vite/Tailwind bundle once (in node
    // context) before any test runs so the browser harness can fetch the production CSS from a
    // real origin. The globalSetup at `test/support/visual-backstop-global-setup.ts` invokes
    // `vite build` + `cleanProductionBuild`; the served-asset behavior is provided by the
    // `visualBackstopPlugin` Vite plugin (above) which exposes `dist/client/` at
    // `${window.__VISUAL_BACKSTOP_BASE__}/*` on the vitest server origin. The browser test
    // reads the injected base path and fetches the bundled CSS via fetch().
    globalSetup: ['./test/support/visual-backstop-global-setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.spec.ts'],
          exclude: ['test/browser/**'],
          setupFiles: ['./test/setup.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        // Pre-bundle every third-party dep the browser suite imports. Without this, Vite's dep
        // optimizer discovers deps lazily as test files load and, on a cold cache (every CI run does
        // a fresh `npm ci`), re-optimizes mid-run — which triggers a Vite reload that aborts the
        // in-flight dynamic imports and fails whichever suites were loading at that moment with
        // "Failed to fetch dynamically imported module" (flaky, run-order-dependent). Enumerating
        // the deps up front forces a single pre-run optimize pass, so no reload happens mid-suite.
        // Keep this list in sync with the bare imports under src/client + test/browser.
        optimizeDeps: {
          include: [
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'react-dom',
            'react-dom/client',
            'react-router-dom',
            'lenis',
            'lenis/react',
            'motion/react',
            'lucide-react',
            'react-markdown',
            'remark-gfm',
            'rehype-raw',
            'rehype-sanitize',
            'recharts',
            'sonner',
            'clsx',
            'class-variance-authority',
            'tailwind-merge',
            '@radix-ui/react-dialog',
            '@radix-ui/react-slot',
            '@testing-library/react',
            '@testing-library/user-event',
            '@testing-library/jest-dom/vitest',
          ],
        },
        test: {
          name: 'browser',
          include: ['test/browser/**/*.spec.tsx'],
          setupFiles: ['./test/browser/setup.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});