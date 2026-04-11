import { FastifyInstance } from 'fastify';
import { resolve } from 'path';
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
    const target = request.body?.target ?? null;

    let result;
    if (mode === 'full') {
      result = await indexer.indexFull();
    } else if (mode === 'file') {
      if (!target || typeof target !== 'string') {
        throw createApiError('TARGET_REQUIRED', 'target file path is required for file indexing', 400);
      }
      const filePath = resolve(process.cwd(), target);
      result = await indexer.indexIncremental([filePath]);
    } else {
      result = await indexer.indexIncremental();
    }

    retriever.invalidateCache();

    return reply.send({
      status: 'completed',
      mode,
      target,
      files_indexed: result.filesIndexed,
      chunks_created: result.chunksCreated,
      duration_ms: result.durationMs,
      errors: result.errors,
    });
  });

  // POST /api/v1/update — notify sidecar that AI modified a file
  app.post<{ Body: UpdateBody }>('/api/v1/update', async (request, reply) => {
    const { file_path, action } = request.body;

    if (!file_path || typeof file_path !== 'string') {
      throw createApiError('FILE_PATH_REQUIRED', 'file_path is required and must be a string', 400);
    }

    const filePath = resolve(process.cwd(), file_path);
    const result = await indexer.indexIncremental([filePath]);
    retriever.invalidateCache();

    return reply.send({
      status: 'updated',
      action,
      file_path,
      files_indexed: result.filesIndexed,
      chunks_created: result.chunksCreated,
      chunks_removed: result.chunksRemoved,
      duration_ms: result.durationMs,
      errors: result.errors,
    });
  });
}
