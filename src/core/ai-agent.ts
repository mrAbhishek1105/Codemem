/**
 * AI Agent — two-way integration layer.
 *
 * Mode A (direct):
 *   CodeMem retrieves context → builds prompt → calls AI once → returns answer
 *
 * Mode B (agent loop):
 *   AI receives tools including search_codebase + run_terminal.
 *   It calls those tools as needed (agentic loop) then returns final answer.
 *
 * Supports OpenAI (gpt-4o, etc.) and Anthropic (claude-*) via
 * provider-agnostic interfaces.
 */

import { logger } from '../utils/logger.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export type AIProviderName = 'openai' | 'anthropic';

export interface AIConfig {
  provider: AIProviderName;
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseURL?: string;
}

// ─── Message types ────────────────────────────────────────────────────────────

export interface AIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AIResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
}

// ─── Built-in tool definitions ────────────────────────────────────────────────

export const SEARCH_CODEBASE_TOOL: ToolDefinition = {
  name: 'search_codebase',
  description:
    'Search the indexed codebase for relevant code using semantic similarity. ' +
    'ALWAYS call this before answering any question about code, architecture, ' +
    'implementation details, or project structure. Call multiple times with ' +
    'different queries to gather complete context.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Descriptive search query — use natural language, e.g. "how is authentication handled"',
      },
      top_k: {
        type: 'number',
        description: 'Number of chunks to return (default: 6, max: 12)',
      },
    },
    required: ['query'],
  },
};

export const RUN_TERMINAL_TOOL: ToolDefinition = {
  name: 'run_terminal',
  description:
    'Execute a read-only terminal command and return its stdout/stderr output. ' +
    'Use for inspecting files (type/cat), listing directories (dir/ls), ' +
    'checking git status, running tests, or reading build output. ' +
    'Only use when the user explicitly asks to run something or when ' +
    'you need runtime information not available in the codebase index.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute (e.g. "dir src", "git log --oneline -5", "npm test")',
      },
    },
    required: ['command'],
  },
};

// ─── OpenAI provider ──────────────────────────────────────────────────────────

async function callOpenAI(
  config: AIConfig,
  messages: AIMessage[],
  tools?: ToolDefinition[],
): Promise<AIResponse> {
  const { default: OpenAI } = await import('openai');

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const model = config.model ?? 'gpt-4o';

  // Build OpenAI messages — tool results need special role handling
  const oaiMessages = messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        content: m.content,
        tool_call_id: m.tool_call_id ?? 'unknown',
      };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return {
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    };
  });

  const response = await client.chat.completions.create({
    model,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: oaiMessages as any,
    max_tokens: config.maxTokens ?? 4096,
    tools: tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    tool_choice: tools ? 'auto' : undefined,
  });

  const choice = response.choices[0];
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    arguments: (() => {
      try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
      catch { return {}; }
    })(),
  }));

  return {
    content: choice.message.content ?? '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: choice.finish_reason ?? 'stop',
  };
}

// ─── Anthropic provider ───────────────────────────────────────────────────────

async function callAnthropic(
  config: AIConfig,
  messages: AIMessage[],
  tools?: ToolDefinition[],
): Promise<AIResponse> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');

  const client = new Anthropic({ apiKey: config.apiKey });
  const model = config.model ?? 'claude-opus-4-5';

  const systemMsg = messages.find(m => m.role === 'system')?.content ?? '';

  // Convert our message format to Anthropic's format
  const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [];

  for (const m of messages.filter(m => m.role !== 'system')) {
    if (m.role === 'tool') {
      // Tool result — append to last user message or create new one
      const toolResult = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? 'unknown',
        content: m.content,
      };
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) {
        (last.content as unknown[]).push(toolResult);
      } else {
        anthropicMessages.push({ role: 'user', content: [toolResult] });
      }
    } else if (m.role === 'assistant' && m.tool_calls) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        parts.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      anthropicMessages.push({ role: 'assistant', content: parts });
    } else {
      anthropicMessages.push({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      });
    }
  }

  const response = await client.messages.create({
    model,
    max_tokens: config.maxTokens ?? 4096,
    system: systemMsg || undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: anthropicMessages as any,
    tools: tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
      },
    })),
  });

  const textBlocks = response.content.filter(b => b.type === 'text');
  const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

  const textContent = textBlocks.map(b => (b as { type: 'text'; text: string }).text).join('');

  const toolCalls: ToolCall[] = toolUseBlocks.map(b => {
    const tu = b as { type: 'tool_use'; id: string; name: string; input: unknown };
    return { id: tu.id, name: tu.name, arguments: tu.input as Record<string, unknown> };
  });

  return {
    content: textContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: response.stop_reason ?? 'end_turn',
  };
}

// ─── Unified caller ───────────────────────────────────────────────────────────

export async function callAI(
  config: AIConfig,
  messages: AIMessage[],
  tools?: ToolDefinition[],
): Promise<AIResponse> {
  logger.debug('ai-agent', `Calling ${config.provider} (${config.model ?? 'default'})`);
  try {
    switch (config.provider) {
      case 'openai':    return await callOpenAI(config, messages, tools);
      case 'anthropic': return await callAnthropic(config, messages, tools);
      default: throw new Error(`Unknown AI provider: ${String(config.provider)}`);
    }
  } catch (err) {
    logger.error('ai-agent', 'AI call failed', { error: String(err) } as unknown as Record<string, unknown>);
    throw err;
  }
}

// ─── Agentic loop (Mode B) ────────────────────────────────────────────────────

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * Run an agentic loop: AI can call tools (search_codebase, run_terminal, etc.)
 * until it produces a final text response.
 */
export async function runAgentLoop(
  config: AIConfig,
  userQuery: string,
  tools: ToolDefinition[],
  executeTool: ToolExecutor,
  systemPrompt?: string,
  maxTurns = 10,
): Promise<string> {
  const messages: AIMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userQuery });

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callAI(config, messages, tools);

    // No tool calls → final answer
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return response.content;
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.toolCalls,
    });

    // Execute each tool and feed results back
    for (const tc of response.toolCalls) {
      logger.info('ai-agent', `Tool call: ${tc.name}`, {
        args: JSON.stringify(tc.arguments).slice(0, 120),
      } as unknown as Record<string, unknown>);

      let result: string;
      try {
        result = await executeTool(tc.name, tc.arguments);
      } catch (err) {
        result = `Error executing tool ${tc.name}: ${String(err)}`;
      }

      messages.push({
        role: 'tool',
        content: result,
        tool_call_id: tc.id,
      });
    }
  }

  // Hit max turns — get final answer without tools
  const final = await callAI(config, messages);
  return final.content;
}

// ─── System prompt ────────────────────────────────────────────────────────────

export function buildSystemPrompt(projectSummary: string): string {
  return `You are an expert software engineer with full access to this project's codebase.

Project: ${projectSummary}

You have two tools available:
1. search_codebase — semantic search over the indexed codebase. Use this to find relevant code.
2. run_terminal — execute a shell command and read its output.

RULES:
- ALWAYS call search_codebase before answering any code question. Never guess from memory.
- Call search_codebase multiple times with different queries if needed.
- Reference exact file paths and function names found in search results.
- When suggesting code changes, show the full modified function/block.
- Be concise but complete. No filler text.`;
}
