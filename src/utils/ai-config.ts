import { AIConfig, AIProviderName } from '../core/ai-agent.js';

export interface AIConfigOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export function resolveAIConfig(options: AIConfigOptions): AIConfig | null {
  let provider = normalizeProvider(options.provider);
  let apiKey = '';

  if (!provider) {
    if (process.env['OPENAI_API_KEY']) {
      provider = 'openai';
      apiKey = process.env['OPENAI_API_KEY'];
    } else if (process.env['ANTHROPIC_API_KEY']) {
      provider = 'anthropic';
      apiKey = process.env['ANTHROPIC_API_KEY'];
    } else {
      return null;
    }
  } else if (provider === 'openai') {
    apiKey = process.env['OPENAI_API_KEY'] ?? '';
  } else {
    apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  }

  if (!apiKey) {
    return null;
  }

  const baseURL = provider === 'openai'
    ? normalizeBaseUrl(options.baseUrl ?? process.env['CODEMEM_OPENAI_BASE_URL'] ?? process.env['OPENAI_BASE_URL'])
    : undefined;

  return {
    provider,
    apiKey,
    model: options.model,
    maxTokens: 4096,
    baseURL,
  };
}

function normalizeProvider(provider?: string): AIProviderName | undefined {
  if (!provider) return undefined;
  if (provider === 'openai' || provider === 'anthropic') return provider;
  throw new Error(`Unsupported AI provider "${provider}". Use "openai" or "anthropic".`);
}

function normalizeBaseUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}
