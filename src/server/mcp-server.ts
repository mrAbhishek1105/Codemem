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
import { runtimeConfig } from '../utils/runtime.js';

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

function handleSidecarError(e: unknown, port: number, id: string | number | null): JsonRpcResponse {
  const message = e instanceof Error ? e.message : String(e);
  log(`sidecar error: ${message}`);
  if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
    return ok(id, {
      content: [{
        type: 'text',
        text: `CodeMem sidecar is not running on port ${port}. Start it with: codemem start`,
      }],
    });
  }
  return err(id, -32000, `Tool execution failed: ${message}`);
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
  {
    name: 'plan_change',
    description:
      'Generate a structured implementation plan for a code change. ' +
      'Returns a list of files to modify/create/delete with descriptions of each change. ' +
      'Call this before generate_patch to understand scope. ' +
      'Requires AI API key configured on the CodeMem server (OPENAI_API_KEY or ANTHROPIC_API_KEY).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Description of the change to implement, e.g. "add JWT validation to login"',
        },
        top_k: {
          type: 'number',
          description: 'Context chunks to retrieve for planning (default: 8)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'generate_patch',
    description:
      'Generate complete updated file contents based on a plan from plan_change. ' +
      'Returns full file content for each file in the plan — not a diff. ' +
      'Review the patches before calling apply_patch. ' +
      'Requires AI API key configured on the CodeMem server.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Plan object returned by plan_change',
        },
        top_k: {
          type: 'number',
          description: 'Context chunks to retrieve for patch generation (default: 8)',
        },
      },
      required: ['plan'],
    },
  },
  {
    name: 'apply_patch',
    description:
      'Apply previously generated patches to the filesystem. ' +
      'IMPORTANT: The human user MUST review the patches and set approved=true explicitly. ' +
      'Files are backed up to .codemem/backups/ before being overwritten. ' +
      'Never call this without explicit user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        patches: {
          type: 'array',
          description: 'Array of { file, content } objects from generate_patch',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['file', 'content'],
          },
        },
        approved: {
          type: 'boolean',
          description: 'Must be true — set only after the human user has reviewed and approved the patches',
        },
      },
      required: ['patches', 'approved'],
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
      version: runtimeConfig.version,
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

  const port = runtimeConfig.port;

  if (!args || typeof args !== 'object') {
    return err(id, -32602, 'Missing arguments object');
  }

  const argsMap = args as Record<string, unknown>;

  if (name === 'search_codebase') {
    const query = String(argsMap['query'] ?? '').trim();
    if (!query) return err(id, -32602, 'Required argument missing: query');

    const topKRaw = argsMap['top_k'];
    const topK = typeof topKRaw === 'number' && Number.isFinite(topKRaw)
      ? Math.min(Math.max(1, topKRaw), 12)
      : 6;

    const start = Date.now();
    try {
      const result: QueryResult = await searchCodebaseTool(query, port, topK);
      const ms = Date.now() - start;
      log(`search_codebase query="${query.slice(0, 80)}" top_k=${topK} port=${port} ${ms}ms`);
      return ok(id, {
        content: [{ type: 'text', text: result.context.assembled_text }],
        _meta: { chunks_returned: result.context.chunks.length, token_count: result.context.token_count, query_ms: ms },
      });
    } catch (e) {
      return handleSidecarError(e, port, id);
    }
  }

  if (name === 'plan_change' || name === 'generate_patch' || name === 'apply_patch') {
    // Forward to the HTTP sidecar agent routes
    const routeMap: Record<string, string> = {
      plan_change: '/api/v1/plan',
      generate_patch: '/api/v1/patch',
      apply_patch: '/api/v1/apply',
    };
    const route = routeMap[name];

    // Remap argument keys to what the HTTP route expects
    let body: Record<string, unknown> = {};
    if (name === 'plan_change') {
      body = { query: argsMap['query'], top_k: argsMap['top_k'] ?? 8 };
    } else if (name === 'generate_patch') {
      body = { plan: argsMap['plan'], top_k: argsMap['top_k'] ?? 8 };
    } else {
      body = { patches: argsMap['patches'], approved: argsMap['approved'] };
    }

    try {
      const res = await fetch(`http://localhost:${port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = (data as { message?: string }).message ?? JSON.stringify(data);
        return err(id, -32000, `${name} failed (${res.status}): ${msg}`);
      }
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      });
    } catch (e) {
      return handleSidecarError(e, port, id);
    }
  }

  return err(id, -32601, `Unknown tool: ${name}`);
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

log(`Starting MCP server v${runtimeConfig.version} (port=${runtimeConfig.port})`);

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
