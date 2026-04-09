import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

const META_DIR = '.codemem/meta';

export interface FileHashRecord {
  [filePath: string]: {
    hash: string;
    lastIndexed: string;
    chunkCount: number;
  };
}

export interface StatsRecord {
  queries_served: number;
  tokens_saved_total: number;
  chunks_indexed: number;
  files_indexed: number;
  last_indexed: string | null;
  created_at: string;
}

export interface RecentChange {
  file: string;
  hash: string;
  timestamp: string;
  action: 'added' | 'modified' | 'deleted';
}

export class MetaStore {
  private metaDir: string;

  constructor(projectRoot: string) {
    this.metaDir = join(projectRoot, META_DIR);
  }

  private ensureDir(): void {
    if (!existsSync(this.metaDir)) {
      mkdirSync(this.metaDir, { recursive: true });
    }
  }

  private readJson<T>(file: string, defaultValue: T): T {
    const path = join(this.metaDir, file);
    if (!existsSync(path)) return defaultValue;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch {
      return defaultValue;
    }
  }

  private writeJson(file: string, data: unknown): void {
    this.ensureDir();
    writeFileSync(join(this.metaDir, file), JSON.stringify(data, null, 2), 'utf-8');
  }

  // ── File Hashes ──────────────────────────────────────────────────────────

  getFileHashes(): FileHashRecord {
    return this.readJson<FileHashRecord>('file-hashes.json', {});
  }

  setFileHash(filePath: string, hash: string, chunkCount: number): void {
    const hashes = this.getFileHashes();
    hashes[filePath] = { hash, lastIndexed: new Date().toISOString(), chunkCount };
    this.writeJson('file-hashes.json', hashes);
  }

  removeFileHash(filePath: string): void {
    const hashes = this.getFileHashes();
    delete hashes[filePath];
    this.writeJson('file-hashes.json', hashes);
  }

  hasFileChanged(filePath: string, currentHash: string): boolean {
    const hashes = this.getFileHashes();
    const record = hashes[filePath];
    if (!record) return true;
    return record.hash !== currentHash;
  }

  getIndexedFiles(): string[] {
    return Object.keys(this.getFileHashes());
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats(): StatsRecord {
    return this.readJson<StatsRecord>('stats.json', {
      queries_served: 0,
      tokens_saved_total: 0,
      chunks_indexed: 0,
      files_indexed: 0,
      last_indexed: null,
      created_at: new Date().toISOString(),
    });
  }

  incrementQueries(tokensSaved: number): void {
    const stats = this.getStats();
    stats.queries_served++;
    stats.tokens_saved_total += tokensSaved;
    this.writeJson('stats.json', stats);
  }

  setIndexStats(filesIndexed: number, chunksIndexed: number): void {
    const stats = this.getStats();
    stats.files_indexed = filesIndexed;
    stats.chunks_indexed = chunksIndexed;
    stats.last_indexed = new Date().toISOString();
    this.writeJson('stats.json', stats);
  }

  // ── Recent Changes ────────────────────────────────────────────────────────

  getRecentChanges(withinHours = 24): RecentChange[] {
    const changes = this.readJson<RecentChange[]>('recent-changes.json', []);
    const cutoff = Date.now() - withinHours * 60 * 60 * 1000;
    return changes.filter(c => new Date(c.timestamp).getTime() > cutoff);
  }

  recordChange(file: string, hash: string, action: RecentChange['action']): void {
    const changes = this.readJson<RecentChange[]>('recent-changes.json', []);
    // Remove old entries for this file
    const filtered = changes.filter(c => c.file !== file);
    filtered.push({ file, hash, timestamp: new Date().toISOString(), action });
    // Keep last 200 changes
    const trimmed = filtered.slice(-200);
    this.writeJson('recent-changes.json', trimmed);
  }

  // ── Project Summary ───────────────────────────────────────────────────────

  getProjectSummary(): string {
    return this.readJson<{ summary: string }>('project-summary.json', { summary: '' }).summary;
  }

  setProjectSummary(summary: string): void {
    this.writeJson('project-summary.json', { summary, updated: new Date().toISOString() });
  }
}
