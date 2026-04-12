/**
 * codemem apply [options]
 *
 * Loads the plan from .codemem/last-plan.json (saved by "codemem plan"),
 * generates file patches, shows a diff preview, prompts for confirmation,
 * and applies the patches if the user says yes.
 *
 * Optionally runs build/tests after applying with --validate.
 *
 * Flags:
 *   --provider   openai | anthropic (auto-detected from env vars)
 *   --model      model name override
 *   --top        context chunks to retrieve (default 8)
 *   --validate   run build/tests after applying patches
 */

import { resolve, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import * as readline from 'readline';
import chalk from 'chalk';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import { Plan } from '../../core/agent/planner.js';
import { generatePatch } from '../../core/agent/patch-generator.js';
import { previewPatches, applyPatches } from '../../core/agent/executor.js';
import { validateProject } from '../../core/agent/validator.js';
import { resolveAIConfig } from '../../utils/ai-config.js';
import { resolveServerPort } from '../../utils/runtime.js';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface ApplyOptions {
  provider?: string;
  model?: string;
  top?: number;
  validate?: boolean;
}

export async function runApply(options: ApplyOptions): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const configStore = new ConfigStore(projectRoot);

  if (!configStore.exists()) {
    ui.fail('No .codemem/ found. Run "codemem init" first.');
    process.exit(1);
  }

  // Load saved plan
  const planPath = join(projectRoot, '.codemem', 'last-plan.json');
  if (!existsSync(planPath)) {
    ui.fail('No plan found. Run "codemem plan <query>" first.');
    process.exit(1);
  }

  let plan: Plan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Plan;
  } catch {
    ui.fail('Could not parse .codemem/last-plan.json. Re-run "codemem plan".');
    process.exit(1);
  }

  const config = configStore.read();
  const port = resolveServerPort(config.server.port);

  const aiConfig = resolveAIConfig({ provider: options.provider, model: options.model });
  if (!aiConfig) {
    ui.fail('No AI API key found.');
    ui.blank();
    ui.info('Set OPENAI_API_KEY or ANTHROPIC_API_KEY, then retry.');
    process.exit(1);
  }

  const topK = options.top ?? 8;

  // ── Step 1: Show plan summary ──────────────────────────────────────────────
  ui.blank();
  console.log(chalk.bold('  Plan'));
  console.log('  ' + chalk.gray('─'.repeat(50)));
  console.log(`  ${chalk.dim('Query:')} ${plan.query}`);
  console.log(`  ${chalk.dim('Summary:')} ${plan.summary}`);
  console.log(`  ${chalk.dim('Steps:')} ${plan.steps.length}`);
  for (const s of plan.steps) {
    console.log(`    ${chalk.yellow(`[${s.action}]`)} ${s.file}`);
    console.log(`    ${chalk.dim(s.description)}`);
  }
  ui.blank();

  // ── Step 2: Generate patches ───────────────────────────────────────────────
  const spinner = ui.spinner('Fetching context...').start();

  let context: string;
  try {
    context = await fetchContext(port, plan.query, topK);
  } catch (e) {
    spinner.fail(`Failed to reach sidecar: ${String(e)}`);
    handleConnectionError(e);
    process.exit(1);
  }

  spinner.text = chalk.dim(`Generating patches with ${aiConfig.provider}...`);

  let patchSet: Awaited<ReturnType<typeof generatePatch>>;
  try {
    patchSet = await generatePatch(plan, context, aiConfig, projectRoot);
    spinner.stop();
  } catch (e) {
    spinner.fail(`Patch generation failed: ${String(e)}`);
    process.exit(1);
  }

  // ── Step 3: Show diff preview ──────────────────────────────────────────────
  ui.blank();
  console.log(chalk.bold('  Diff Preview'));
  console.log('  ' + chalk.gray('─'.repeat(50)));
  const preview = previewPatches(patchSet.patches, projectRoot);
  for (const line of preview.split('\n')) {
    if (line.startsWith('===')) {
      console.log('  ' + chalk.cyan(line));
    } else if (line.trimStart().startsWith('- ')) {
      console.log('  ' + chalk.red(line));
    } else if (line.trimStart().startsWith('+ ')) {
      console.log('  ' + chalk.green(line));
    } else {
      console.log('  ' + chalk.dim(line));
    }
  }
  ui.blank();
  console.log(`  ${patchSet.patches.length} file(s) will be modified. Backups go to .codemem/backups/`);
  ui.blank();

  // ── Step 4: Prompt for approval ────────────────────────────────────────────
  const confirmed = await promptConfirm('  Apply these changes? [y/N]: ');
  if (!confirmed) {
    ui.info('Aborted — no files were changed.');
    process.exit(0);
  }

  // ── Step 5: Apply ──────────────────────────────────────────────────────────
  try {
    const result = await applyPatches(patchSet.patches, projectRoot, true);
    ui.blank();
    console.log(chalk.green(`  Applied ${result.applied.length} file(s):`));
    for (const f of result.applied) {
      console.log(`    ${chalk.green('✓')} ${f}`);
    }
    if (result.backups.length > 0) {
      ui.info(chalk.dim(`  Backups saved to ${result.backupDir}`));
    }
    ui.blank();
  } catch (e) {
    ui.fail(`Apply failed: ${String(e)}`);
    process.exit(1);
  }

  // ── Step 6 (optional): Validate ────────────────────────────────────────────
  if (options.validate) {
    const vSpinner = ui.spinner('Running build/tests...').start();
    try {
      const validation = await validateProject(projectRoot);
      vSpinner.stop();
      ui.blank();
      if (validation.success) {
        console.log(chalk.green(`  Validation passed (${validation.ran.join(', ')})`));
      } else {
        console.log(chalk.red('  Validation failed:'));
        for (const e of validation.errors) {
          console.log(chalk.red(`  ${e.slice(0, 400)}`));
        }
        ui.warn('Patches were applied but validation failed. Check the errors above.');
        ui.info(`To undo, restore files from .codemem/backups/ or use git checkout.`);
      }
      ui.blank();
    } catch (e) {
      vSpinner.fail(`Validation error: ${String(e)}`);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchContext(port: number, query: string, topK: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/v1/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, options: { top_k: topK } }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CodeMem query failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { context: { assembled_text: string } };
  return data.context.assembled_text;
}

function handleConnectionError(err: unknown): void {
  const msg = String(err);
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    ui.warn('Cannot reach CodeMem sidecar.');
    ui.info('Run "codemem start" in another terminal, then retry.');
  }
}

async function promptConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  return new Promise((resolve) => {
    process.stdout.write(message);
    rl.once('line', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
    rl.once('close', () => resolve(false));
  });
}
