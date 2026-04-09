import { FastifyInstance } from 'fastify';
import { Retriever } from '../../core/retriever.js';
import { createApiError } from '../middleware/error-handler.js';
import { QueryResult } from '../../types/query.js';

interface SearchBody {
  query: string;
  top_k?: number;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function registerMcpRoutes(app: FastifyInstance, retriever: Retriever, isReady: () => boolean): void {
  app.get('/api/v1/tools', async () => {
    return {
      tools: [
        {
          name: 'search_codebase',
          description: 'Retrieve relevant code chunks from the indexed project.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Natural language search query for the codebase' },
              top_k: { type: 'number', description: 'Number of chunks to return (default 6)' },
            },
            required: ['query'],
          },
        },
      ],
    };
  });

  app.post<{ Body: SearchBody }>('/api/v1/tool/search_codebase', async (request, reply) => {
    if (!isReady()) {
      throw createApiError('INDEX_NOT_READY', 'Index is not ready. Run "codemem init" first.', 503);
    }

    const { query, top_k } = request.body;
    if (!query || typeof query !== 'string') {
      throw createApiError('QUERY_REQUIRED', 'query field is required and must be a string', 400);
    }

    const result: QueryResult = await retriever.query(query, { top_k: top_k ?? 6 });
    return reply.send({ tool: 'search_codebase', result });
  });
}
