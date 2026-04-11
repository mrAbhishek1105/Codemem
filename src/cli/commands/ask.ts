/**
 * codemem ask "<query>" [options]
 *
 * Modes:
 *   --mode direct   (one-shot): retrieve context once → send to AI → print answer
 *   --mode agent    (default) : AI loops with search_codebase + run_terminal tools
 *
 * Flags:
 *   --stream        stream tokens to stdout in real-time (works in both modes)
 *   --provider      openai | anthropic  (auto-detected from env vars)
 *   --model         model name override
 *   --top           chunks per search call
 *   --no-terminal   disable run_terminal tool in agent mode
 */

import { resolve } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import {
  callAI,
  streamAI,
  runAgentLoop,
  buildSystemPrompt,
  SEARCH_CODEBASE_TOOL,
  RUN_TERMINAL_TOOL,
  AIConfig,
  AIMessage,
} from '../../core/ai-agent.js';
import { resolveAIConfig } from '../../utils/ai-config.js';

const execAsync = promisify(exec);

// ─── Public interface ─────────────────────────────────────────────────────────

export interface AskOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  mode?: string;        // 'agent' (default) | 'direct'
  top?: number;
  noTerminal?: boolean;
  stream?: boolean;
}

export async function runAsk(query: string, options: AskOptions): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const configStore = new ConfigStore(projectRoot);

  if (!configStore.exists()) {
    ui.fail('No .codemem/ found. Run "codemem init" first.');
    process.exit(1);
  }

  const config = configStore.read();
  const port = config.server.port;

  const aiConfig = resolveAIConfig(options);
  if (!aiConfig) {
    ui.fail('No AI API key found.');
    ui.blank();
    ui.info('Set one of these environment variables:');
    ui.info('  OPENAI_API_KEY=sk-...');
    ui.info('  ANTHROPIC_API_KEY=sk-ant-...');
    ui.info('Optional for OpenAI-compatible hosted APIs:');
    ui.info('  OPENAI_BASE_URL=https://your-provider.example/v1');
    ui.blank();
    ui.info('Then optionally pin the provider with --provider openai|anthropic');
    process.exit(1);
  }

  const mode = (options.mode ?? 'agent').toLowerCase();
  const stream = options.stream ?? false;

  if (mode === 'direct') {
    await runDirectMode(query, aiConfig, port, options.top ?? 6, stream);
  } else {
    await runAgentMode(query, aiConfig, port, config, options.noTerminal ?? false, stream);
  }
}

// ─── Mode A: direct ───────────────────────────────────────────────────────────

async function runDirectMode(
  query: string,
  aiConfig: AIConfig,
  port: number,
  topK: number,
  stream: boolean,
): Promise<void> {
  const spinner = ui.spinner('Searching codebase...').start();

  try {
    const context = await queryCodeMem(port, query, topK);
    const prompt = buildDirectPrompt(query, context.assembled_text);
    const messages: AIMessage[] = [{ role: 'user', content: prompt }];

    spinner.stop();
    ui.blank();
    printResponseHeader(aiConfig, 'direct', stream);

    if (stream) {
      await streamResponse(aiConfig, messages);
    } else {
      const response = await callAI(aiConfig, messages);
      console.log(response.content);
    }

    ui.blank();
    ui.info(
      chalk.dim(
        `Context: ${context.token_count} tokens · ${context.query_time_ms}ms · ` +
        `${aiConfig.provider} ${aiConfig.model ?? 'default'} · direct`,
      ),
    );
    ui.blank();
  } catch (e) {
    spinner.fail(`Failed: ${String(e)}`);
    handleConnectionError(e);
    process.exit(1);
  }
}

// ─── Mode B: agent loop ───────────────────────────────────────────────────────

async function runAgentMode(
  query: string,
  aiConfig: AIConfig,
  port: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  noTerminal: boolean,
  stream: boolean,
): Promise<void> {
  const spinner = ui.spinner(chalk.dim(`agent · ${aiConfig.provider} · searching...`)).start();

  const projectSummary: string =
    typeof config.project?.name === 'string' ? config.project.name : 'this project';

  const tools = noTerminal
    ? [SEARCH_CODEBASE_TOOL]
    : [SEARCH_CODEBASE_TOOL, RUN_TERMINAL_TOOL];

  let searchCount = 0;
  let terminalCount = 0;

  try {
    // Collect the final answer (non-streaming) from agent loop —
    // streaming only applies to the final printout
    const answer = await runAgentLoop(
      aiConfig,
      query,
      tools,
      async (toolName, args) => {
        if (toolName === 'search_codebase') {
          searchCount++;
          const q = String(args['query'] ?? '');
          const k = Math.min(Number(args['top_k'] ?? 6), 12);
          spinner.text = chalk.dim(`[search ${searchCount}] "${q.slice(0, 55)}"...`);
          const result = await queryCodeMem(port, q, k);
          return result.assembled_text;
        }

        if (toolName === 'run_terminal') {
          terminalCount++;
          const cmd = String(args['command'] ?? '');
          spinner.text = chalk.dim(`[cmd ${terminalCount}] ${cmd.slice(0, 60)}`);
          return await runCommand(cmd);
        }

        return `Unknown tool: ${toolName}`;
      },
      buildSystemPrompt(projectSummary),
    );

    spinner.stop();
    ui.blank();
    printResponseHeader(
      aiConfig,
      `agent · ${searchCount} search${searchCount !== 1 ? 'es' : ''}` +
        (terminalCount > 0 ? ` · ${terminalCount} cmd${terminalCount !== 1 ? 's' : ''}` : ''),
      stream,
    );

    if (stream) {
      // Stream the final answer token-by-token for a polished UX
      // We already have the full text, so simulate streaming with a delay
      await printStreamed(answer);
    } else {
      console.log(answer);
    }

    ui.blank();
    ui.info(
      chalk.dim(
        `${aiConfig.provider} ${aiConfig.model ?? 'default'} · ` +
        `tools: search_codebase${noTerminal ? '' : ' + run_terminal'}`,
      ),
    );
    ui.blank();
  } catch (e) {
    spinner.fail(`Agent failed: ${String(e)}`);
    handleConnectionError(e);
    process.exit(1);
  }
}

// ─── Streaming output helpers ─────────────────────────────────────────────────

/** Stream from AI API — tokens arrive from the provider in real-time */
async function streamResponse(aiConfig: AIConfig, messages: AIMessage[]): Promise<void> {
  for await (const token of streamAI(aiConfig, messages)) {
    process.stdout.write(token);
  }
  process.stdout.write('\n');
}

/** Print already-fetched text character-by-character at ~120 chars/sec */
async function printStreamed(text: string): Promise<void> {
  // 8ms per char ≈ fast typewriter feel without being annoying
  const DELAY = 8;
  for (const char of text) {
    process.stdout.write(char);
    if (char !== ' ' && char !== '\n') {
      await new Promise(r => setTimeout(r, DELAY));
    }
  }
  process.stdout.write('\n');
}

function printResponseHeader(aiConfig: AIConfig, modeLabel: string, stream: boolean): void {
  const provider = chalk.cyan(aiConfig.provider);
  const model = chalk.gray(aiConfig.model ?? 'default');
  const mode = chalk.gray(modeLabel);
  const streamTag = stream ? chalk.yellow(' ⚡ stream') : '';
  console.log(`  ${chalk.bold('AI Response')}  ${provider} · ${model} · ${mode}${streamTag}`);
  console.log('  ' + chalk.gray('─'.repeat(50)));
  ui.blank();
}

// ─── CodeMem HTTP helper ──────────────────────────────────────────────────────

interface CodeMemContext {
  assembled_text: string;
  token_count: number;
  query_time_ms: number;
}

async function queryCodeMem(port: number, query: string, topK: number): Promise<CodeMemContext> {
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

  const data = await res.json() as {
    context: { assembled_text: string; token_count: number };
    stats: { query_time_ms: number };
  };

  return {
    assembled_text: data.context.assembled_text,
    token_count: data.context.token_count,
    query_time_ms: data.stats.query_time_ms,
  };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildDirectPrompt(userQuery: string, assembledContext: string): string {
  return `[Project Context]
${assembledContext}

[User Request]
${userQuery}

Task: Based on the project context above, provide a detailed, actionable answer.
Reference specific file paths and function names. Show complete code for any changes.`;
}

// ─── Terminal command executor ────────────────────────────────────────────────

async function runCommand(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30_000,
      maxBuffer: 512 * 1024,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    });
    const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
    return out.slice(0, 8000) || '(no output)';
  } catch (e) {
    const ex = e as { stdout?: string; stderr?: string; message?: string };
    const output = [ex.stdout, ex.stderr, ex.message].filter(Boolean).join('\n').trim();
    return `Error: ${output.slice(0, 4000)}`;
  }
}

// ─── AI config resolver ───────────────────────────────────────────────────────

// ─── Connection error helper ──────────────────────────────────────────────────

function handleConnectionError(err: unknown): void {
  const msg = String(err);
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    ui.warn('Cannot reach CodeMem sidecar.');
    ui.info('Run "codemem start" in another terminal, then retry.');
  }
}
