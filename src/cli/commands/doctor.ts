/**
 * codemem doctor
 *
 * Runs a health check on the CodeMem installation and prints a clear
 * pass/fail report for every component.
 *
 * Checks:
 *   1. .codemem/ directory and config.json exist
 *   2. Vector index is present and has chunks
 *   3. Embedding model is cached locally
 *   4. CodeMem sidecar is running and reachable
 *   5. AI provider key is configured (optional, non-fatal)
 */

import { resolve, join } from 'path';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import chalk from 'chalk';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import { resolveServerPort } from '../../utils/runtime.js';

interface Check {
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail?: string;
  fix?: string;
}

export async function runDoctor(): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const checks: Check[] = [];

  ui.blank();
  console.log(chalk.bold('  CodeMem Doctor'));
  console.log(chalk.gray('  ─────────────────────────────────────────────────'));
  ui.blank();

  // ── CHECK 1: .codemem/ initialized ────────────────────────────────────────
  const codememDir = join(projectRoot, '.codemem');
  const configPath = join(codememDir, 'config.json');

  if (!existsSync(codememDir)) {
    checks.push({
      label: 'Project initialized',
      status: 'fail',
      detail: '.codemem/ directory not found',
      fix: 'Run "codemem init" to initialize this project',
    });
  } else if (!existsSync(configPath)) {
    checks.push({
      label: 'Project initialized',
      status: 'fail',
      detail: '.codemem/config.json missing',
      fix: 'Run "codemem init" to re-initialize',
    });
  } else {
    let projectName = '';
    try {
      const configStore = new ConfigStore(projectRoot);
      const cfg = configStore.read();
      projectName = cfg.project?.name ?? '';
    } catch {}
    checks.push({
      label: 'Project initialized',
      status: 'pass',
      detail: projectName ? `project: ${projectName}` : undefined,
    });
  }

  // ── CHECK 2: Vector index exists and has chunks ───────────────────────────
  const dbPath = join(codememDir, 'db');
  const indexFile = join(dbPath, 'index.json');

  if (!existsSync(dbPath) || !existsSync(indexFile)) {
    checks.push({
      label: 'Vector index',
      status: 'fail',
      detail: 'Index files not found',
      fix: 'Run "codemem init" to build the index',
    });
  } else {
    try {
      const stat = statSync(indexFile);
      const sizeKB = Math.round(stat.size / 1024);

      // Try to read chunk count from the index file quickly
      let chunkCount: number | null = null;
      try {
        const { readFileSync } = await import('fs');
        const raw = JSON.parse(readFileSync(indexFile, 'utf-8')) as { items?: unknown[] };
        chunkCount = raw.items?.length ?? null;
      } catch {}

      if (chunkCount === 0) {
        checks.push({
          label: 'Vector index',
          status: 'warn',
          detail: `Index exists but is empty (${sizeKB} KB)`,
          fix: 'Run "codemem reindex --full" to populate it',
        });
      } else {
        checks.push({
          label: 'Vector index',
          status: 'pass',
          detail: chunkCount !== null
            ? `${chunkCount.toLocaleString()} chunks · ${sizeKB} KB`
            : `${sizeKB} KB`,
        });
      }
    } catch {
      checks.push({
        label: 'Vector index',
        status: 'warn',
        detail: 'Could not read index',
        fix: 'Run "codemem reindex --full" to rebuild',
      });
    }
  }

  // ── CHECK 3: Embedding model cached ──────────────────────────────────────
  const modelDir = join(homedir(), '.codemem', 'models');
  const modelName = 'Xenova/all-MiniLM-L6-v2';
  // Xenova stores models as <org>/<name>/onnx/model_quantized.onnx
  const expectedOnnx = join(
    modelDir,
    modelName.replace('/', '/'),
    'onnx',
    'model_quantized.onnx',
  );

  if (!existsSync(modelDir)) {
    checks.push({
      label: 'Embedding model',
      status: 'warn',
      detail: 'Model cache directory not found — model will download on first use',
      fix: 'Run "codemem init" or "codemem start" to trigger download',
    });
  } else if (!existsSync(expectedOnnx)) {
    // Check if any onnx file exists in the model dir
    let hasAnyModel = false;
    try {
      const { readdirSync } = await import('fs');
      const entries = readdirSync(modelDir, { recursive: true }) as string[];
      hasAnyModel = entries.some(f => String(f).endsWith('.onnx'));
    } catch {}

    if (hasAnyModel) {
      checks.push({
        label: 'Embedding model',
        status: 'pass',
        detail: `Cached in ${modelDir}`,
      });
    } else {
      checks.push({
        label: 'Embedding model',
        status: 'warn',
        detail: 'Model not yet downloaded (~22 MB)',
        fix: 'Run "codemem start" — model downloads automatically on first run',
      });
    }
  } else {
    try {
      const stat = statSync(expectedOnnx);
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      checks.push({
        label: 'Embedding model',
        status: 'pass',
        detail: `${modelName} (${sizeMB} MB)`,
      });
    } catch {
      checks.push({ label: 'Embedding model', status: 'pass', detail: 'Cached' });
    }
  }

  // ── CHECK 4: Sidecar running ──────────────────────────────────────────────
  let port = resolveServerPort(undefined);
  try {
    const configStore = new ConfigStore(projectRoot);
    if (configStore.exists()) port = resolveServerPort(configStore.read().server.port);
  } catch {}

  try {
    const res = await fetch(`http://localhost:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) {
      checks.push({
        label: `Sidecar (port ${port})`,
        status: 'pass',
        detail: `Listening on localhost:${port}`,
      });
    } else {
      checks.push({
        label: `Sidecar (port ${port})`,
        status: 'fail',
        detail: `HTTP ${res.status}`,
        fix: 'Run "codemem start"',
      });
    }
  } catch {
    checks.push({
      label: `Sidecar (port ${port})`,
      status: 'fail',
      detail: 'Not reachable',
      fix: 'Run "codemem start" in another terminal',
    });
  }

  // ── CHECK 5: AI provider key configured ──────────────────────────────────
  const hasOpenAI = Boolean(process.env['OPENAI_API_KEY']);
  const hasAnthropic = Boolean(process.env['ANTHROPIC_API_KEY']);

  if (hasOpenAI || hasAnthropic) {
    const providers = [
      hasOpenAI ? 'OpenAI' : null,
      hasAnthropic ? 'Anthropic' : null,
    ].filter(Boolean).join(', ');
    checks.push({
      label: 'AI provider key',
      status: 'pass',
      detail: `Detected: ${providers}`,
    });
  } else {
    checks.push({
      label: 'AI provider key',
      status: 'warn',
      detail: 'No OPENAI_API_KEY or ANTHROPIC_API_KEY found in environment',
      fix: 'Required for "codemem ask" and "codemem chat" — search still works without it',
    });
  }

  // ── Render results ────────────────────────────────────────────────────────
  let allPassed = true;

  for (const check of checks) {
    const icon =
      check.status === 'pass' ? chalk.green('✓') :
      check.status === 'fail' ? chalk.red('✗') :
      check.status === 'warn' ? chalk.yellow('⚠') :
      chalk.gray('○');

    const label =
      check.status === 'pass' ? chalk.white(check.label) :
      check.status === 'fail' ? chalk.red(check.label) :
      chalk.yellow(check.label);

    const detail = check.detail ? chalk.gray(` — ${check.detail}`) : '';
    console.log(`  ${icon} ${label}${detail}`);

    if (check.fix) {
      console.log(`    ${chalk.dim('→')} ${chalk.dim(check.fix)}`);
    }

    if (check.status === 'fail') allPassed = false;
  }

  ui.blank();

  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;

  if (failCount === 0 && warnCount === 0) {
    console.log(chalk.green.bold('  ✓ All checks passed — CodeMem is healthy'));
  } else if (failCount === 0) {
    console.log(chalk.yellow(`  ⚠ ${warnCount} warning${warnCount !== 1 ? 's' : ''} — system functional`));
  } else {
    console.log(
      chalk.red(`  ✗ ${failCount} issue${failCount !== 1 ? 's' : ''} found`) +
      (warnCount > 0 ? chalk.yellow(` · ${warnCount} warning${warnCount !== 1 ? 's' : ''}`) : ''),
    );
  }

  ui.blank();

  // Exit with non-zero code if any hard failures
  if (!allPassed) process.exit(1);
}
