import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';

type Pipeline = (text: string | string[], options?: Record<string, unknown>) => Promise<{ data: Float32Array | number[] }>;

let extractor: Pipeline | null = null;
let isLoading = false;
let loadPromise: Promise<void> | null = null;

export interface EmbedderOptions {
  modelName?: string;
  cacheDir?: string;
  onProgress?: (progress: { status: string; loaded?: number; total?: number; name?: string }) => void;
}

export class Embedder {
  private modelName: string;
  private cacheDir: string;
  private onProgress?: EmbedderOptions['onProgress'];

  constructor(opts: EmbedderOptions = {}) {
    this.modelName = opts.modelName ?? 'Xenova/all-MiniLM-L6-v2';
    this.cacheDir = opts.cacheDir ?? join(homedir(), '.codemem', 'models');
    this.onProgress = opts.onProgress;
  }

  async load(): Promise<void> {
    if (extractor) return;
    if (loadPromise) return loadPromise;

    loadPromise = this._doLoad();
    return loadPromise;
  }

  private async _doLoad(): Promise<void> {
    logger.info('embedder', `Loading model: ${this.modelName}`);

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }

    // Dynamically import @xenova/transformers to support ESM
    const { pipeline, env } = await import('@xenova/transformers');

    // Configure cache directory
    env.cacheDir = this.cacheDir;
    // Disable remote model fetching except on first run
    env.allowRemoteModels = true;
    env.allowLocalModels = true;

    // Force single-threaded WASM — onnxruntime-web uses blob: URLs for worker
    // scripts which Node.js v18+ rejects with ERR_WORKER_PATH. Setting
    // numThreads=1 disables multi-threaded workers entirely.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (env as any).backends = (env as any).backends ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backends = (env as any).backends;
    backends.onnx = backends.onnx ?? {};
    backends.onnx.wasm = backends.onnx.wasm ?? {};
    backends.onnx.wasm.numThreads = 1;

    const progressCallback = this.onProgress
      ? (p: { status: string; loaded?: number; total?: number; name?: string }) => {
          this.onProgress!(p);
        }
      : undefined;

    extractor = await pipeline('feature-extraction', this.modelName, {
      progress_callback: progressCallback,
    }) as unknown as Pipeline;

    logger.info('embedder', 'Model loaded successfully');
  }

  /** Generate a 384-dimensional embedding vector for the given text */
  async embed(text: string): Promise<number[]> {
    if (!extractor) {
      await this.load();
    }

    if (!extractor) throw new Error('Embedder not initialized');

    try {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data as Float32Array);
    } catch (err) {
      logger.error('embedder', 'Failed to embed text', { error: String(err) });
      throw err;
    }
  }

  /** Embed multiple texts in batches for efficiency */
  async embedBatch(texts: string[], batchSize = 32): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const embeddings = await Promise.all(batch.map(t => this.embed(t)));
      results.push(...embeddings);
    }

    return results;
  }

  get isReady(): boolean {
    return extractor !== null;
  }
}

// Singleton instance
export const embedder = new Embedder();
