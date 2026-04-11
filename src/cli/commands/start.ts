import { resolve, join } from 'path';
import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import { MetaStore } from '../../storage/meta-store.js';
import { VectraStore } from '../../storage/vectra-store.js';
import { Embedder } from '../../core/embedder.js';
import { Indexer } from '../../core/indexer.js';
import { FileWatcher } from '../../core/file-watcher.js';
import { HttpServer } from '../../server/http-server.js';
import { logger } from '../../utils/logger.js';

export async function runStart(options: { debug?: boolean; port?: number }): Promise<void> {
  const projectRoot = resolve(process.cwd());

  const configStore = new ConfigStore(projectRoot);
  if (!configStore.exists()) {
    ui.fail('No .codemem/ found. Run "codemem init" first.');
    process.exit(1);
  }

  logger.configure(projectRoot, options.debug ?? false);
  if (options.debug) logger.setDebug(true);

  const config = configStore.read();
  const port = options.port ?? config.server.port;
  const metaStore = new MetaStore(projectRoot);

  ui.banner('0.1.0');
  ui.info(`Starting sidecar for: ${projectRoot}`);
  ui.blank();

  // Init storage
  const store = new VectraStore(projectRoot);
  const storeSpinner = ui.spinner('Opening vector index...').start();
  try {
    await store.init();
    const count = await store.count();
    storeSpinner.succeed(`Vector index ready (${count} chunks)`);
  } catch (err) {
    storeSpinner.fail(`Failed to open index: ${String(err)}`);
    ui.warn('Run "codemem init" to create the index. If this persists, remove .codemem/db and run "codemem init" again.');
    process.exit(1);
  }

  // Init embedder
  const embedder = new Embedder();
  const modelSpinner = ui.spinner('Loading embedding model...').start();
  try {
    await embedder.load();
    modelSpinner.succeed('Embedding model ready');
  } catch (err) {
    modelSpinner.fail(`Failed to load model: ${String(err)}`);
    process.exit(1);
  }

  const indexer = new Indexer(projectRoot, store, metaStore, configStore, embedder);
  const watcher = new FileWatcher(projectRoot, config.indexing.debounce_ms);

  // Start HTTP server
  const server = new HttpServer({ projectRoot, store, meta: metaStore, config: configStore, embedder, indexer, watcher });

  const serverSpinner = ui.spinner(`Starting server on localhost:${port}...`).start();
  try {
    await server.start(port);
    serverSpinner.succeed(`Sidecar running on http://localhost:${port}`);
  } catch (err) {
    serverSpinner.fail(`Failed to start server: ${String(err)}`);
    process.exit(1);
  }

  server.setIndexReady(true);

  // Start file watcher
  watcher.start();
  ui.success('File watcher active');

  // Write PID file
  const pidFile = join(projectRoot, '.codemem', 'server.pid');
  writeFileSync(pidFile, String(process.pid), 'utf-8');

  const stats = metaStore.getStats();
  ui.blank();
  ui.section('Status');
  ui.row('Files indexed', stats.files_indexed);
  ui.row('Chunks', stats.chunks_indexed);
  ui.row('Last indexed', stats.last_indexed ?? 'never');
  ui.row('Queries served', stats.queries_served);
  ui.blank();

  ui.info(`API ready at http://localhost:${port}/api/v1`);
  ui.info('Press Ctrl+C to stop');
  ui.blank();

  // Handle shutdown
  const shutdown = async (signal: string) => {
    console.log('');
    ui.info(`Received ${signal}, shutting down...`);
    watcher.stop();
    await server.stop();
    try { unlinkSync(pidFile); } catch {}
    ui.success('Sidecar stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  setInterval(() => {}, 1000 * 60 * 60);
}
