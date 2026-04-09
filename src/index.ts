import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from package.json
let VERSION = '0.25.0';
try {
  const pkgPath = join(__dirname, '..', 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    VERSION = pkg.version;
  }
} catch {}

const program = new Command();

program
  .name('codemem')
  .description('AI-agnostic local memory layer for codebases')
  .version(VERSION);

// ── codemem init ──────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize CodeMem and index the current project')
  .option('-d, --debug', 'Enable debug logging')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (opts) => {
    const { runInit } = await import('./cli/commands/init.js');
    await runInit(opts).catch(handleError);
  });

// ── codemem start ─────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the CodeMem sidecar server')
  .option('-d, --debug', 'Enable debug logging')
  .option('-p, --port <port>', 'Server port', (v) => parseInt(v, 10))
  .action(async (opts) => {
    const { runStart } = await import('./cli/commands/start.js');
    await runStart(opts).catch(handleError);
  });

// ── codemem stop ──────────────────────────────────────────────────────────────
program
  .command('stop')
  .description('Stop the running CodeMem sidecar')
  .action(async () => {
    const { runStop } = await import('./cli/commands/stop.js');
    await runStop().catch(handleError);
  });

// ── codemem status ────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show CodeMem status and index health')
  .action(async () => {
    const { runStatus } = await import('./cli/commands/status.js');
    await runStatus().catch(handleError);
  });

// ── codemem stats ─────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show token savings statistics')
  .action(async () => {
    const { runStats } = await import('./cli/commands/stats.js');
    await runStats().catch(handleError);
  });

// ── codemem search ────────────────────────────────────────────────────────────
program
  .command('search <query>')
  .description('Search the indexed codebase')
  .option('-n, --top <n>', 'Number of results', '5')
  .action(async (query, opts) => {
    const { runSearch } = await import('./cli/commands/search.js');
    await runSearch(query, { top: parseInt(opts.top, 10) }).catch(handleError);
  });

// ── codemem reindex ───────────────────────────────────────────────────────────
program
  .command('reindex')
  .description('Re-index the codebase (incremental by default)')
  .option('--full', 'Force full re-index')
  .option('-d, --debug', 'Enable debug logging')
  .action(async (opts) => {
    const { runReindex } = await import('./cli/commands/reindex.js');
    await runReindex(opts).catch(handleError);
  });

// ── codemem ask ───────────────────────────────────────────────────────────────
program
  .command('ask <query>')
  .description('Ask an AI about your codebase — context retrieved automatically')
  .option('-p, --provider <name>', 'AI provider: openai | anthropic  (auto from env)')
  .option('-m, --model <name>', 'Model override  (e.g. gpt-4o, claude-opus-4-5)')
  .option('--mode <mode>', 'agent (default, tool-loop) | direct (one-shot)', 'agent')
  .option('-n, --top <n>', 'Chunks retrieved per search call', '6')
  .option('-s, --stream', 'Stream response tokens in real-time')
  .option('--no-terminal', 'Disable run_terminal tool in agent mode')
  .action(async (query, opts) => {
    const { runAsk } = await import('./cli/commands/ask.js');
    await runAsk(query, {
      provider: opts.provider as string | undefined,
      model: opts.model as string | undefined,
      mode: opts.mode as string,
      top: parseInt(String(opts.top ?? '6'), 10),
      stream: Boolean(opts.stream),
      noTerminal: opts.terminal === false,
    }).catch(handleError);
  });

// ── codemem chat ──────────────────────────────────────────────────────────────
program
  .command('chat')
  .description('Interactive multi-turn AI chat with codebase memory')
  .option('-p, --provider <name>', 'AI provider: openai | anthropic  (auto from env)')
  .option('-m, --model <name>', 'Model override')
  .option('-n, --top <n>', 'Context chunks per turn', '6')
  .option('-s, --stream', 'Stream response tokens in real-time')
  .option('--no-context', 'Disable codebase search (plain chat)')
  .option('--max-history <n>', 'Max past messages to include per turn', '10')
  .action(async (opts) => {
    const { runChat } = await import('./cli/commands/chat.js');
    await runChat({
      provider: opts.provider as string | undefined,
      model: opts.model as string | undefined,
      top: parseInt(String(opts.top ?? '6'), 10),
      stream: Boolean(opts.stream),
      noContext: opts.context === false,
      maxHistory: parseInt(String(opts.maxHistory ?? '10'), 10),
    }).catch(handleError);
  });

// ── codemem mcp ───────────────────────────────────────────────────────────────
program
  .command('mcp')
  .description('Start MCP server (stdin/stdout JSON-RPC for Claude Desktop / Cursor)')
  .action(async () => {
    // The mcp-server registers stdin listeners when imported.
    // In the built dist/, this resolves to dist/server/mcp-server.js
    await import('./server/mcp-server.js');
  });

// ── codemem doctor ────────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Run a health check on the CodeMem installation')
  .action(async () => {
    const { runDoctor } = await import('./cli/commands/doctor.js');
    await runDoctor().catch(handleError);
  });

program.parse(process.argv);

function handleError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n${err instanceof Error && process.env['DEBUG'] ? err.stack : `Error: ${msg}`}`);
  process.exit(1);
}
