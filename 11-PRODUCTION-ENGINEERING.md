# Production Engineering

This document covers everything needed to make CodeMem production-grade:
crash safety, concurrency, security, observability, testing, and distribution.

---

## 1. Multi-Project Isolation

### Strict Context Binding

Every API request and MCP call MUST include project_root.
Reject immediately if missing — never guess.

```typescript
interface QueryRequest {
  project_root: string; // REQUIRED — absolute path
  query: string;
  options?: QueryOptions;
}

// In the HTTP handler:
async function handleQuery(req: FastifyRequest): Promise<QueryResult> {
  const { project_root, query } = req.body as QueryRequest;

  if (!project_root) {
    throw new CodeMemError('PROJECT_ROOT_REQUIRED',
      'project_root is required. Each query must be scoped to a project.');
  }

  if (!existsSync(join(project_root, '.codemem'))) {
    throw new CodeMemError('PROJECT_NOT_INITIALIZED',
      `No .codemem/ found at ${project_root}. Run "codemem init" first.`);
  }

  // Load project-specific stores
  const store = await ProjectStoreManager.get(project_root);
  return store.retriever.query(query, req.body.options);
}
```

### Per-Project Resource Sandbox

Each project gets a completely isolated data directory.
Zero shared mutable state between projects.

```
project-a/.codemem/          project-b/.codemem/
├── db/           ← isolated  ├── db/           ← isolated
├── cache/        ← isolated  ├── cache/        ← isolated
├── meta/         ← isolated  ├── meta/         ← isolated
├── logs/         ← isolated  ├── logs/         ← isolated
└── config.json   ← isolated  └── config.json   ← isolated
```

Only TWO things are shared globally (read-only after download):

```
~/.codemem/
├── models/                  # Embedding model (90MB, downloaded once)
│   └── all-MiniLM-L6-v2/   # Immutable after download
└── bin/                     # ChromaDB binary/venv (immutable)
```

### Project Store Manager

Manages per-project instances with lazy loading and cleanup:

```typescript
class ProjectStoreManager {
  private static stores = new Map<string, ProjectStore>();
  private static MAX_OPEN = 3; // Max concurrent projects

  static async get(projectRoot: string): Promise<ProjectStore> {
    if (this.stores.has(projectRoot)) {
      return this.stores.get(projectRoot)!;
    }

    // Evict LRU if at capacity
    if (this.stores.size >= this.MAX_OPEN) {
      const oldest = this.stores.keys().next().value;
      await this.stores.get(oldest)!.close();
      this.stores.delete(oldest);
    }

    const store = await ProjectStore.open(projectRoot);
    this.stores.set(projectRoot, store);
    return store;
  }
}
```

### File Locking (Prevent DB Corruption)

Use `proper-lockfile` to prevent concurrent writes to the same DB:

```typescript
import lockfile from 'proper-lockfile';

class SafeVectorStore {
  private dbPath: string;

  async write(operation: () => Promise<void>): Promise<void> {
    const release = await lockfile.lock(this.dbPath, {
      retries: {
        retries: 5,
        minTimeout: 100,
        maxTimeout: 1000,
      },
      stale: 10000, // Consider lock stale after 10s (crash recovery)
    });

    try {
      await operation();
    } finally {
      await release();
    }
  }

  async read<T>(operation: () => Promise<T>): Promise<T> {
    // Reads don't need locks — ChromaDB handles read concurrency
    return operation();
  }
}
```

Locking rules:
- Reads: no lock needed (ChromaDB handles concurrent reads)
- Writes (add/update/delete chunks): acquire project-level lock
- Full reindex: acquire lock, hold for duration, release
- Stale lock detection: if lock is >10s old, break it (crash recovery)

---

## 2. Concurrency Control

### Concurrency Pools

Don't let uncontrolled parallelism kill the system.
Different operations have different resource constraints.

```typescript
import pLimit from 'p-limit';

// CPU-bound: embedding generation
// Limit to physical cores - 1 (leave one for queries)
const embeddingPool = pLimit(Math.max(1, os.cpus().length - 1));

// Disk-bound: file reading and indexing
const indexingPool = pLimit(2);

// Network-bound: ChromaDB operations (local, but still I/O)
const dbPool = pLimit(4);

// Usage:
async function indexFiles(files: string[]): Promise<void> {
  await Promise.all(
    files.map(file =>
      indexingPool(async () => {
        const content = await readFile(file);
        const chunks = await chunk(content);
        const embeddings = await embeddingPool(() => embed(chunks));
        await dbPool(() => store.upsert(embeddings));
      })
    )
  );
}
```

### Backpressure & Request Queue

Protect the sidecar from getting overwhelmed:

```typescript
class RequestQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = 0;
  private readonly MAX_CONCURRENT = 5;
  private readonly MAX_QUEUED = 50;

  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.MAX_QUEUED) {
      throw new CodeMemError('SYSTEM_BUSY',
        'Too many pending requests. Please retry in a moment.',
        { retryAfterMs: 2000 }
      );
    }

    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await task()); }
        catch (e) { reject(e); }
      });
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (this.processing < this.MAX_CONCURRENT && this.queue.length > 0) {
      this.processing++;
      const task = this.queue.shift()!;
      task().finally(() => {
        this.processing--;
        this.drain();
      });
    }
  }
}
```

### Indexing Priority

Queries always take priority over background indexing:

```typescript
class PriorityScheduler {
  private indexingPaused = false;

  async query(request: QueryRequest): Promise<QueryResult> {
    // Pause background indexing while serving a query
    this.indexingPaused = true;
    try {
      return await this.retriever.query(request);
    } finally {
      this.indexingPaused = false;
      this.resumeIndexing();
    }
  }

  async indexFile(path: string): Promise<void> {
    // Check if we should yield to a query
    if (this.indexingPaused) {
      await this.waitForResume();
    }
    await this.doIndex(path);
  }
}
```

---

## 3. Crash Safety & Recovery

### Write-Ahead Logging (WAL)

Before modifying the DB, log the intended operation.
If we crash, we can replay or rollback on restart.

```typescript
interface WALEntry {
  id: string;
  timestamp: string;
  operation: 'add' | 'update' | 'delete';
  chunk_id: string;
  data?: ChunkEnvelope;   // For add/update
  status: 'pending' | 'committed' | 'rolled_back';
}

class WriteAheadLog {
  private logPath: string; // .codemem/logs/wal.jsonl

  async logOperation(entry: Omit<WALEntry, 'id' | 'timestamp' | 'status'>): Promise<string> {
    const walEntry: WALEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      status: 'pending',
      ...entry,
    };

    // Append to WAL (atomic via appendFileSync + fsync)
    appendFileSync(this.logPath,
      JSON.stringify(walEntry) + '\n',
      { flag: 'a' }
    );
    fsyncSync(openSync(this.logPath, 'r'));

    return walEntry.id;
  }

  async markCommitted(id: string): Promise<void> {
    // Update status in WAL
    await this.updateEntry(id, 'committed');
  }

  async recoverPendingOperations(): Promise<WALEntry[]> {
    // On startup: find all 'pending' entries
    const entries = await this.readAll();
    return entries.filter(e => e.status === 'pending');
  }
}
```

### Atomic Writes

Never write directly to the final file. Write to temp, then rename.
Rename is atomic on all major filesystems.

```typescript
async function atomicWrite(targetPath: string, data: string): Promise<void> {
  const tempPath = targetPath + '.tmp.' + randomUUID().slice(0, 8);

  try {
    await writeFile(tempPath, data, 'utf-8');
    await fsync(tempPath);           // Ensure data is on disk
    await rename(tempPath, targetPath); // Atomic rename
  } catch (error) {
    // Clean up temp file if anything failed
    try { await unlink(tempPath); } catch {}
    throw error;
  }
}

// Usage for metadata files:
await atomicWrite(
  '.codemem/meta/file-hashes.json',
  JSON.stringify(fileHashes, null, 2)
);
```

### Startup Recovery

On every startup, check for incomplete operations:

```typescript
class StartupRecovery {
  async run(): Promise<RecoveryReport> {
    const report: RecoveryReport = { actions: [] };

    // 1. Check for .tmp files (interrupted atomic writes)
    const tmpFiles = await glob('.codemem/**/*.tmp.*');
    for (const tmp of tmpFiles) {
      await unlink(tmp);
      report.actions.push({ type: 'cleaned_temp', file: tmp });
    }

    // 2. Check WAL for pending operations
    const wal = new WriteAheadLog();
    const pending = await wal.recoverPendingOperations();
    for (const entry of pending) {
      if (entry.operation === 'add' || entry.operation === 'update') {
        // Re-apply the operation
        await this.reapply(entry);
        await wal.markCommitted(entry.id);
        report.actions.push({ type: 'replayed', chunk: entry.chunk_id });
      } else if (entry.operation === 'delete') {
        // Safe to re-delete (idempotent)
        await this.store.delete(entry.chunk_id);
        await wal.markCommitted(entry.id);
      }
    }

    // 3. Verify DB integrity
    const integrityOk = await this.store.verifyIntegrity();
    if (!integrityOk) {
      report.actions.push({ type: 'integrity_failed' });
      report.needsFullReindex = true;
    }

    // 4. Compact WAL (remove committed entries)
    await wal.compact();

    return report;
  }
}
```

### The `codemem repair` Command

```
$ codemem repair

  Running diagnostics...

  ✓ WAL check: 0 pending operations
  ✓ Temp files: 0 orphaned files cleaned
  ✓ DB integrity: passed
  ✓ File hash consistency: 3 mismatches found

  Repairing...
  ✓ Re-indexed 3 files with stale hashes
  ✓ Rebuilt dependency graph
  ✓ Compacted WAL log

  All repairs complete. Index is healthy.
```

If repair can't fix the DB:

```
$ codemem repair

  Running diagnostics...
  ✗ DB integrity: FAILED (corrupted index)

  The vector database is corrupted. Options:
    1. Run `codemem reindex` to rebuild from source files
    2. Run `codemem clean && codemem init` for full reset

  Your source code is NOT affected — only the index is damaged.
```

---

## 4. Performance SLAs

### Target Metrics

| Metric | Target | Hard Limit |
|--------|--------|------------|
| Query latency (p50) | < 80ms | < 150ms |
| Query latency (p99) | < 150ms | < 500ms |
| Index 1000 files | < 5s | < 15s |
| Incremental update | < 100ms | < 500ms |
| Cold start (model load) | < 3s | < 8s |
| Memory usage (idle) | < 200MB | < 500MB |
| Memory usage (indexing) | < 400MB | < 800MB |
| Disk usage per 1k files | < 50MB | < 100MB |

### Multi-Layer Cache

```typescript
class CacheStack {
  // Layer 1: Query results (LRU, most impactful)
  private queryCache = new LRUCache<string, QueryResult>({
    max: 100,
    ttl: 5 * 60 * 1000, // 5 min TTL
  });

  // Layer 2: Embedding cache (hash-based, avoids re-embedding)
  private embeddingCache = new LRUCache<string, Float32Array>({
    max: 500,
    ttl: 30 * 60 * 1000, // 30 min TTL
  });

  // Layer 3: File content hash cache (skip unchanged files)
  private hashCache = new Map<string, string>();

  async query(queryText: string, projectRoot: string): Promise<QueryResult> {
    // Layer 1: Check query cache
    const cacheKey = this.queryKey(queryText, projectRoot);
    const cached = this.queryCache.get(cacheKey);
    if (cached) {
      cached._fromCache = true;
      return cached;
    }

    // Layer 2: Check embedding cache
    const embKey = hashString(queryText);
    let queryEmbedding = this.embeddingCache.get(embKey);
    if (!queryEmbedding) {
      queryEmbedding = await this.embedder.embed(queryText);
      this.embeddingCache.set(embKey, queryEmbedding);
    }

    // Execute search with cached embedding
    const result = await this.retriever.search(queryEmbedding);
    this.queryCache.set(cacheKey, result);
    return result;
  }

  // Invalidation: any file change clears query cache
  onFileChange(): void {
    this.queryCache.clear();
    // Embedding cache survives (embeddings don't change)
    // Hash cache is updated per-file
  }

  private queryKey(query: string, root: string): string {
    return hashString(`${root}:${query}`);
  }
}
```

### Cold Start Optimization

```typescript
class SidecarLifecycle {
  async startup(): Promise<void> {
    const t0 = performance.now();

    // Phase 1: Start HTTP server immediately (accept connections)
    await this.startServer(); // < 50ms
    // Server responds with 503 "warming up" until ready

    // Phase 2: Load embedding model (heaviest step)
    await this.embedder.load(); // ~2-3s
    await this.embedder.warmup('warmup query'); // ~100ms JIT

    // Phase 3: Load in-memory indices
    await Promise.all([
      this.loadInvertedIndex(),   // BM25 index
      this.loadDependencyGraph(), // Dep graph
      this.loadFileHashes(),      // Hash cache
    ]); // ~200ms total

    // Phase 4: Run startup recovery
    await this.recovery.run(); // ~100ms

    // Phase 5: Start file watcher
    await this.fileWatcher.start(); // ~50ms

    // Server now responds normally
    this.setReady(true);

    const elapsed = performance.now() - t0;
    this.logger.info(`Startup complete in ${elapsed.toFixed(0)}ms`);
  }
}
```

---

## 5. Security & Privacy

### Local-Only Guarantee

```typescript
// HARD RULE: No outbound network calls except model download
const ALLOWED_OUTBOUND = [
  'huggingface.co',  // Model download (first run only)
];

// Verified by:
// 1. No HTTP client libraries except for model download
// 2. ChromaDB runs on localhost only
// 3. Sidecar listens on 127.0.0.1 only (not 0.0.0.0)
// 4. No telemetry, no analytics, no crash reporting

server.listen({
  host: '127.0.0.1', // NOT 0.0.0.0 — localhost only
  port: config.port,
});
```

### Secrets Protection

Default `.codememignore` includes all sensitive file patterns:

```gitignore
# Secrets — NEVER index these
.env
.env.*
*.key
*.pem
*.p12
*.pfx
*.jks
secrets.json
secrets.yaml
**/credentials/**
**/secrets/**
**/.aws/**
**/.ssh/**
**/id_rsa*
*.secret
vault.json
```

Additionally, the chunker scans for secret-like patterns and skips them:

```typescript
const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*['"][^'"]{8,}/i,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,           // AWS access keys
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /ghp_[a-zA-Z0-9]{36}/,                  // GitHub tokens
  /sk-[a-zA-Z0-9]{32,}/,                  // API keys
];

function containsSecret(content: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(content));
}

// In chunker:
if (containsSecret(chunk.code)) {
  logger.warn(`Skipping chunk with detected secret: ${chunk.id}`);
  continue; // Skip this chunk entirely
}
```

### Sandbox Rules

The sidecar process:
- READS files (for indexing) — never writes to source code
- WRITES only to .codemem/ directory — its own sandbox
- NEVER executes code from the project — parse only
- NEVER opens network connections (except localhost)
- Runs as the user's own process — no elevated privileges

---

## 6. Observability

### Structured Logging

```typescript
// All logs go to .codemem/logs/ (per-project)
// Format: structured JSON lines

interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;      // 'indexer' | 'retriever' | 'watcher' | 'server'
  message: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
}

// Log files:
// .codemem/logs/codemem.log      — main log (all levels)
// .codemem/logs/queries.log      — query log (query text, results, timing)
// .codemem/logs/errors.log       — errors only
```

### Query Log (Performance Tracking)

```typescript
// Every query is logged with full timing breakdown:
{
  "timestamp": "2025-03-28T14:23:01.234Z",
  "query": "fix the login validation",
  "timing": {
    "embed_ms": 12,
    "vector_search_ms": 28,
    "bm25_scoring_ms": 8,
    "recency_scoring_ms": 1,
    "dep_expansion_ms": 15,
    "context_assembly_ms": 6,
    "total_ms": 70
  },
  "results": {
    "candidates_searched": 12340,
    "chunks_returned": 6,
    "tokens_in_context": 2100,
    "tokens_saved_estimate": 49900,
    "cache_hit": false
  }
}
```

### `codemem stats` (Expanded)

```
$ codemem stats

  Performance Summary
  ──────────────────────────────────

  Token Savings
    Today            184,000 tokens saved (23 queries)
    This week        1,240,000 tokens (~$1.86 saved)
    All time         42,000,000 tokens (~$63.00 saved)

  Latency
    p50              68ms
    p95              142ms
    p99              198ms
    Cache hit rate   34%

  Index Health
    Files tracked    847
    Total chunks     12,340
    DB size          25.4 MB
    Last reindex     2h ago (incremental, 3 files)

  By AI Provider
    Claude           2,100 queries   $31.50 saved
    GPT-4o           1,800 queries   $27.00 saved
    Gemini           330 queries     $4.50 saved
```

### Debug Mode

```
$ codemem query --debug "fix login validation"

  Query: "fix login validation"

  Embedding: 384-dim vector generated in 11ms

  Vector search: 20 candidates in 26ms
    1. src/auth/login.ts::validateCredentials     cos=0.94
    2. src/routes/auth.ts::loginHandler            cos=0.87
    3. src/auth/register.ts::validateEmail         cos=0.82
    ...

  Hybrid ranking (semantic 0.55 + keyword 0.30 + recency 0.15):
    1. src/auth/login.ts::validateCredentials     final=0.91 ★
    2. src/routes/auth.ts::loginHandler            final=0.82
    3. src/components/SignupForm.tsx::SignupForm    final=0.74
    4. src/types/auth.ts::AuthResult               final=0.68 (dependency)
    5. src/middleware/auth.ts::authMiddleware       final=0.65
    6. src/utils/crypto.ts::hash                   final=0.61 (dependency)

  Context assembled: 2,100 tokens (budget: 4,000)
  Total time: 72ms

  Estimated tokens saved: 49,900 (vs full codebase read)
```

---

## 7. Retrieval Quality Enhancements

### Query Intent Detection

Different queries need different retrieval strategies:

```typescript
type QueryIntent = 'bug_fix' | 'feature' | 'architecture' | 'refactor' | 'understand';

function detectIntent(query: string): QueryIntent {
  const q = query.toLowerCase();

  if (/fix|bug|error|broken|crash|fail|issue|wrong/.test(q)) return 'bug_fix';
  if (/add|create|implement|build|new feature/.test(q)) return 'feature';
  if (/architect|design|structure|organize|pattern/.test(q)) return 'architecture';
  if (/refactor|clean|simplify|optimize|improve/.test(q)) return 'refactor';
  return 'understand';
}

// Adjust retrieval based on intent:
function getRetrievalConfig(intent: QueryIntent): RetrievalConfig {
  switch (intent) {
    case 'bug_fix':
      return {
        top_k: 5,               // Tight, focused context
        recency_weight: 0.25,   // Boost recent files (likely where bug was introduced)
        token_budget: 3000,     // Less context, more focused
        include_tests: true,    // Include related tests
      };
    case 'architecture':
      return {
        top_k: 10,              // Broader view
        recency_weight: 0.05,   // Recency doesn't matter for architecture
        token_budget: 5000,     // More context needed
        include_tests: false,
      };
    case 'feature':
      return {
        top_k: 8,
        recency_weight: 0.15,
        token_budget: 4000,
        include_tests: false,
      };
    default:
      return DEFAULT_RETRIEVAL_CONFIG;
  }
}
```

### Context Modes (User-Facing)

```
# Debug mode: tight context, recent files, include error paths
codemem ask --mode=debug "login throws null pointer"

# Architecture mode: broad context, dependency maps, patterns
codemem ask --mode=architecture "how does the auth system work"

# Default: balanced
codemem ask "add password reset feature"
```

### Feedback Loop

Store query feedback to improve ranking over time:

```typescript
// After AI generates a response, user can rate it:
// Stored in .codemem/meta/feedback.jsonl

interface FeedbackEntry {
  timestamp: string;
  query: string;
  chunks_returned: string[];   // chunk IDs
  rating: 'good' | 'bad';
  context?: string;            // Optional user note
}

// CLI:
// codemem feedback --good   (last query was helpful)
// codemem feedback --bad    (last query missed relevant code)

// Future: use feedback to learn query-specific weight adjustments
// For MVP: just store the data for manual analysis
```

---

## 8. Testing Strategy

### Test Structure

```
tests/
├── unit/
│   ├── chunker.test.ts           # AST chunking correctness
│   ├── chunk-envelope.test.ts    # Envelope format validation
│   ├── keyword-index.test.ts     # BM25 scoring accuracy
│   ├── retriever.test.ts         # Hybrid ranking
│   ├── context-assembler.test.ts # Output format, token budget
│   ├── file-watcher.test.ts      # Change detection
│   ├── wal.test.ts               # Write-ahead log
│   ├── secret-detector.test.ts   # Secret pattern matching
│   └── query-cache.test.ts       # Cache behavior, invalidation
│
├── integration/
│   ├── full-index-flow.test.ts   # Init → index → query → verify
│   ├── incremental-update.test.ts # File change → re-index → query
│   ├── crash-recovery.test.ts    # Kill during index → restart → verify
│   ├── mcp-server.test.ts        # MCP protocol compliance
│   ├── concurrent-access.test.ts # Multiple queries + indexing
│   └── project-isolation.test.ts # Two projects, verify no cross-talk
│
├── performance/
│   ├── indexing-benchmark.ts     # Measure index speed (target: 1k files < 5s)
│   ├── query-latency.ts         # Measure query p50/p95/p99
│   ├── memory-usage.ts          # Track RSS during operations
│   └── cache-effectiveness.ts   # Measure cache hit rates
│
├── fixtures/
│   ├── sample-typescript/        # ~50 files, React + Express
│   ├── sample-python/            # ~30 files, Django
│   ├── sample-large/             # ~500 files, monorepo-style
│   ├── sample-with-secrets/      # Files containing fake secrets
│   └── expected-chunks/          # Golden-file expected outputs
│
└── real-world/
    ├── README.md                 # Instructions for running on real repos
    └── repos.json               # List of open-source repos to test against
```

### Critical Test Cases

```typescript
// 1. Chunking correctness
test('splits TypeScript file into function-level chunks', async () => {
  const file = readFixture('sample-typescript/src/auth.ts');
  const chunks = await chunker.chunk(file, 'typescript');

  expect(chunks).toHaveLength(4); // 4 functions in the file
  expect(chunks[0].header.name).toBe('validateCredentials');
  expect(chunks[0].header.type).toBe('function');
  expect(chunks[0].header.file_path).toBe('src/auth.ts');
  expect(chunks[0].header.description).toContain('validate'); // Auto-generated
});

// 2. Secret detection
test('skips chunks containing API keys', async () => {
  const file = 'const API_KEY = "sk-1234567890abcdef1234567890abcdef";';
  const chunks = await chunker.chunk(file, 'typescript');
  expect(chunks).toHaveLength(0); // Skipped!
});

// 3. Crash recovery
test('recovers from crash during indexing', async () => {
  // Start indexing, kill after 50% complete
  const indexPromise = indexer.index(projectRoot);
  await wait(500); // Let it get partway
  process.kill(process.pid, 'SIGKILL'); // Simulate crash

  // Restart and verify
  const recovery = new StartupRecovery();
  const report = await recovery.run();
  expect(report.actions.some(a => a.type === 'replayed')).toBe(true);

  // Index should be usable (maybe incomplete but not corrupt)
  const result = await retriever.query('auth');
  expect(result.chunks.length).toBeGreaterThan(0);
});

// 4. Project isolation
test('queries never return chunks from other projects', async () => {
  await indexer.index('/project-a');
  await indexer.index('/project-b');

  const result = await retriever.query('auth', { project_root: '/project-a' });
  for (const chunk of result.chunks) {
    expect(chunk.file_path).not.toContain('project-b');
  }
});

// 5. Performance SLA
test('query latency stays under 150ms', async () => {
  await indexer.index(largeFixture); // 500 files

  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await retriever.query(randomQuery());
    times.push(performance.now() - start);
  }

  const p99 = percentile(times, 99);
  expect(p99).toBeLessThan(150);
});
```

---

## 9. Distribution & Updates

### npm Package

```json
{
  "name": "codemem",
  "bin": {
    "codemem": "./dist/cli.js"
  },
  "files": [
    "dist/",
    "adapters/"
  ],
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### Auto-Update Check

```typescript
// On startup, check npm registry (non-blocking, no telemetry):
async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch('https://registry.npmjs.org/codemem/latest',
      { signal: AbortSignal.timeout(2000) } // 2s timeout
    );
    const { version: latest } = await res.json();
    if (semver.gt(latest, CURRENT_VERSION)) {
      logger.info(`Update available: ${CURRENT_VERSION} → ${latest}`);
      // Show in status command, don't auto-install
    }
  } catch {
    // Silently fail — never block startup for update check
  }
}
```

### Schema Versioning

```json
// .codemem/config.json
{
  "schema_version": 2,
  "codemem_version": "1.2.0",
  ...
}
```

On startup, if `schema_version` is older than current:

```typescript
async function migrateSchema(current: number, target: number): Promise<void> {
  const migrations: Record<number, () => Promise<void>> = {
    2: async () => {
      // v1 → v2: Added keyword index
      await buildInvertedIndex();
    },
    3: async () => {
      // v2 → v3: Added feedback storage
      await mkdirp('.codemem/meta/feedback/');
    },
  };

  for (let v = current + 1; v <= target; v++) {
    if (migrations[v]) {
      logger.info(`Running migration v${v - 1} → v${v}`);
      await migrations[v]();
    }
  }

  await updateConfig({ schema_version: target });
}
```

### `codemem upgrade`

```
$ codemem upgrade

  Current version: 1.1.0
  Latest version:  1.2.0

  Changelog:
    • Hybrid retrieval with BM25 keyword scoring
    • Query intent detection (debug/architecture/feature modes)
    • Feedback loop (codemem feedback --good/--bad)
    • Performance: 30% faster indexing

  Upgrade? (y/N): y

  ✓ Updated codemem to 1.2.0
  ✓ Running schema migration v1 → v2
  ✓ Rebuilding keyword index (one-time)
  ✓ Done! No re-indexing needed.
```

---

## 10. Adoption & Viral Features

### The `codemem stats` Viral Loop

This is the single most important feature for organic growth.
When a developer sees "saved 1.2M tokens ($18.00)", they screenshot and share.

```typescript
// Track on every query:
interface QueryStats {
  tokens_in_context: number;      // What we actually sent
  tokens_full_read_estimate: number; // What full codebase read would cost
  tokens_saved: number;           // Difference
  cost_saved_usd: number;         // Based on AI provider rates
}

// Cost estimation per provider:
const COST_PER_1M_INPUT_TOKENS: Record<string, number> = {
  'claude-sonnet':  3.00,
  'claude-opus':    15.00,
  'gpt-4o':         2.50,
  'gpt-4-turbo':    10.00,
  'gemini-pro':     1.25,
};
```

### Git Integration (Commit Awareness)

```typescript
// On git operations, trigger smart re-indexing:
fileWatcher.on('gitEvent', async (event) => {
  switch (event.type) {
    case 'checkout':
    case 'pull':
    case 'merge':
      // Many files changed — batch reindex with debounce
      await indexer.batchReindex(event.changedFiles, { debounceMs: 2000 });
      break;
    case 'commit':
      // Store commit info for change history
      await metaStore.recordCommit({
        hash: event.hash,
        message: event.message,
        files: event.changedFiles,
        timestamp: new Date(),
      });
      break;
  }
});
```

### Zero-Config Promise

The `init` command must NEVER ask the user to make decisions.
Every setting has a sensible default. Configuration is for power users only.

```typescript
// WRONG:
// "Which embedding model would you like to use? (1) MiniLM (2) Nomic..."
// "What token budget? [4000]:"
// "Include test files? (y/N):"

// RIGHT:
// "✓ Detected TypeScript/React project"
// "✓ Indexed 847 files in 12s"
// "✓ Ready!"

// Settings exist in codemem config — but init never asks.
```
