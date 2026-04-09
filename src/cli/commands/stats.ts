import { resolve } from 'path';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import { MetaStore } from '../../storage/meta-store.js';

export async function runStats(): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const configStore = new ConfigStore(projectRoot);

  if (!configStore.exists()) {
    ui.fail('No .codemem/ found. Run "codemem init" first.');
    process.exit(1);
  }

  const meta = new MetaStore(projectRoot);
  const stats = meta.getStats();

  const costSaved = (stats.tokens_saved_total / 1_000_000) * 3.0;

  ui.blank();
  console.log('  Token Savings Report');
  ui.section('All Time');
  ui.row('Queries served', stats.queries_served);
  ui.row('Tokens saved', ui.formatTokens(stats.tokens_saved_total));
  ui.row('Est. cost saved', `$${costSaved.toFixed(2)}`);

  ui.section('Index');
  ui.row('Files indexed', stats.files_indexed);
  ui.row('Chunks', stats.chunks_indexed);
  ui.row('Last indexed', stats.last_indexed ?? 'never');

  if (stats.tokens_saved_total > 0) {
    ui.blank();
    const savedContextWindows = Math.round(stats.tokens_saved_total / 100_000);
    ui.info(`You've saved ~${savedContextWindows} full context windows worth of tokens.`);
  }

  ui.blank();
}
