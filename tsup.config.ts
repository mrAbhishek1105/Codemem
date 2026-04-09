import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
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
  ],
  noExternal: [
    // Bundle everything else, including CJS packages
  ],
});
