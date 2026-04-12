/**
 * codemem plan "<query>" [options]
 *
 * Fetches codebase context from the sidecar, calls the AI planner, and prints
 * a step-by-step implementation plan. Saves the plan to .codemem/last-plan.json
 * so that "codemem apply" can pick it up.
 *
 * Flags:
 *   --provider   openai | anthropic (auto-detected from env vars)
 *   --model      model name override
 *   --top        context chunks to retrieve (default 8)
 */

import { resolve, join } from 'path';
import { writeFileSync } from 'fs';
import chalk from 'chalk';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import { generatePlan, formatPlan } from '../../core/agent/planner.js';
import { resolveAIConfig } from '../../utils/ai-config.js';
import { resolveServerPort } from '../../utils/runtime.js';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface PlanOptions {
  provider?: string;
  model?: string;
  top?: number;
}

export async function runPlan(query: string, options: PlanOptions): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const configStore = new ConfigStore(projectRoot);

  if (!configStore.exists()) {
    ui.fail('No .codemem/ found. Run "codemem init" first.');
    process.exit(1);
  }

  const config = configStore.read();
  const port = resolveServerPort(config.server.port);

  const aiConfig = resolveAIConfig({ provider: options.provider, model: options.model });
  if (!aiConfig) {
    ui.fail('No AI API key found.');
    ui.blank();
    ui.info('Set one of these environment variables:');
    ui.info('  OPENAI_API_KEY=sk-...');
    ui.info('  ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  const topK = options.top ?? 8;
  const spinner = ui.spinner('Retrieving context...').start();

  try {
    // Fetch context from sidecar
    const context = await fetchContext(port, query, topK);
    spinner.text = chalk.dim(`Planning with ${aiConfig.provider}...`);

    // Generate plan
    const plan = await generatePlan(query, context, aiConfig);

    spinner.stop();

    // Display plan
    ui.blank();
    console.log(chalk.bold('  Implementation Plan'));
    console.log('  ' + chalk.gray('─'.repeat(50)));
    ui.blank();

    const formatted = formatPlan(plan);
    for (const line of formatted.split('\n')) {
      console.log('  ' + line);
    }

    ui.blank();
    ui.info(chalk.dim(`${aiConfig.provider} ${aiConfig.model ?? 'default'} · ${plan.steps.length} step(s)`));
    ui.blank();

    // Save plan for "codemem apply"
    const planPath = join(projectRoot, '.codemem', 'last-plan.json');
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    ui.info(chalk.dim(`Plan saved to .codemem/last-plan.json — run "codemem apply" to generate patches.`));
    ui.blank();

  } catch (e) {
    spinner.fail(`Failed: ${String(e)}`);
    handleConnectionError(e);
    process.exit(1);
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
