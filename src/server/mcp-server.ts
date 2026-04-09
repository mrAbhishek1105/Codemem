/**
 * CodeMem MCP Server — JSON-RPC 2.0 over stdin/stdout
 *
 * Protocol (Claude Desktop / Cursor compatible):
 *   1. Client → initialize        (handshake)
 *   2. Server → result            (capabilities)
 *   3. Client → notifications/initialized  (no id, no reply needed)
 *   4. Client → tools/list
 *   5. Client → tools/call  { name, arguments }
 *
 * Run via:  codemem mcp
 * Or:       node dist/server/mcp-server.js
 *
 * Env:
 *   CODEMEM_PORT  — CodeMem sidecar port (default 8432)
 */

import { searchCodebaseTool } from '../core/ai-agent.js';
import { QueryResult } from '../types/query.js';

// ─── JSON-RPC types ───────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function send(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function log(msg: string): void {
  // Write diagnostics to stderr — stdout is reserved for JSON-RPC
  process.stderr.write(`[codemem-mcp] ${msg}\n`);
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_codebase',
    description:
      'Search the locally indexed codebase using semantic similarity. ' +
      'Returns relevant code chunks with file paths, line numbers, and relevance scores. ' +
      'Always call this tool before answering questions about the project code, architecture, ' +
      'or implementation details. Call multiple times with refined queries as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural language search query describing what code or concept to find. ' +
            'Example: "how does authentication work", "where are database models defined"',
        },
        top_k: {
          type: 'number',
          description: 'Number of code chunks to return (default: 6, max: 12)',
        },
      },
      required: ['query'],
    },
  },
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleInitialize(id: string | number | null): JsonRpcResponse {
  return ok(id, {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: 'codemem',
      version: '0.25.0',
    },
  });
}

function handleToolsList(id: string | number | null): JsonRpcResponse {
  return ok(id, { tools: TOOLS });
}

async function handleToolsCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  const params = request.params;

  if (!params || typeof params !== 'object') {
    return err(id, -32602, 'Invalid params: expected object');
  }

  const name = String(params['name'] ?? '');
  const args = params['arguments'];

  if (name !== 'search_codebase') {
    return err(id, -32601, `Unknown tool: ${name}`);
  }

  if (!args || typeof args !== 'object') {
    return err(id, -32602, 'Missing arguments object');
  }

  const query = String((args as Record<string, unknown>)['query'] ?? '').trim();
  if (!query) {
    return err(id, -32602, 'Required argument missing: query');
  }

  const topKRaw = (args as Record<string, unknown>)['top_k'];
  const topK = typeof topKRaw === 'number' && Number.isFinite(topKRaw)
    ? Math.min(Math.max(1, topKRaw), 12)
    : 6;

  const port = Number(process.env['CODEMEM_PORT'] ?? '8432');
  const start = Date.now();

  try {
    const result: QueryResult = await searchCodebaseTool(query, port, topK);
    const ms = Date.now() - start;

    log(`search_codebase query="${query.slice(0, 80)}" top_k=${topK} port=${port} ${ms}ms`);

    const assembled = result.context.assembled_text;
    const chunks = result.context.chunks.length;
    const tokens = result.context.token_count;

    return ok(id, {
      content: [
        {
          type: 'text',
          text: assembled,
        },
      ],
      // Extra metadata helpful for debugging (ignored by most clients)
      _meta: { chunks_returned: chunks, token_count: tokens, query_ms: ms },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`search_codebase error: ${message}`);

    // Return a graceful error message as content (not a protocol error)
    // so the AI can understand and explain the failure to the user
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      return ok(id, {
        content: [
          {
            type: 'text',
            text: `CodeMem sidecar is not running on port ${port}. ` +
                  `Please start it with: codemem start`,
          },
        ],
      });
    }

    return err(id, -32000, `Tool execution failed: ${message}`);
  }
}

// ─── Request router ───────────────────────────────────────────────────────────

async function handleRequest(raw: string): Promise<void> {
  const trimmed = raw.trim();
  if (!trimmed) return;

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    send(err(null, -32700, 'Parse error: invalid JSON'));
    return;
  }

  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    send(err(request.id ?? null, -32600, 'Invalid Request'));
    return;
  }

  // Notifications have no id — process them silently, send NO response
  const isNotification = !('id' in request);
  if (isNotification) {
    // The only notification we care about is notifications/initialized
    if (request.method === 'notifications/initialized') {
      log('Initialized — ready for tool calls');
    }
    return;
  }

  const id = request.id ?? null;

  switch (request.method) {
    case 'initialize':
      send(handleInitialize(id));
      break;

    case 'ping':
      send(ok(id, {}));
      break;

    case 'tools/list':
      send(handleToolsList(id));
      break;

    case 'tools/call':
      send(await handleToolsCall(request));
      break;

    // Unsupported but expected methods — return empty lists so client doesn't crash
    case 'resources/list':
      send(ok(id, { resources: [] }));
      break;

    case 'prompts/list':
      send(ok(id, { prompts: [] }));
      break;

    default:
      send(err(id, -32601, `Method not found: ${request.method}`));
  }
}

// ─── STDIO transport ──────────────────────────────────────────────────────────

log(`Starting MCP server (port=${process.env['CODEMEM_PORT'] ?? '8432'})`);

let buffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';          // keep incomplete last line in buffer
  for (const line of lines) {
    handleRequest(line).catch(e => {
      log(`Unhandled error: ${String(e)}`);
    });
  }
});

process.stdin.on('end', () => {
  if (buffer.trim()) {
    handleRequest(buffer).catch(e => log(`Unhandled error on end: ${String(e)}`));
  }
  log('stdin closed — exiting');
});

process.stdin.on('error', (e) => {
  log(`stdin error: ${e.message}`);
  process.exit(1);
});

// Ensure stdout errors don't crash the process
process.stdout.on('error', () => {/* client disconnected */});
