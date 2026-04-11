import assert from 'node:assert/strict';
import { resolveAIConfig } from '../src/utils/ai-config.js';

type TestCase = {
  name: string;
  run: () => void;
};

const originalEnv = {
  OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
  ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
  OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'],
  CODEMEM_OPENAI_BASE_URL: process.env['CODEMEM_OPENAI_BASE_URL'],
};

function resetEnv(): void {
  setEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY);
  setEnv('ANTHROPIC_API_KEY', originalEnv.ANTHROPIC_API_KEY);
  setEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL);
  setEnv('CODEMEM_OPENAI_BASE_URL', originalEnv.CODEMEM_OPENAI_BASE_URL);
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

const tests: TestCase[] = [
  {
    name: 'detects OpenAI config and trims base URL',
    run: () => {
      setEnv('OPENAI_API_KEY', 'test-key');
      setEnv('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1/');

      const result = resolveAIConfig({ model: 'gpt-4o-mini' });

      assert.deepEqual(result, {
        provider: 'openai',
        apiKey: 'test-key',
        model: 'gpt-4o-mini',
        maxTokens: 4096,
        baseURL: 'https://openrouter.ai/api/v1',
      });
    },
  },
  {
    name: 'supports explicit Anthropic selection',
    run: () => {
      setEnv('ANTHROPIC_API_KEY', 'anthropic-key');

      const result = resolveAIConfig({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      });

      assert.deepEqual(result, {
        provider: 'anthropic',
        apiKey: 'anthropic-key',
        model: 'claude-sonnet-4-5',
        maxTokens: 4096,
        baseURL: undefined,
      });
    },
  },
  {
    name: 'returns null when the selected provider key is missing',
    run: () => {
      setEnv('OPENAI_API_KEY', '');
      setEnv('ANTHROPIC_API_KEY', '');
      assert.equal(resolveAIConfig({ provider: 'openai' }), null);
    },
  },
  {
    name: 'throws for unsupported providers',
    run: () => {
      assert.throws(
        () => resolveAIConfig({ provider: 'groq' }),
        /Unsupported AI provider "groq"/,
      );
    },
  },
];

let failed = 0;

for (const test of tests) {
  try {
    resetEnv();
    test.run();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error);
  }
}

resetEnv();

if (failed > 0) {
  process.exit(1);
}

console.log(`\n${tests.length} tests passed`);
