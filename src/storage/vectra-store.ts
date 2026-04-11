import { join } from 'path';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { Chunk, VectraMetadata } from '../types/chunk.js';
import { logger } from '../utils/logger.js';

// Type for Vectra LocalIndex (using dynamic import to handle ESM/CJS boundary)
interface VectraItem {
  id: string;
  metadata: VectraMetadata;
  vector?: number[];
}

interface VectraQueryResult {
  item: VectraItem;
  score: number;
}

interface LocalIndexLike {
  isIndexCreated(): Promise<boolean>;
  createIndex(opts?: { version?: number; deleteIfExists?: boolean; metadata_config?: { indexed?: string[] } }): Promise<void>;
  insertItem(item: { id?: string; vector: number[]; metadata: VectraMetadata }): Promise<VectraItem>;
  upsertItem(item: { id: string; vector: number[]; metadata: VectraMetadata }): Promise<VectraItem>;
  deleteItem(id: string): Promise<void>;
  queryItems(vector: number[], topK: number): Promise<VectraQueryResult[]>;
  listItems(): Promise<VectraItem[]>;
  listItemsByMetadata(filter: object): Promise<VectraItem[]>;
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
  vectraId: string;
}

export class VectraStore {
  private index: LocalIndexLike | null = null;
  private dbPath: string;

  constructor(projectRoot: string) {
    this.dbPath = join(projectRoot, '.codemem', 'db');
  }

  async init(): Promise<void> {
    if (!existsSync(this.dbPath)) {
      mkdirSync(this.dbPath, { recursive: true });
    }

    const { LocalIndex } = await import('vectra');
    this.index = new LocalIndex(this.dbPath) as unknown as LocalIndexLike;

    try {
      const indexCreated = await this.index.isIndexCreated();
      if (!indexCreated) {
        await this.index.createIndex({ version: 1, deleteIfExists: false });
        logger.info('vectra-store', 'Created new vector index');
      } else {
        // Validate the existing index before continuing.
        await this.index.listItems();
        logger.info('vectra-store', 'Opened existing vector index');
      }
    } catch (err) {
      logger.error('vectra-store', 'Existing vector index is corrupted, recreating', this.toErrorData(err));
      this.recreateDb();
      this.index = new LocalIndex(this.dbPath) as unknown as LocalIndexLike;
      await this.index.createIndex({ version: 1, deleteIfExists: false });
      logger.info('vectra-store', 'Recreated corrupted vector index');
    }
  }

  private toErrorData(err: unknown): Record<string, unknown> {
    if (err instanceof Error) {
      return {
        name: err.name,
        message: err.message,
        stack: err.stack,
      };
    }
    return { error: String(err) };
  }

  private recreateDb(): void {
    if (existsSync(this.dbPath)) {
      try {
        rmSync(this.dbPath, { recursive: true, force: true });
      } catch (err) {
        logger.error('vectra-store', 'Failed to remove corrupted DB path', this.toErrorData(err));
        throw err;
      }
    }
    mkdirSync(this.dbPath, { recursive: true });
  }

  private ensureReady(): LocalIndexLike {
    if (!this.index) throw new Error('VectraStore not initialized. Call init() first.');
    return this.index;
  }

  /** Convert Chunk to flat Vectra metadata record */
  private toMeta(chunk: Chunk): VectraMetadata {
    return {
      chunk_id: chunk.metadata.chunk_id,
      file_path: chunk.header.file_path,
      language: chunk.header.language,
      type: chunk.header.type,
      name: chunk.header.name,
      exported: chunk.header.exported,
      description: chunk.header.description,
      imports: JSON.stringify(chunk.header.imports),
      called_by: JSON.stringify(chunk.header.called_by),
      calls: JSON.stringify(chunk.header.calls),
      params: JSON.stringify(chunk.header.params ?? []),
      code: chunk.code,
      envelope_text: chunk.envelope_text,
      start_line: chunk.metadata.start_line,
      end_line: chunk.metadata.end_line,
      token_count: chunk.metadata.token_count,
      content_hash: chunk.metadata.content_hash,
      last_modified: chunk.metadata.last_modified,
    };
  }

  /** Restore a Chunk from Vectra metadata */
  private fromMeta(meta: VectraMetadata): Chunk {
    return {
      header: {
        file_path: meta.file_path,
        language: meta.language,
        type: meta.type as Chunk['header']['type'],
        name: meta.name,
        exported: Boolean(meta.exported),
        description: meta.description,
        imports: JSON.parse(meta.imports || '[]') as string[],
        called_by: JSON.parse(meta.called_by || '[]') as string[],
        calls: JSON.parse(meta.calls || '[]') as string[],
        params: JSON.parse(meta.params || '[]') as string[],
      },
      code: meta.code,
      metadata: {
        chunk_id: meta.chunk_id,
        start_line: Number(meta.start_line),
        end_line: Number(meta.end_line),
        token_count: Number(meta.token_count),
        content_hash: meta.content_hash,
        last_modified: meta.last_modified,
      },
      envelope_text: meta.envelope_text,
    };
  }

  /** Sanitize chunk_id for use as a Vectra item ID */
  private toVectraId(chunkId: string): string {
    // Vectra uses the id as a JSON key — keep it but ensure it's not too long
    return chunkId.slice(0, 256);
  }

  async upsert(chunk: Chunk, vector: number[]): Promise<void> {
    const idx = this.ensureReady();
    const id = this.toVectraId(chunk.metadata.chunk_id);
    const meta = this.toMeta(chunk);
    await idx.upsertItem({ id, vector, metadata: meta });
  }

  async upsertMany(items: Array<{ chunk: Chunk; vector: number[] }>): Promise<void> {
    for (const item of items) {
      await this.upsert(item.chunk, item.vector);
    }
  }

  async delete(chunkId: string): Promise<void> {
    const idx = this.ensureReady();
    const id = this.toVectraId(chunkId);
    try {
      await idx.deleteItem(id);
    } catch {
      // Item might not exist — that's fine
    }
  }

  async deleteByFile(filePath: string): Promise<number> {
    const idx = this.ensureReady();
    const all = await idx.listItems();
    let deleted = 0;
    for (const item of all) {
      if (item.metadata.file_path === filePath) {
        await idx.deleteItem(item.id);
        deleted++;
      }
    }
    return deleted;
  }

  async search(queryVector: number[], topK = 10): Promise<SearchResult[]> {
    const idx = this.ensureReady();
    const results = await idx.queryItems(queryVector, topK);
    return results.map(r => ({
      chunk: this.fromMeta(r.item.metadata),
      score: r.score,
      vectraId: r.item.id,
    }));
  }

  async getAll(): Promise<Chunk[]> {
    const idx = this.ensureReady();
    const items = await idx.listItems();
    return items.map(i => this.fromMeta(i.metadata));
  }

  async count(): Promise<number> {
    const idx = this.ensureReady();
    const items = await idx.listItems();
    return items.length;
  }

  async getChunksByFile(filePath: string): Promise<Chunk[]> {
    const idx = this.ensureReady();
    const all = await idx.listItems();
    return all
      .filter(i => i.metadata.file_path === filePath)
      .map(i => this.fromMeta(i.metadata));
  }

  /** Check if a chunk with this ID already exists */
  async hasChunk(chunkId: string): Promise<boolean> {
    const idx = this.ensureReady();
    const all = await idx.listItems();
    return all.some(i => i.metadata.chunk_id === chunkId);
  }
}
