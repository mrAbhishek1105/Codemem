import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import pLimit from 'p-limit';
import { VectraStore } from '../storage/vectra-store.js';
import { MetaStore } from '../storage/meta-store.js';
import { ConfigStore } from '../storage/config-store.js';
import { Embedder } from './embedder.js';
import { detectLanguage } from '../parsers/regex-parser.js';
import { extractChunks } from './chunk-extractor.js';
import { IgnoreFilter } from '../utils/ignore.js';
import { hashContent } from '../utils/hash.js';
import { logger } from '../utils/logger.js';
import { Chunk } from '../types/chunk.js';

export interface IndexProgress {
  phase: 'scanning' | 'chunking' | 'embedding' | 'storing' | 'done' | 'error';
  filesTotal: number;
  filesProcessed: number;
  chunksCreated: number;
  currentFile?: string;
  error?: string;
}

export type ProgressCallback = (progress: IndexProgress) => void;

export interface IndexResult {
  filesScanned: number;
  filesIndexed: number;
  chunksCreated: number;
  chunksUpdated: number;
  chunksRemoved: number;
  errors: string[];
  durationMs: number;
}

// File extensions we can meaningfully parse
const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.kt', '.rb', '.php',
  '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.swift', '.scala',
  '.sh', '.bash',
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.txt',
  '.html', '.css', '.scss', '.sass',
  '.sql',
]);

export class Indexer {
  private store: VectraStore;
  private meta: MetaStore;
  private config: ConfigStore;
  private embedder: Embedder;
  private projectRoot: string;
  private ignoreFilter: IgnoreFilter;

  constructor(projectRoot: string, store: VectraStore, meta: MetaStore, config: ConfigStore, embedder: Embedder) {
    this.projectRoot = projectRoot;
    this.store = store;
    this.meta = meta;
    this.config = config;
    this.embedder = embedder;
    this.ignoreFilter = new IgnoreFilter(projectRoot);
  }

  /** Full index: scan everything, embed, store */
  async indexFull(onProgress?: ProgressCallback): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    onProgress?.({ phase: 'scanning', filesTotal: 0, filesProcessed: 0, chunksCreated: 0 });

    // Scan all files
    const files = this.scanFiles();
    logger.info('indexer', `Scanning ${files.length} files for indexing`);

    onProgress?.({ phase: 'chunking', filesTotal: files.length, filesProcessed: 0, chunksCreated: 0 });

    let chunksCreated = 0;
    let filesIndexed = 0;
    const cfg = this.config.read();
    const maxFileSizeBytes = cfg.indexing.max_file_size_kb * 1024;

    // Process files with concurrency limit (disk I/O bound)
    const limit = pLimit(4);
    const allChunks: Array<{ chunk: Chunk; vector: number[] }> = [];

    await Promise.all(files.map((file, idx) =>
      limit(async () => {
        onProgress?.({
          phase: 'embedding',
          filesTotal: files.length,
          filesProcessed: idx,
          chunksCreated,
          currentFile: relative(this.projectRoot, file),
        });

        try {
          const chunks = await this.processFile(file, maxFileSizeBytes);
          if (chunks.length === 0) return;

          // Embed all chunks for this file
          const texts = chunks.map(c => c.envelope_text);
          const vectors = await this.embedder.embedBatch(texts, 16);

          for (let i = 0; i < chunks.length; i++) {
            allChunks.push({ chunk: chunks[i], vector: vectors[i] });
          }

          // Update meta
          const relPath = relative(this.projectRoot, file).replace(/\\/g, '/');
          const content = readFileSync(file, 'utf-8');
          const fileHash = hashContent(content);
          this.meta.setFileHash(relPath, fileHash, chunks.length);
          this.meta.recordChange(relPath, fileHash, 'added');

          chunksCreated += chunks.length;
          filesIndexed++;
        } catch (err) {
          const msg = `Failed to process ${relative(this.projectRoot, file)}: ${String(err)}`;
          errors.push(msg);
          logger.warn('indexer', msg);
        }
      })
    ));

    // Store all chunks in Vectra
    onProgress?.({ phase: 'storing', filesTotal: files.length, filesProcessed: files.length, chunksCreated });
    logger.info('indexer', `Storing ${allChunks.length} chunks in vector store`);

    const storeLimit = pLimit(8);
    await Promise.all(allChunks.map(item =>
      storeLimit(() => this.store.upsert(item.chunk, item.vector))
    ));

    const durationMs = Date.now() - startTime;
    this.meta.setIndexStats(filesIndexed, chunksCreated);

    onProgress?.({ phase: 'done', filesTotal: files.length, filesProcessed: filesIndexed, chunksCreated });
    logger.info('indexer', `Indexing complete`, { filesIndexed, chunksCreated, durationMs });

    return {
      filesScanned: files.length,
      filesIndexed,
      chunksCreated,
      chunksUpdated: 0,
      chunksRemoved: 0,
      errors,
      durationMs,
    };
  }

  /** Incremental index: only re-process files that have changed */
  async indexIncremental(changedFiles?: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let chunksCreated = 0;
    let chunksRemoved = 0;
    let filesIndexed = 0;

    const cfg = this.config.read();
    const maxFileSizeBytes = cfg.indexing.max_file_size_kb * 1024;

    const filesToCheck = changedFiles ?? this.scanFiles();

    for (const file of filesToCheck) {
      const relPath = relative(this.projectRoot, file).replace(/\\/g, '/');

      try {
        if (!existsSync(file)) {
          // File was deleted
          const removed = await this.store.deleteByFile(relPath);
          this.meta.removeFileHash(relPath);
          this.meta.recordChange(relPath, '', 'deleted');
          chunksRemoved += removed;
          continue;
        }

        const content = readFileSync(file, 'utf-8');
        const currentHash = hashContent(content);

        if (!this.meta.hasFileChanged(relPath, currentHash)) continue;

        // File changed — remove old chunks, re-index
        const removed = await this.store.deleteByFile(relPath);
        chunksRemoved += removed;

        const chunks = await this.processFile(file, maxFileSizeBytes);
        if (chunks.length > 0) {
          const vectors = await this.embedder.embedBatch(chunks.map(c => c.envelope_text), 16);
          for (let i = 0; i < chunks.length; i++) {
            await this.store.upsert(chunks[i], vectors[i]);
          }
          chunksCreated += chunks.length;
        }

        this.meta.setFileHash(relPath, currentHash, chunks.length);
        this.meta.recordChange(relPath, currentHash, 'modified');
        filesIndexed++;
      } catch (err) {
        const msg = `Failed to process ${relPath}: ${String(err)}`;
        errors.push(msg);
        logger.warn('indexer', msg);
      }
    }

    const durationMs = Date.now() - startTime;
    if (filesIndexed > 0) {
      const totalChunks = await this.store.count();
      const totalFiles = Object.keys(this.meta.getFileHashes()).length;
      this.meta.setIndexStats(totalFiles, totalChunks);
    }

    logger.info('indexer', `Incremental indexing complete`, { filesIndexed, chunksCreated, chunksRemoved, durationMs });

    return {
      filesScanned: filesToCheck.length,
      filesIndexed,
      chunksCreated,
      chunksUpdated: filesIndexed,
      chunksRemoved,
      errors,
      durationMs,
    };
  }

  private async processFile(absolutePath: string, maxFileSizeBytes: number): Promise<Chunk[]> {
    const relPath = relative(this.projectRoot, absolutePath).replace(/\\/g, '/');
    const ext = '.' + absolutePath.split('.').pop()!.toLowerCase();

    if (!INDEXABLE_EXTENSIONS.has(ext)) return [];

    let content: string;
    try {
      const stat = statSync(absolutePath);
      if (stat.size > maxFileSizeBytes) {
        logger.debug('indexer', `Skipping large file: ${relPath} (${Math.round(stat.size / 1024)}KB)`);
        return [];
      }
      content = readFileSync(absolutePath, 'utf-8');
    } catch {
      return [];
    }

    // Skip binary files (detect by null bytes in first 1KB)
    if (content.slice(0, 1024).includes('\0')) return [];

    const lastModified = statSync(absolutePath).mtime.toISOString();

    return extractChunks({
      filePath: relPath,
      content,
      lastModified,
      minTokens: 20,
      maxTokens: 1000,
    });
  }

  /** Walk project directory and collect all indexable files */
  scanFiles(): string[] {
    const files: string[] = [];
    this.walkDir(this.projectRoot, files);
    return files;
  }

  private walkDir(dir: string, files: string[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      if (this.ignoreFilter.shouldIgnore(fullPath)) continue;

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          this.walkDir(fullPath, files);
        } else if (stat.isFile()) {
          const ext = '.' + entry.split('.').pop()!.toLowerCase();
          if (INDEXABLE_EXTENSIONS.has(ext)) {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip unreadable entries
      }
    }
  }
}
