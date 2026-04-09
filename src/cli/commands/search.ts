import { resolve } from 'path';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';

export async function runSearch(query: string, options: { top?: number }): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const configStore = new ConfigStore(projectRoot);

  if (!configStore.exists()) {
    ui.fail('No .codemem/ found. Run "codemem init" first.');
    process.exit(1);
  }

  const config = configStore.read();
  const port = config.server.port;

  const spinner = ui.spinner(`Searching for: "${query}"...`).start();

  try {
    const res = await fetch(`http://localhost:${port}/api/v1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, options: { top_k: options.top ?? 5 } }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const err = await res.json() as { error: { message: string } };
      spinner.fail(err.error?.message ?? 'Query failed');
      process.exit(1);
    }

    const result = await res.json() as {
      context: { chunks: Array<{ id: string; file_path: string; content: string; relevance_score: number; type: string; lines: [number, number] }>; token_count: number };
      stats: { chunks_returned: number; tokens_saved_estimate: number; query_time_ms: number };
    };
    spinner.stop();

    const chunks = result.context.chunks;
    if (chunks.length === 0) {
      ui.warn('No relevant code found.');
      return;
    }

    ui.blank();
    console.log(`  Results (${chunks.length} chunks, ${result.stats.query_time_ms}ms):`);
    ui.section('');

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const score = (c.relevance_score * 100).toFixed(0);
      console.log(`  ${i + 1}. ${c.file_path} :: ${c.id.split('::')[1] ?? c.type}   [${score}%]`);
      // Show first 2 lines of code as preview
      const preview = c.content.split('\n').slice(0, 2).join(' ').slice(0, 80);
      console.log(`     ${preview}`);
      console.log('');
    }

    ui.info(`${ui.formatTokens(result.stats.tokens_saved_estimate)} tokens saved vs full read`);
    ui.blank();
  } catch (err) {
    spinner.fail(`Search failed: ${String(err)}`);
    ui.warn('Is the sidecar running? Try "codemem start"');
    process.exit(1);
  }
}
