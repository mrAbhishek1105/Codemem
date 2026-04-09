import { FastifyInstance } from 'fastify';
import { VectraStore } from '../../storage/vectra-store.js';
import { MetaStore } from '../../storage/meta-store.js';
import { ConfigStore } from '../../storage/config-store.js';
import { Embedder } from '../../core/embedder.js';
import { FileWatcher } from '../../core/file-watcher.js';

export function registerStatusRoutes(
  app: FastifyInstance,
  store: VectraStore,
  meta: MetaStore,
  config: ConfigStore,
  embedder: Embedder,
  watcher: FileWatcher,
  startTime: number,
): void {

  // GET /api/v1/status
  app.get('/api/v1/status', async (_request, reply) => {
    const cfg = config.read();
    const stats = meta.getStats();
    const chunkCount = await store.count();
    const fileHashes = meta.getFileHashes();

    const uptimeMs = Date.now() - startTime;
    const uptimeSecs = Math.floor(uptimeMs / 1000);
    const uptimeStr = uptimeSecs < 60 ? `${uptimeSecs}s`
      : uptimeSecs < 3600 ? `${Math.floor(uptimeSecs / 60)}m ${uptimeSecs % 60}s`
      : `${Math.floor(uptimeSecs / 3600)}h ${Math.floor((uptimeSecs % 3600) / 60)}m`;

    return reply.send({
      status: 'running',
      project: {
        name: cfg.project.name,
        root: cfg.project.root,
        files_indexed: Object.keys(fileHashes).length,
        total_chunks: chunkCount,
        last_indexed: stats.last_indexed,
        language: cfg.project.detected_language,
        framework: cfg.project.detected_framework,
      },
      server: {
        port: cfg.server.port,
        uptime: uptimeStr,
        uptime_ms: uptimeMs,
      },
      watcher: {
        active: watcher.isRunning,
        pending_changes: watcher.pendingChanges,
      },
      model: {
        name: cfg.model.name,
        loaded: embedder.isReady,
      },
      stats: {
        queries_served: stats.queries_served,
        tokens_saved_total: stats.tokens_saved_total,
      },
    });
  });

  // GET /api/v1/stats — detailed token savings
  app.get('/api/v1/stats', async (_request, reply) => {
    const stats = meta.getStats();
    const avgTokensPerQuery = stats.queries_served > 0
      ? Math.round(stats.tokens_saved_total / stats.queries_served)
      : 0;

    return reply.send({
      queries_served: stats.queries_served,
      tokens_saved_total: stats.tokens_saved_total,
      avg_tokens_saved_per_query: avgTokensPerQuery,
      cost_saved_estimate_usd: (stats.tokens_saved_total / 1_000_000) * 3.0,
      files_indexed: stats.files_indexed,
      chunks_indexed: stats.chunks_indexed,
      last_indexed: stats.last_indexed,
    });
  });

  // GET /api/v1/config
  app.get('/api/v1/config', async (_request, reply) => {
    return reply.send(config.read());
  });

  // PUT /api/v1/config
  app.put<{ Body: Record<string, unknown> }>('/api/v1/config', async (request, reply) => {
    const updated = config.update(request.body as never);
    return reply.send(updated);
  });

  // GET /api/v1/health — simple health check
  app.get('/api/v1/health', async (_request, reply) => {
    return reply.send({ ok: true });
  });
}
