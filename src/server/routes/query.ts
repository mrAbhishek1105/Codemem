import { FastifyInstance } from 'fastify';
import { Retriever } from '../../core/retriever.js';
import { Indexer } from '../../core/indexer.js';
import { QueryOptions } from '../../types/query.js';
import { createApiError } from '../middleware/error-handler.js';

interface QueryBody {
  query: string;
  options?: QueryOptions;
}

interface IndexBody {
  mode?: 'full' | 'incremental' | 'file';
  target?: string | null;
}

interface UpdateBody {
  file_path: string;
  action: 'created' | 'modified' | 'deleted';
  content?: string;
}

export function registerQueryRoutes(
  app: FastifyInstance,
  retriever: Retriever,
  indexer: Indexer,
  isReady: () => boolean,
): void {

  // POST /api/v1/query — main retrieval endpoint
  app.post<{ Body: QueryBody }>('/api/v1/query', async (request, reply) => {
    if (!isReady()) {
      throw createApiError('INDEX_NOT_READY', 'Index is not ready. Run "codemem init" first.', 503);
    }

    const { query, options } = request.body;

    if (!query || typeof query !== 'string') {
      throw createApiError('QUERY_REQUIRED', 'query field is required and must be a string', 400);
    }
    if (query.length > 2000) {
      throw createApiError('QUERY_TOO_LONG', 'Query exceeds 2000 characters', 400);
    }

    const result = await retriever.query(query, options ?? {});
    return reply.send(result);
  });

  // POST /api/v1/index — trigger (re)indexing
  app.post<{ Body: IndexBody }>('/api/v1/index', async (request, reply) => {
    const mode = request.body?.mode ?? 'incremental';

    const result = await indexer.indexIncremental();

    return reply.send({
      status: 'completed',
      files_indexed: result.filesIndexed,
      chunks_created: result.chunksCreated,
      duration_ms: result.durationMs,
      errors: result.errors,
    });
  });

  // POST /api/v1/update — notify sidecar that AI modified a file
  app.post<{ Body: UpdateBody }>('/api/v1/update', async (request, reply) => {
    const { file_path, action } = request.body;

    if (!file_path) {
      throw createApiError('FILE_PATH_REQUIRED', 'file_path is required', 400);
    }

    // Trigger incremental re-index for this specific file
    retriever.invalidateCache();

    return reply.send({
      status: 'queued',
      file_path,
      action,
    });
  });
}
