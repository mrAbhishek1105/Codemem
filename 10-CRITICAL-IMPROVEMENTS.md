# Critical Improvements — Deep Dive

This document supersedes the weaker sections of docs 03 and 07.
These 5 areas make or break the system quality.

---

## 1. Chunking Strategy (MOST IMPORTANT)

The entire retrieval quality depends on what goes INTO each chunk.
Bad chunks = irrelevant results = useless tool.

### The Problem with Naive Chunking

```
WRONG — Naive approach:
  Split every 500 tokens, no matter where
  → Cuts functions in half
  → Loses context (what file? what class?)
  → Embedding model sees meaningless fragments

WRONG — File-level chunking:
  One chunk = one file
  → Too large for small queries
  → Embedding captures average meaning, not specific functions
  → Wastes tokens returning irrelevant code in the same file
```

### The Correct Approach: Semantic + Structural Chunking

Parse the AST (Abstract Syntax Tree) and split at **meaningful boundaries**:
functions, classes, interfaces, type blocks, module-level constants.

But the key insight is: **what you embed is NOT just the code.**
You embed an **enriched envelope** that gives the embedding model context.

### Enriched Chunk Envelope Format

This is what actually gets embedded (sent to the embedding model):

```
// File: src/auth/login.ts
// Language: TypeScript
// Type: async function
// Name: validateCredentials
// Exports: yes (named export)
// Description: Validates user email and password against database,
//              returns AuthResult with JWT token on success.
// Imports: AuthResult from ../types, hash from ../utils/crypto
// Called by: loginHandler (src/routes/auth.ts)

async function validateCredentials(
  email: string,
  password: string
): Promise<AuthResult> {
  const user = await findByEmail(email);
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  const valid = await hash.compare(password, user.passwordHash);
  if (!valid) {
    return { success: false, error: 'Invalid password' };
  }
  const token = generateJWT({ userId: user.id, role: user.role });
  return { success: true, error: null, token };
}
```

### Why This Works

The embedding model now captures:
- WHERE the code lives (file path → matches queries about "auth" or "login")
- WHAT it does (description → matches natural language queries)
- HOW it connects (imports/exports → matches dependency queries)
- WHO calls it (called_by → matches flow-tracing queries)

A query like "fix the login bug" now matches on:
- "login" in the file path
- "login" in the function name
- "validates user email and password" in the description
- The actual code logic

### Chunk Envelope Schema

```typescript
interface ChunkEnvelope {
  // Header (embedded WITH the code for better retrieval)
  header: {
    file_path: string;         // "src/auth/login.ts"
    language: string;          // "typescript"
    type: string;              // "function" | "class" | "interface" | "type" | "constant"
    name: string;              // "validateCredentials"
    exported: boolean;         // true
    description: string;       // Auto-generated from JSDoc, comments, or code analysis
    imports: string[];         // ["AuthResult from ../types"]
    called_by: string[];       // ["loginHandler (src/routes/auth.ts)"]
    calls: string[];           // ["findByEmail", "hash.compare", "generateJWT"]
  };

  // Body (the actual code)
  code: string;

  // Metadata (stored in DB, NOT embedded — used for filtering)
  metadata: {
    chunk_id: string;          // "src/auth/login.ts::validateCredentials"
    start_line: number;
    end_line: number;
    token_count: number;
    content_hash: string;
    last_modified: string;     // ISO timestamp
    complexity_score: number;  // Simple cyclomatic complexity estimate
  };
}
```

### Auto-Description Generation

The "description" field is critical — it bridges natural language queries
to code. Generate it from (in priority order):

1. **JSDoc/docstring** — if present, use it directly
2. **Comments above the function** — extract and clean
3. **Function signature analysis** — infer from name + params + return type
   - `validateCredentials(email, password) → AuthResult`
   - Auto-generates: "Validates credentials using email and password,
     returns an AuthResult"
4. **First-line summary** — if function is simple, first statement describes it

### Chunk Size Rules (Revised)

| Scenario | Action |
|----------|--------|
| Function < 50 tokens | Skip (too trivial — getters, one-liners) |
| Function 50-800 tokens | One chunk (ideal range) |
| Function 800-1500 tokens | One chunk but flag as "large" |
| Function > 1500 tokens | Split at logical breakpoints (see below) |
| Class with methods | Class header = one chunk, each method = separate chunk |
| File with no functions | Chunk at blank-line boundaries (config files, etc.) |
| Import block | Separate chunk (important for dependency queries) |

### Splitting Large Functions

When a function exceeds 1500 tokens, split at these boundaries
(in priority order):

1. Major conditional branches (`if/else if/else` blocks)
2. Try/catch boundaries
3. Loop bodies (when the loop is a major section)
4. Comment-delimited sections ("// Step 1:", "// Handle errors:")
5. Blank lines separating logical blocks

Each sub-chunk inherits the parent's header and adds:
```
// [Part 2/3] — Error handling branch
```

---

## 2. Hybrid Retrieval Ranking

Cosine similarity alone misses too much. When a developer queries
"findByEmail function", pure semantic search might return conceptually
similar functions instead of the exact one.

### Three-Signal Scoring

```typescript
interface ScoringSignals {
  semantic: number;    // 0.0 - 1.0  (embedding cosine similarity)
  keyword: number;     // 0.0 - 1.0  (BM25-lite exact term matching)
  recency: number;     // 0.0 - 1.0  (time-based decay)
}

// Final score formula:
final_score =
    (semantic * W_SEMANTIC)   // default: 0.55
  + (keyword  * W_KEYWORD)    // default: 0.30
  + (recency  * W_RECENCY)    // default: 0.15
```

### Signal 1: Semantic Similarity (Weight: 0.55)

Standard cosine similarity between query embedding and chunk embeddings.
This catches conceptual matches — "authentication flow" finds login code
even without the word "login" in the query.

```
Query: "how does user authentication work"
Matches: validateCredentials (0.91), authMiddleware (0.87), SessionStore (0.73)
```

### Signal 2: Keyword Match — BM25-Lite (Weight: 0.30)

Simple term-frequency scoring on the chunk's text content.
This catches exact matches that embeddings might rank lower.

```typescript
function bm25Lite(query: string, chunkText: string): number {
  const queryTerms = tokenize(query.toLowerCase());
  const docTerms = tokenize(chunkText.toLowerCase());
  const docLength = docTerms.length;
  const avgDocLength = 300; // approximate average chunk size in tokens
  const k1 = 1.2;
  const b = 0.75;

  let score = 0;
  for (const term of queryTerms) {
    const tf = docTerms.filter(t => t === term).length;
    const idf = Math.log(1 + (totalChunks - docFreq(term) + 0.5)
                            / (docFreq(term) + 0.5));
    const tfNorm = (tf * (k1 + 1))
                 / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
    score += idf * tfNorm;
  }
  return normalize(score); // scale to 0.0 - 1.0
}
```

Why this matters:
```
Query: "findByEmail"
Semantic search: might return findByUsername (0.92) — semantically similar!
BM25 keyword:    findByEmail (1.0) — exact match wins
Hybrid result:   findByEmail ranks first ✓
```

### Signal 3: Recency Boost (Weight: 0.15)

Files modified recently are more likely relevant to the current task.

```typescript
function recencyScore(lastModified: Date): number {
  const hoursAgo = (Date.now() - lastModified.getTime()) / (1000 * 60 * 60);

  if (hoursAgo < 1)   return 1.0;   // Modified in last hour
  if (hoursAgo < 4)   return 0.9;   // Last 4 hours
  if (hoursAgo < 24)  return 0.7;   // Today
  if (hoursAgo < 72)  return 0.4;   // Last 3 days
  if (hoursAgo < 168) return 0.2;   // Last week
  return 0.0;                        // Older — no boost
}
```

### Retrieval Pipeline

```
User query: "fix the login validation"
    │
    ▼
Step 1: Generate query embedding
    │   embed("fix the login validation") → vector[384]
    │
    ▼
Step 2: Vector search (top 20 candidates)
    │   ChromaDB.query(vector, n=20)
    │   Returns 20 chunks with cosine scores
    │
    ▼
Step 3: Keyword scoring (on same 20 candidates)
    │   BM25-lite("fix login validation", chunk.text) for each
    │
    ▼
Step 4: Recency scoring
    │   recencyScore(chunk.last_modified) for each
    │
    ▼
Step 5: Weighted combination
    │   final = 0.55*semantic + 0.30*keyword + 0.15*recency
    │
    ▼
Step 6: Sort by final score, take top K (default: 5-8)
    │
    ▼
Step 7: Dependency expansion on top K
    │   Pull in types, callers, callees
    │
    ▼
Output: 5-12 chunks ranked by hybrid relevance
```

### Why K=5-8 (Not K=10-20)

Fewer, more relevant chunks beat many mediocre chunks:
- K=5: tight, focused context — best for specific bugs/features
- K=8: broader context — good for architectural questions
- K=15+: diminishing returns, wastes tokens on noise

Default: K=6. Configurable per query via `max_results` parameter.

---

## 3. Structured Context Assembly (Secret Weapon)

This is where CodeMem can beat every competitor. Instead of dumping
raw chunks at the AI, build a **narrative context** that helps the AI
understand the codebase topology.

### Old Output (Bad — just chunks dumped)

```
--- src/auth/login.ts ---
async function validateCredentials(...) { ... }

--- src/routes/auth.ts ---
app.post('/login', loginHandler);

--- src/middleware/auth.ts ---
function authMiddleware(req, res, next) { ... }
```

### New Output (Good — structured with flow)

```
## Project: my-saas-app (TypeScript, React + Express, PostgreSQL)

### Query context: "fix the login validation"

### Relevant files (ranked by relevance):
1. src/auth/login.ts → Core login logic, validates credentials
2. src/routes/auth.ts → Express route handler, calls login logic
3. src/middleware/auth.ts → JWT verification middleware
4. src/types/auth.ts → TypeScript interfaces (AuthResult, User)

### Call flow:
  POST /api/login
    → routes/auth.ts::loginHandler
      → auth/login.ts::validateCredentials
        → db/users.ts::findByEmail
        → utils/crypto.ts::hash.compare
      → auth/login.ts::generateJWT
    → Response: { token, user }

  Subsequent requests:
    → middleware/auth.ts::authMiddleware (verifies JWT)

### Code:

--- src/auth/login.ts (lines 24-45) [relevance: 0.94] ---
async function validateCredentials(
  email: string,
  password: string
): Promise<AuthResult> {
  const user = await findByEmail(email);
  if (!user) return { success: false, error: 'User not found' };
  const valid = await hash.compare(password, user.passwordHash);
  return { success: valid, error: valid ? null : 'Invalid password' };
}

--- src/routes/auth.ts (lines 12-28) [relevance: 0.87] ---
// ... route handler code ...

--- src/types/auth.ts (dependency) ---
export interface AuthResult {
  success: boolean;
  error: string | null;
  token?: string;
}

### Recent changes (last 24h):
- src/auth/login.ts: Added rate limiting to validateCredentials
- src/components/SignupForm.tsx: Added client-side email validation

### Co-change warning:
  src/auth/login.ts and src/tests/auth.test.ts change together 92% of the time.
  Consider updating tests if modifying login logic.
```

### Why This Is a Secret Weapon

1. **File summary at top** — AI knows what each file does BEFORE reading code
2. **Call flow map** — AI understands HOW the pieces connect (saves inference)
3. **Relevance scores** — AI knows which files to focus on vs skim
4. **Co-change warnings** — AI proactively updates related files
5. **Fewer tokens, better answers** — structured context < raw code dump

### Context Assembly Algorithm (Revised)

```typescript
async function assembleContext(
  query: string,
  rankedChunks: RankedChunk[],
  config: RetrievalConfig
): Promise<AssembledContext> {

  // 1. Generate project header (~100 tokens)
  const projectHeader = await getProjectSummary();

  // 2. Build file relevance summary (~50 tokens)
  const fileSummary = rankedChunks
    .reduce(groupByFile)
    .map(f => `${f.rank}. ${f.path} → ${f.description}`)
    .join('\n');

  // 3. Build call flow (if chunks have caller/callee data) (~80 tokens)
  const callFlow = buildCallFlowFromDependencyGraph(rankedChunks);

  // 4. Format code chunks with headers (~variable tokens)
  const codeBlocks = rankedChunks.map(chunk => ({
    header: `--- ${chunk.file_path} (lines ${chunk.start}-${chunk.end}) [relevance: ${chunk.score}] ---`,
    code: chunk.code,
    tokens: countTokens(chunk.code)
  }));

  // 5. Fit within token budget
  let totalTokens = countTokens(projectHeader + fileSummary + callFlow);
  const includedBlocks = [];
  for (const block of codeBlocks) {
    if (totalTokens + block.tokens > config.tokenBudget) break;
    includedBlocks.push(block);
    totalTokens += block.tokens;
  }

  // 6. Add recent changes (~50 tokens)
  const recentChanges = await getRecentChanges(24); // last 24h

  // 7. Add co-change warnings (~30 tokens)
  const coChangeWarnings = await getCoChangeWarnings(rankedChunks);

  return {
    text: formatFinalOutput(
      projectHeader,
      fileSummary,
      callFlow,
      includedBlocks,
      recentChanges,
      coChangeWarnings
    ),
    tokenCount: totalTokens,
    chunksIncluded: includedBlocks.length,
    chunksTotal: rankedChunks.length
  };
}
```

---

## 4. Latency Optimization

Target: **< 200ms** for the full query pipeline (not including AI response).

### Latency Budget

| Step | Target | Strategy |
|------|--------|----------|
| Query embedding | < 15ms | Model preloaded in RAM on startup |
| Vector search | < 30ms | ChromaDB with HNSW index, K=6 |
| BM25 scoring | < 10ms | Pre-built inverted index in memory |
| Recency scoring | < 1ms | In-memory file modification cache |
| Dependency expansion | < 20ms | Pre-built graph in memory |
| Context assembly | < 10ms | String concatenation, no re-parsing |
| **Total** | **< 100ms** | Leaves 100ms headroom |

### Optimization Strategies

#### 1. Model Preloading
```typescript
// On sidecar startup — load model into RAM
class Embedder {
  private session: ort.InferenceSession;

  async warmup() {
    // Load ONNX model into memory (~90MB, takes ~2s)
    this.session = await ort.InferenceSession.create(MODEL_PATH);
    // Run a dummy inference to warm up (JIT compilation)
    await this.embed("warmup query");
    // Model is now hot — subsequent embeddings take ~10ms
  }
}
```

#### 2. Query Cache (LRU)
```typescript
// Cache recent query results (last 100 queries)
const queryCache = new LRUCache<string, QueryResult>({
  max: 100,
  ttl: 5 * 60 * 1000  // 5 minute TTL
});

// Invalidate on file changes
fileWatcher.on('change', () => queryCache.clear());
```

Similar queries within 5 minutes get instant results.
File changes invalidate the cache (correctness over speed).

#### 3. Pre-Built Indices in Memory
```typescript
// On startup, load these into RAM:
// 1. Inverted index for BM25 keyword search
const invertedIndex = buildInvertedIndex(allChunks);

// 2. Dependency graph for expansion
const depGraph = loadDependencyGraph('.codemem/meta/dependency-graph.json');

// 3. File modification times for recency
const fileTimes = loadFileModTimes('.codemem/meta/file-hashes.json');
```

#### 4. Async File Indexing
```typescript
// File changes are indexed in background — NEVER block queries
fileWatcher.on('change', async (path) => {
  // Don't block the query pipeline
  setImmediate(async () => {
    await reindexFile(path);
    queryCache.clear(); // invalidate after re-index completes
  });
});
```

#### 5. Top-K Tuning
```
K=5:  ~60ms total  → tight context (specific bug fixes)
K=8:  ~85ms total  → standard context (general features)
K=12: ~120ms total → broad context (architecture questions)

Default: K=6 (best balance of speed vs quality)
```

---

## 5. Storage Choice (Corrected)

### Decision: ChromaDB as Primary

**Previous decision:** Vectra (pure TypeScript)
**Corrected decision:** ChromaDB

### Why ChromaDB Wins for MVP

| Factor | Vectra | ChromaDB |
|--------|--------|----------|
| Metadata filtering | Basic | Full (where clauses) |
| Community | Tiny | Large, active |
| Documentation | Minimal | Excellent |
| Proven at scale | No | Yes (widely deployed) |
| Local performance | Good | Good |
| HNSW indexing | No | Yes (fast ANN search) |
| Python dependency | No | Yes (via pip) |
| Node.js client | Native | chromadb-client (REST) |

### Integration Architecture

```
CodeMem Sidecar (Node.js)
    │
    ├── On startup: spawn ChromaDB as child process
    │   chromadb run --path .codemem/db/ --port 8433
    │
    ├── Communicate via chromadb-client (HTTP to localhost:8433)
    │   All operations: add, query, update, delete
    │
    └── On shutdown: gracefully stop ChromaDB process
```

### Handling the Python Dependency

The concern with ChromaDB is it requires Python. Solutions:

1. **Check for Python on init**
   ```
   $ codemem init
   Checking dependencies...
   ✓ Node.js v20.11.0
   ✓ Python 3.11.0
   Installing ChromaDB...
   ✓ pip install chromadb (isolated venv)
   ```

2. **Use isolated virtualenv** — don't pollute user's Python
   ```bash
   python -m venv ~/.codemem/venv
   ~/.codemem/venv/bin/pip install chromadb
   ```

3. **Fallback path** — if Python not available:
   ```
   $ codemem init
   ⚠ Python not found. Using built-in Vectra store.
     (ChromaDB recommended for better performance — install Python 3.9+)
   ```

### ChromaDB Collection Schema

```python
collection = client.create_collection(
    name="codebase",
    metadata={"hnsw:space": "cosine"},
    embedding_function=None  # We provide our own embeddings
)

# Adding chunks:
collection.add(
    ids=["src/auth/login.ts::validateCredentials"],
    embeddings=[[0.12, -0.45, ...]],  # 384-dim from local model
    documents=["// File: src/auth/login.ts\n// Function: validateCredentials\n..."],
    metadatas=[{
        "file_path": "src/auth/login.ts",
        "language": "typescript",
        "type": "function",
        "name": "validateCredentials",
        "exported": True,
        "start_line": 24,
        "end_line": 45,
        "token_count": 180,
        "last_modified": "2025-03-28T10:30:00Z"
    }]
)

# Querying with metadata filters:
results = collection.query(
    query_embeddings=[query_vector],
    n_results=20,
    where={"language": "typescript"},  # Optional filter
    include=["documents", "metadatas", "distances"]
)
```

### Migration Path

```
v1.0 (MVP):     ChromaDB (with Vectra fallback if no Python)
v1.5 (if needed): LanceDB (Rust, native Node bindings, faster)
v2.0 (scale):    Pluggable backend (ChromaDB / LanceDB / Qdrant)
```
