import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED_COMMIT = '3d5f4150f8ff88787c10a3067ddc59176285eb25';
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(rootDir, 'test/phase19-default-baseline.fixture.json');
const harnessPath = path.join(rootDir, 'test/support/phase19-baseline-harness.ts');
const vitestCli = path.join(rootDir, 'node_modules/vitest/vitest.mjs');

function usage() {
  console.error('Usage: node scripts/capture-phase19-baseline.mjs --write | --check');
  process.exitCode = 2;
}

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') usage();
if (process.exitCode) process.exit();

if (!existsSync(harnessPath)) throw new Error(`Missing harness: ${harnessPath}`);
if (!existsSync(vitestCli)) throw new Error(`Missing Vitest CLI: ${vitestCli}`);
if (mode === '--write' && existsSync(fixturePath)) {
  throw new Error(`Refusing to overwrite pinned oracle: ${fixturePath}`);
}
execFileSync('git', ['cat-file', '-e', `${PINNED_COMMIT}^{commit}`], { cwd: rootDir, stdio: 'inherit' });

const tempRoot = fsMkdtemp(path.join(os.tmpdir(), 'opencodra-phase19-baseline-'));
const worktree = path.join(tempRoot, 'pre-phase19');
const outputPath = path.join(tempRoot, 'baseline.json');
const captureSpec = path.join(worktree, 'test/phase19-baseline-capture.spec.ts');

try {
  execFileSync('git', ['worktree', 'add', '--detach', worktree, PINNED_COMMIT], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  symlinkSync(path.join(rootDir, 'node_modules'), path.join(worktree, 'node_modules'), 'dir');
  mkdirSync(path.join(worktree, 'test/support'), { recursive: true });
  copyFileSync(harnessPath, path.join(worktree, 'test/support/phase19-baseline-harness.ts'));
  writeFileSync(captureSpec, `import { writeFileSync } from 'node:fs';
import { buildPhase19Baseline } from './support/phase19-baseline-harness';
import { describe, expect, it } from 'vitest';

describe('pinned Phase 19 baseline capture', () => {
  it('writes the pre-Phase-19 oracle', () => {
    const outputPath = process.env.PHASE19_BASELINE_OUTPUT;
    if (!outputPath) throw new Error('PHASE19_BASELINE_OUTPUT is required');
    const output = {
      provenance: {
        captureCommit: '${PINNED_COMMIT}',
        source: 'detached pre-Phase-19 worktree',
        harness: 'test/support/phase19-baseline-harness.ts',
        canonicalization: 'JSON.stringify with fixed object insertion order',
      },
      ...buildPhase19Baseline(),
    };
    writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\\n');
    expect(output.provenance.captureCommit).toBe('${PINNED_COMMIT}');
  });
});
`);
  execFileSync(process.execPath, [vitestCli, 'run', '--project', 'node', captureSpec], {
    cwd: worktree,
    env: { ...process.env, PHASE19_BASELINE_OUTPUT: outputPath },
    stdio: 'inherit',
  });

  const captured = readFileSync(outputPath, 'utf8');
  const parsed = JSON.parse(captured);
  if (parsed.provenance?.captureCommit !== PINNED_COMMIT) {
    throw new Error('Capture provenance does not match the required pinned commit');
  }
  if (mode === '--write') {
    writeFileSync(fixturePath, captured);
    console.log(`Wrote pinned baseline fixture from ${PINNED_COMMIT}`);
  } else {
    if (!existsSync(fixturePath)) throw new Error(`Missing pinned oracle: ${fixturePath}`);
    const expected = readFileSync(fixturePath, 'utf8');
    if (captured !== expected) {
      throw new Error('Pinned baseline drifted; inspect the generated capture before changing the oracle');
    }
    console.log(`Pinned baseline check passed for ${PINNED_COMMIT}`);
  }
} finally {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: rootDir, stdio: 'inherit' });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function fsMkdtemp(prefix) {
  const tempPath = `${prefix}${process.pid}-${Date.now()}`;
  mkdirSync(tempPath, { recursive: true });
  return tempPath;
}
