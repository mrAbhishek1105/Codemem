/**
 * codemem ask "<query>" [options]
 *
 * Two modes:
 *
 * --mode direct (Mode A):
 *   1. Query CodeMem for context
 *   2. Build structured prompt with context + user query
 *   3. Send to AI once → print response
 *
 * --mode agent (Mode B, default):
 *   AI receives search_codebase + run_terminal as tools.
 *   It autonomously searches the codebase, reads terminal output if needed,
 *   then produces a final grounded answer.
 */

import { resolve } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import {
  callAI,
  runAgentLoop,
  buildSystemPrompt,
  SEARCH_CODEBASE_TOOL,
  RUN_TERMINAL_TOOL,
  AIConfig,
  AIProviderName,
} from '../../core/ai-agent.js';

const execAsync = promisify(exec);

// ─── Public interface ─────────────────────────────────────────────────────────

export interface AskOptions {
  provider?: string;
  model?: string;
  mode?: string;       // 'agent' (default) | 'direct'
  top?: number;
  noTerminal?: boolean; // disable run_terminal tool
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
    ui.blank();
    ui.info('Then specify provider with --provider openai|anthropic');
    process.exit(1);
  }

  const mode = (options.mode ?? 'agent').toLowerCase();

  if (mode === 'direct') {
    await runDirectMode(query, aiConfig, port, options.top ?? 6);
  } else {
    await runAgentMode(query, aiConfig, port, config, options.noTerminal ?? false);
  }
}

// ─── Mode A: direct (retrieve then ask) ──────────────────────────────────────

async function runDirectMode(
  query: string,
  aiConfig: AIConfig,
  port: number,
  topK: number,
): Promise<void> {
  const spinner = ui.spinner('Searching codebase...').start();

  try {
    // 1. Retrieve context from CodeMem
    spinner.text = 'Searching codebase...';
    const context = await queryCodeMem(port, query, topK);

    // 2. Build prompt
    const prompt = buildDirectPrompt(query, context.assembled_text);

    spinner.text = `Asking ${aiConfig.provider} (${aiConfig.model ?? 'default'})...`;

    // 3. Send to AI
    const response = await callAI(aiConfig, [{ role: 'user', content: prompt }]);

    spinner.stop();

    // 4. Output
    ui.blank();
    ui.section(`AI Response  [${aiConfig.provider} · ${aiConfig.model ?? 'default'}]`);
    ui.blank();
    console.log(response.content);
    ui.blank();
    ui.info(
      `Context: ${context.token_count} tokens · Query: ${context.query_time_ms}ms · Mode: direct`,
    );
    ui.blank();
  } catch (err) {
    spinner.fail(`Failed: ${String(err)}`);
    handleConnectionError(err);
    process.exit(1);
  }
}

// ─── Mode B: agent loop (AI uses tools) ──────────────────────────────────────

async function runAgentMode(
  query: string,
  aiConfig: AIConfig,
  port: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  noTerminal: boolean,
): Promise<void> {
  const spinner = ui.spinner(`Starting agent (${aiConfig.provider})...`).start();

  const projectSummary: string =
    typeof config.project?.name === 'string' ? config.project.name : 'CodeMem project';

  const systemPrompt = buildSystemPrompt(projectSummary);
  const tools = noTerminal
    ? [SEARCH_CODEBASE_TOOL]
    : [SEARCH_CODEBASE_TOOL, RUN_TERMINAL_TOOL];

  let searchCount = 0;
  let terminalCount = 0;

  try {
    const answer = await runAgentLoop(
      aiConfig,
      query,
      tools,

      // Tool executor
      async (toolName, args) => {
        if (toolName === 'search_codebase') {
          searchCount++;
          const q = String(args['query'] ?? '');
          const k = Math.min(Number(args['top_k'] ?? 6), 12);
          spinner.text = `[search ${searchCount}] "${q.slice(0, 60)}"...`;

          const result = await queryCodeMem(port, q, k);
          return result.assembled_text;
        }

        if (toolName === 'run_terminal') {
          terminalCount++;
          const cmd = String(args['command'] ?? '');
          spinner.text = `[terminal ${terminalCount}] ${cmd.slice(0, 60)}`;

          return await runCommand(cmd);
        }

        return `Unknown tool: ${toolName}`;
      },

      systemPrompt,
    );

    spinner.stop();

    ui.blank();
    ui.section(
      `AI Response  [${aiConfig.provider} · ${aiConfig.model ?? 'default'}] ` +
      `· ${searchCount} search${searchCount !== 1 ? 'es' : ''}` +
      (terminalCount > 0 ? ` · ${terminalCount} cmd${terminalCount !== 1 ? 's' : ''}` : ''),
    );
    ui.blank();
    console.log(answer);
    ui.blank();
    ui.info('Mode: agent  |  Tools: search_codebase' + (noTerminal ? '' : ' + run_terminal'));
    ui.blank();
  } catch (err) {
    spinner.fail(`Agent failed: ${String(err)}`);
    handleConnectionError(err);
    process.exit(1);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function buildDirectPrompt(userQuery: string, assembledContext: string): string {
  return `[Project Context]
${assembledContext}

[User Request]
${userQuery}

Task:
Based on the project context above, provide a detailed answer with implementation steps and specific code changes. Reference exact file paths and function names from the context.`;
}

async function runCommand(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30_000,
      maxBuffer: 512 * 1024, // 512 KB
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    });
    const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
    return out.slice(0, 8000) || '(no output)';
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
    return `Error: ${output.slice(0, 4000)}`;
  }
}

function resolveAIConfig(options: AskOptions): AIConfig | null {
  // Determine provider
  let provider = options.provider as AIProviderName | undefined;
  let apiKey = '';

  if (!provider) {
    if (process.env['OPENAI_API_KEY']) {
      provider = 'openai';
      apiKey = process.env['OPENAI_API_KEY'];
    } else if (process.env['ANTHROPIC_API_KEY']) {
      provider = 'anthropic';
      apiKey = process.env['ANTHROPIC_API_KEY'];
    } else {
      return null;
    }
  } else {
    apiKey =
      provider === 'openai'
        ? (process.env['OPENAI_API_KEY'] ?? '')
        : (process.env['ANTHROPIC_API_KEY'] ?? '');
    if (!apiKey) return null;
  }

  return {
    provider,
    apiKey,
    model: options.model,
    maxTokens: 4096,
  };
}

function handleConnectionError(err: unknown): void {
  const msg = String(err);
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    ui.warn('Cannot reach CodeMem sidecar on localhost.');
    ui.info('Run "codemem start" in another terminal, then retry.');
  }
}
