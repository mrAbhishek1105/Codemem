import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server/mcp-server.ts'],
  format: ['esm'],
  target: 'node18',
  bundle: true,
  clean: true,
  dts: false,
  splitting: false,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [
    // Keep onnxruntime external — it has native bindings loaded dynamically
    'onnxruntime-node',
    'sharp',
    // AI SDKs — large, contain native optional deps, load fine at runtime
    'openai',
    '@anthropic-ai/sdk',
    // AST parser — has optional native bindings
    '@typescript-eslint/typescript-estree',
  ],
  noExternal: [
    // Bundle everything else, including CJS packages
  ],
});
