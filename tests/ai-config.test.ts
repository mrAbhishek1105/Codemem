import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAIConfig } from '../src/utils/ai-config.js';

describe('resolveAIConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('detects OpenAI settings and trims a configured base URL', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1/');

    const result = resolveAIConfig({ model: 'gpt-4o-mini' });

    expect(result).toEqual({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      maxTokens: 4096,
      baseURL: 'https://openrouter.ai/api/v1',
    });
  });

  it('supports explicit anthropic selection', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');

    const result = resolveAIConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    expect(result).toEqual({
      provider: 'anthropic',
      apiKey: 'anthropic-key',
      model: 'claude-sonnet-4-5',
      maxTokens: 4096,
      baseURL: undefined,
    });
  });

  it('returns null when the required provider key is missing', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    expect(resolveAIConfig({ provider: 'openai' })).toBeNull();
  });

  it('throws for unsupported providers', () => {
    expect(() => resolveAIConfig({ provider: 'groq' })).toThrow(
      'Unsupported AI provider "groq". Use "openai" or "anthropic".',
    );
  });
});
