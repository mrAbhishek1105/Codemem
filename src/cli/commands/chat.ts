/**
 * codemem chat
 *
 * Interactive multi-turn AI conversation with persistent memory.
 *
 * Each turn:
 *   1. User types a message
 *   2. CodeMem searches the codebase for relevant context
 *   3. Previous messages + new context + user message → AI
 *   4. Response printed (optionally streamed token-by-token)
 *   5. Exchange saved to .codemem/chat.json
 *
 * Commands inside the chat session:
 *   /clear      — clear conversation history (start fresh)
 *   /history    — print conversation history
 *   /save       — manually save history
 *   /exit, /quit, Ctrl+C — exit
 */

import { createInterface } from 'readline';
import { resolve, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import chalk from 'chalk';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import {
  callAI,
  streamAI,
  AIConfig,
  AIMessage,
} from '../../core/ai-agent.js';
import { resolveAIConfig } from '../../utils/ai-config.js';
import { resolveServerPort } from '../../utils/runtime.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  ts: string;         // ISO timestamp
  context_tokens?: number;
}

interface ChatHistory {
  version: 1;
  created: string;
  updated: string;
  project: string;
  entries: ChatEntry[];
}

export interface ChatOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  stream?: boolean;
  top?: number;
  noContext?: boolean;  // skip codebase search (plain chat)
  maxHistory?: number;  // max past messages to include (default 10)
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runChat(options: ChatOptions): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const configStore = new ConfigStore(projectRoot);

  if (!configStore.exists()) {
    ui.fail('No .codemem/ found. Run "codemem init" first.');
    process.exit(1);
  }

  const config = configStore.read();
  const port = resolveServerPort(config.server.port);
  const historyPath = join(projectRoot, '.codemem', 'chat.json');

  const aiConfig = resolveAIConfig(options);
  if (!aiConfig) {
    ui.fail('No AI API key found.');
    ui.blank();
    ui.info('Set OPENAI_API_KEY or ANTHROPIC_API_KEY, then retry.');
    ui.info('For OpenAI-compatible hosted APIs, you can also set OPENAI_BASE_URL.');
    process.exit(1);
  }

  const projectName = config.project?.name ?? 'project';
  const history = loadHistory(historyPath, projectName);
  const useStream = options.stream ?? false;
  const topK = options.top ?? 6;
  const maxHistory = options.maxHistory ?? 10;
  const noContext = options.noContext ?? false;

  // ── Banner ─────────────────────────────────────────────────────────────────
  ui.blank();
  console.log(
    chalk.bold.cyan('  CodeMem Chat') +
    chalk.gray(` · ${aiConfig.provider} · ${aiConfig.model ?? 'default'}`) +
    (useStream ? chalk.yellow(' ⚡') : ''),
  );
  console.log(chalk.gray('  ─────────────────────────────────────────────────'));
  console.log(chalk.gray('  Commands: /clear  /history  /save  /exit'));
  if (history.entries.length > 0) {
    const turns = Math.floor(history.entries.length / 2);
    console.log(chalk.gray(`  Resuming conversation (${turns} previous turn${turns !== 1 ? 's' : ''})`));
  }
  ui.blank();

  // ── Readline REPL ──────────────────────────────────────────────────────────
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: chalk.cyan('  you › '),
  });

  const shutdown = (signal?: string) => {
    if (signal) console.log('');
    saveHistory(historyPath, history);
    ui.blank();
    ui.success('Chat history saved. Goodbye!');
    rl.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Slash commands ───────────────────────────────────────────────────────
    if (input.startsWith('/')) {
      const cmd = input.toLowerCase();

      if (cmd === '/exit' || cmd === '/quit' || cmd === '/q') {
        shutdown();
        return;
      }

      if (cmd === '/clear') {
        history.entries = [];
        history.updated = new Date().toISOString();
        saveHistory(historyPath, history);
        console.log(chalk.gray('  ○ Conversation cleared'));
        rl.prompt();
        return;
      }

      if (cmd === '/history') {
        printHistory(history);
        rl.prompt();
        return;
      }

      if (cmd === '/save') {
        saveHistory(historyPath, history);
        ui.success('History saved');
        rl.prompt();
        return;
      }

      console.log(chalk.yellow(`  ⚠ Unknown command: ${input}`));
      console.log(chalk.gray('  Available: /clear  /history  /save  /exit'));
      rl.prompt();
      return;
    }

    // ── AI turn ──────────────────────────────────────────────────────────────
    rl.pause();

    try {
      await handleTurn(
        input, aiConfig, port, topK,
        history, useStream, noContext, maxHistory,
      );
      history.updated = new Date().toISOString();
      saveHistory(historyPath, history);
    } catch (e) {
      console.log(chalk.red(`\n  ✗ Error: ${String(e)}`));
      handleConnectionError(e);
    }

    ui.blank();
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    saveHistory(historyPath, history);
    process.exit(0);
  });
}

// ─── Single conversation turn ─────────────────────────────────────────────────

async function handleTurn(
  userInput: string,
  aiConfig: AIConfig,
  port: number,
  topK: number,
  history: ChatHistory,
  useStream: boolean,
  noContext: boolean,
  maxHistory: number,
): Promise<void> {
  // 1. Retrieve codebase context
  let contextText = '';
  let contextTokens = 0;

  if (!noContext) {
    try {
      process.stdout.write(chalk.dim('  searching...'));
      const ctx = await queryCodeMem(port, userInput, topK);
      contextText = ctx.assembled_text;
      contextTokens = ctx.token_count;
      // Clear "searching..." line
      process.stdout.write('\r' + ' '.repeat(20) + '\r');
    } catch {
      // Server not running — fall back to plain chat
      process.stdout.write('\r' + ' '.repeat(20) + '\r');
    }
  }

  // 2. Build messages
  //    System + past history (capped) + optional context + user message
  const systemContent =
    `You are a senior software engineer helping with the "${history.project}" project. ` +
    `Be concise, precise, and always reference specific files and functions from the context provided.`;

  const messages: AIMessage[] = [{ role: 'system', content: systemContent }];

  // Include capped conversation history
  const recent = history.entries.slice(-maxHistory);
  for (const entry of recent) {
    messages.push({ role: entry.role, content: entry.content });
  }

  // Inject retrieved context into the user message
  const userContent = contextText
    ? `[Codebase Context]\n${contextText}\n\n[Question]\n${userInput}`
    : userInput;

  messages.push({ role: 'user', content: userContent });

  // 3. Print AI label
  console.log(chalk.cyan('  ai  › '));

  // 4. Get response
  let fullResponse = '';

  if (useStream) {
    for await (const token of streamAI(aiConfig, messages)) {
      process.stdout.write(token);
      fullResponse += token;
    }
    process.stdout.write('\n');
  } else {
    const res = await callAI(aiConfig, messages);
    fullResponse = res.content;

    // Format for readability: indent each line
    const formatted = fullResponse
      .split('\n')
      .map(l => '  ' + l)
      .join('\n');
    console.log(formatted);
  }

  // 5. Save to history
  history.entries.push(
    { role: 'user', content: userInput, ts: new Date().toISOString() },
    {
      role: 'assistant',
      content: fullResponse,
      ts: new Date().toISOString(),
      context_tokens: contextTokens || undefined,
    },
  );

  // 6. Footer stats
  if (contextTokens > 0) {
    process.stdout.write(chalk.dim(`\n  context: ${contextTokens} tokens · `));
  } else {
    process.stdout.write(chalk.dim('\n  '));
  }
  process.stdout.write(
    chalk.dim(`${aiConfig.provider} ${aiConfig.model ?? 'default'}`) + '\n',
  );
}

// ─── History helpers ──────────────────────────────────────────────────────────

function loadHistory(path: string, project: string): ChatHistory {
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as ChatHistory;
    } catch {/* corrupt — start fresh */}
  }
  return {
    version: 1,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    project,
    entries: [],
  };
}

function saveHistory(path: string, history: ChatHistory): void {
  try {
    writeFileSync(path, JSON.stringify(history, null, 2), 'utf-8');
  } catch {/* non-fatal */}
}

function printHistory(history: ChatHistory): void {
  if (history.entries.length === 0) {
    console.log(chalk.gray('  (no conversation history)'));
    return;
  }
  ui.blank();
  console.log(chalk.bold('  Conversation history:'));
  console.log(chalk.gray('  ' + '─'.repeat(44)));
  for (const entry of history.entries) {
    const label =
      entry.role === 'user'
        ? chalk.cyan('  you  ›')
        : chalk.green('  ai   ›');
    const preview = entry.content.slice(0, 120).replace(/\n/g, ' ');
    const ts = chalk.gray(new Date(entry.ts).toLocaleTimeString());
    console.log(`${label} ${preview}${entry.content.length > 120 ? '…' : ''} ${ts}`);
  }
  ui.blank();
}

// ─── CodeMem helper ───────────────────────────────────────────────────────────

async function queryCodeMem(
  port: number,
  query: string,
  topK: number,
): Promise<{ assembled_text: string; token_count: number }> {
  const res = await fetch(`http://localhost:${port}/api/v1/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, options: { top_k: topK } }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`CodeMem ${res.status}`);
  const data = await res.json() as {
    context: { assembled_text: string; token_count: number };
  };
  return { assembled_text: data.context.assembled_text, token_count: data.context.token_count };
}

// ─── AI config resolver ───────────────────────────────────────────────────────

function handleConnectionError(err: unknown): void {
  const msg = String(err);
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    console.log(chalk.gray('  (CodeMem sidecar not running — responses without code context)'));
  }
}
