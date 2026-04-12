/**
 * Validator — runs the project's build and test scripts to check whether the
 * codebase compiles and passes tests.
 *
 * Used after applying patches to verify correctness, or as a pre-apply
 * baseline check.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  success: boolean;
  ran: string[];
  errors: string[];
  duration_ms: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the project's build/test scripts and return pass/fail results.
 *
 * Looks for scripts in package.json: build, typecheck, test (in that order).
 * If no package.json exists, returns success with nothing ran.
 */
export async function validateProject(projectRoot: string): Promise<ValidationResult> {
  const start = Date.now();
  const errors: string[] = [];
  const ran: string[] = [];

  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    return { success: true, ran, errors, duration_ms: 0 };
  }

  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return { success: true, ran, errors, duration_ms: 0 };
  }

  // Run scripts in priority order — stop at first failure
  const candidates: [string, string][] = [
    ['npm run build', 'build'],
    ['npm run typecheck', 'typecheck'],
    ['npm test', 'test'],
  ];

  for (const [cmd, scriptKey] of candidates) {
    if (!(scriptKey in scripts) && scriptKey !== 'test') continue;
    if (scriptKey === 'test' && !('test' in scripts)) continue;

    ran.push(cmd);
    try {
      await execAsync(cmd, {
        cwd: projectRoot,
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (e) {
      const ex = e as { stdout?: string; stderr?: string; message?: string };
      const output = [ex.stderr, ex.stdout, ex.message]
        .filter(Boolean)
        .join('\n')
        .trim();
      errors.push(`[${cmd}]\n${output.slice(0, 2000)}`);
      // Continue to collect all failures
    }
  }

  return {
    success: errors.length === 0,
    ran,
    errors,
    duration_ms: Date.now() - start,
  };
}
