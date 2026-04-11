import Fastify from 'fastify';
import { VectraStore } from '../storage/vectra-store.js';
import { MetaStore } from '../storage/meta-store.js';
import { ConfigStore } from '../storage/config-store.js';
import { Embedder } from '../core/embedder.js';
import { Indexer } from '../core/indexer.js';
import { Retriever } from '../core/retriever.js';
import { FileWatcher } from '../core/file-watcher.js';
import { registerQueryRoutes } from './routes/query.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { errorHandler } from './middleware/error-handler.js';
import { buildProjectSummary } from '../core/project-analyzer.js';
import { logger } from '../utils/logger.js';

export interface ServerContext {
  projectRoot: string;
  store: VectraStore;
  meta: MetaStore;
  config: ConfigStore;
  embedder: Embedder;
  indexer: Indexer;
  watcher: FileWatcher;
}

export class HttpServer {
  private app = Fastify({ logger: false });
  private ctx: ServerContext;
  private startTime = Date.now();
  private indexReady = false;
  private retriever: Retriever;

  constructor(ctx: ServerContext) {
    this.ctx = ctx;

    const summary = ctx.meta.getProjectSummary() || buildProjectSummary({
      name: ctx.config.read().project.name,
      root: ctx.projectRoot,
      language: ctx.config.read().project.detected_language,
      framework: ctx.config.read().project.detected_framework,
      packageManager: 'unknown',
      entryPoints: [],
      totalFiles: 0,
      description: '',
    });

    this.retriever = new Retriever(ctx.store, ctx.meta, ctx.config, ctx.embedder, summary);

    this.setup();
  }

  private setup(): void {
    // CORS headers for local IDE adapters
    this.app.addHook('onSend', async (_req, reply) => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
    });

    this.app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') {
        reply.status(204).send();
      }
    });

    // Register error handler
    this.app.setErrorHandler(errorHandler);

    // Register routes
    registerQueryRoutes(this.app, this.retriever, this.ctx.indexer, () => this.indexReady);
    registerStatusRoutes(
      this.app,
      this.ctx.store,
      this.ctx.meta,
      this.ctx.config,
      this.ctx.embedder,
      this.ctx.watcher,
      this.startTime,
    );
    registerMcpRoutes(this.app, this.retriever, () => this.indexReady);

    // Wire up file watcher → incremental indexer → cache invalidation
    this.ctx.watcher.onFileChange(async (absolutePath, event) => {
      try {
        logger.info('http-server', `File ${event}: ${absolutePath}`);
        await this.ctx.indexer.indexIncremental([absolutePath]);
        this.retriever.invalidateCache();
      } catch (err) {
        logger.error('http-server', `Failed to re-index on change: ${String(err)}`);
      }
    });
  }

  setIndexReady(ready: boolean): void {
    this.indexReady = ready;
    if (ready) {
      const summary = this.ctx.meta.getProjectSummary();
      if (summary) this.retriever.updateProjectSummary(summary);
    }
  }

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    await this.app.listen({ port, host });
    logger.info('http-server', `Listening on ${host}:${port}`);
  }

  async stop(): Promise<void> {
    await this.app.close();
    logger.info('http-server', 'Server stopped');
  }

  get address(): string {
    return this.app.server.address() as unknown as string;
  }
}
