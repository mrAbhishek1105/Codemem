import { watch, FSWatcher } from 'chokidar';
import { join, relative } from 'path';
import { IgnoreFilter } from '../utils/ignore.js';
import { logger } from '../utils/logger.js';

export type FileChangeHandler = (absolutePath: string, event: 'add' | 'change' | 'unlink') => void;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private ignoreFilter: IgnoreFilter;
  private onChangeHandlers: FileChangeHandler[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
  private batchBuffer: Map<string, { event: 'add' | 'change' | 'unlink'; time: number }> = new Map();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(projectRoot: string, debounceMs = 500) {
    this.projectRoot = projectRoot;
    this.debounceMs = debounceMs;
    this.ignoreFilter = new IgnoreFilter(projectRoot);
  }

  start(): void {
    if (this.watcher) return;

    logger.info('file-watcher', `Starting file watcher for ${this.projectRoot}`);

    this.watcher = watch(this.projectRoot, {
      ignored: (path: string) => this.ignoreFilter.shouldIgnore(path),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    this.watcher
      .on('add', (path) => this.handleChange(path, 'add'))
      .on('change', (path) => this.handleChange(path, 'change'))
      .on('unlink', (path) => this.handleChange(path, 'unlink'))
      .on('error', (err) => logger.error('file-watcher', `Watcher error: ${String(err)}`));

    logger.info('file-watcher', 'File watcher started');
  }

  stop(): void {
    if (!this.watcher) return;
    this.watcher.close().catch(() => {});
    this.watcher = null;

    // Clear all pending timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    logger.info('file-watcher', 'File watcher stopped');
  }

  onFileChange(handler: FileChangeHandler): void {
    this.onChangeHandlers.push(handler);
  }

  private handleChange(absolutePath: string, event: 'add' | 'change' | 'unlink'): void {
    // Debounce per file
    const existing = this.debounceTimers.get(absolutePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(absolutePath);
      this.bufferChange(absolutePath, event);
    }, this.debounceMs);

    this.debounceTimers.set(absolutePath, timer);
  }

  private bufferChange(absolutePath: string, event: 'add' | 'change' | 'unlink'): void {
    this.batchBuffer.set(absolutePath, { event, time: Date.now() });

    // Flush buffer after 1s of inactivity (handles git checkouts, etc.)
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => {
      this.flushBatch();
    }, 1000);
  }

  private flushBatch(): void {
    if (this.batchBuffer.size === 0) return;

    const changes = new Map(this.batchBuffer);
    this.batchBuffer.clear();
    this.batchTimer = null;

    const relPaths = Array.from(changes.keys())
      .map(p => relative(this.projectRoot, p))
      .join(', ');
    logger.info('file-watcher', `Batch of ${changes.size} file changes: ${relPaths.slice(0, 100)}`);

    for (const [absolutePath, { event }] of changes) {
      for (const handler of this.onChangeHandlers) {
        try {
          handler(absolutePath, event);
        } catch (err) {
          logger.error('file-watcher', `Handler error: ${String(err)}`);
        }
      }
    }
  }

  get isRunning(): boolean {
    return this.watcher !== null;
  }

  get pendingChanges(): number {
    return this.batchBuffer.size + this.debounceTimers.size;
  }
}
