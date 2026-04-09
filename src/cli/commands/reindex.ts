import { resolve } from 'path';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import { MetaStore } from '../../storage/meta-store.js';
import { VectraStore } from '../../storage/vectra-store.js';
import { Embedder } from '../../core/embedder.js';
import { Indexer } from '../../core/indexer.js';
import { logger } from '../../utils/logger.js';

export async function runReindex(options: { full?: boolean; debug?: boolean }): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const configStore = new ConfigStore(projectRoot);

  if (!configStore.exists()) {
    ui.fail('No .codemem/ found. Run "codemem init" first.');
    process.exit(1);
  }

  logger.configure(projectRoot, options.debug ?? false);

  const metaStore = new MetaStore(projectRoot);
  const store = new VectraStore(projectRoot);

  const storeSpinner = ui.spinner('Opening vector index...').start();
  try {
    await store.init();
    storeSpinner.succeed('Index opened');
  } catch (err) {
    storeSpinner.fail(`Failed to open index: ${String(err)}`);
    process.exit(1);
  }

  const embedder = new Embedder();
  const modelSpinner = ui.spinner('Loading embedding model...').start();
  try {
    await embedder.load();
    modelSpinner.succeed('Model ready');
  } catch (err) {
    modelSpinner.fail(`Failed to load model: ${String(err)}`);
    process.exit(1);
  }

  const indexer = new Indexer(projectRoot, store, metaStore, configStore, embedder);

  const mode = options.full ? 'full' : 'incremental';
  console.log(`\n  Re-indexing (${mode})...`);

  const start = Date.now();
  let result;
  if (options.full) {
    result = await indexer.indexFull();
  } else {
    result = await indexer.indexIncremental();
  }

  ui.blank();
  ui.success(`${result.filesScanned} files scanned`);
  ui.success(`${result.chunksCreated} chunks created/updated`);
  if (result.chunksRemoved > 0) ui.success(`${result.chunksRemoved} stale chunks removed`);
  if (result.errors.length > 0) ui.warn(`${result.errors.length} errors`);
  ui.success(`Completed in ${ui.formatMs(result.durationMs)}`);
  ui.blank();
}
