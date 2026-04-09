# CodeMem

> **AI-agnostic local memory layer for codebases.**
> Index once, remember forever, switch AI freely.

**Status:** `v0.1.0` — Early release. Core is stable and working. Active development.

CodeMem is a local sidecar process that runs alongside your editor and gives any AI assistant (Claude, GPT-4, Cursor, Copilot, etc.) a **persistent, semantic memory of your codebase** — without sending your code to the cloud, without locking you into one AI provider, and without blowing up your context window.

---

## The Problem

Every time you start a new AI chat, it has zero memory of your project. You paste the same files over and over. You hit the context limit. You switch to a different AI and lose everything again. Large codebases are simply too big to fit in any context window.

## The Solution

CodeMem **indexes your entire codebase locally** into a vector database. When you ask an AI a question, CodeMem retrieves only the *most relevant* code chunks — typically 3–8 functions — and injects them into the prompt. The AI gets exactly what it needs, nothing more.

```
Your codebase (10,000+ lines)
        ↓  codemem init  (one time, per project)
   Vector Index  (.codemem/  local to your project)
        ↓  on every query
  Top 6 relevant chunks  (~400 tokens)
        ↓
   Any AI Assistant  ← answers with full context, no lock-in
```

---

## Features

| Feature | Description |
|---|---|
| **Semantic search** | Find code by meaning, not keywords — "how does auth work?" finds the right file even if it never says "auth" |
| **Hybrid ranking** | Semantic similarity (55%) + BM25 keyword matching (30%) + recency decay (15%) |
| **Structured context assembly** | Returns a readable code flow (imports → function → call chain), not just raw chunks — AI answers are noticeably better |
| **AI provider independent** | Works with GPT-4, Claude, Cursor, Copilot, or any HTTP client — switch providers anytime without losing memory |
| **Multi-project support** | Each project keeps its own `.codemem/` directory — switch projects and memory switches with you, no reindex required |
| **Incremental indexing** | Only re-indexes files that changed — seconds, not minutes |
| **Parallel indexing** | Embeds multiple files concurrently (controlled concurrency) for fast initial indexing |
| **Live file watcher** | Detects file saves and updates the index in the background within ~1 second |
| **Fully local & private** | Nothing leaves your machine. No API key, no cloud, no telemetry |
| **Token savings** | Reduces context window usage by ~95% vs. pasting full files |
| **Multi-language** | TypeScript, JavaScript, Python, Rust, Go, Java, Ruby — with per-language chunking |
| **Smart chunking** | Splits at function/class boundaries, not arbitrary line counts |
| **Lightweight local vector store** | Powered by Vectra — no external database process, no Python, no Docker |

---

## Example

```bash
$ codemem search "how does auth work"

  Results (3 chunks, 31ms):

  ──────────────────────────────────────
  1. src/middleware/auth.ts :: verifyToken   [87%]
     export async function verifyToken(req, res) {

  2. src/routes/login.ts :: loginHandler   [81%]
     export async function loginHandler(req, reply) {

  3. src/models/user.ts :: findByEmail   [74%]
     export async function findByEmail(email: string) {

  → 83K tokens saved vs full read
```

The assembled context passed to your AI looks like:

```
## Project: myapp | Language: typescript | Framework: Fastify

### Relevant files:
1. src/middleware/auth.ts — verifyToken (lines 12–34)
2. src/routes/login.ts — loginHandler (lines 5–48)
3. src/models/user.ts — findByEmail (lines 22–29)

### Code:

--- src/middleware/auth.ts (lines 12–34) [score: 0.87] ---
export async function verifyToken(req, res) {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  req.user = await db.user.findUnique({ where: { id: payload.sub } });
}

--- src/routes/login.ts (lines 5–48) [score: 0.81] ---
...
```

The AI sees exactly what it needs. Nothing more.

---

## Multi-Project Support

Each project keeps its own independent memory. There is no global index or cross-project state.

```bash
cd ~/projects/api-server
codemem init       # indexes api-server into ~/projects/api-server/.codemem/
codemem start      # serves memory for api-server

cd ~/projects/frontend
codemem init       # indexes frontend into ~/projects/frontend/.codemem/
codemem start      # serves memory for frontend
```

Switching projects is instant — the `.codemem/` folder travels with the project. You can also run multiple sidecars on different ports simultaneously.

---

## Requirements

| Requirement | Details |
|---|---|
| Node.js | >= 18.0.0 (tested on v24) |
| npm | >= 8 |
| Disk space | ~50 MB (model cache) + ~5 MB per 1,000 files indexed |
| RAM | ~300 MB while running |
| Python | **Not required** |
| GPU | **Not required** — CPU-only WASM inference |

Works on **Windows**, **macOS**, and **Linux**.

---

## Installation

### Option A — Clone and link (recommended for development)

```bash
git clone https://github.com/youruser/codemem.git
cd codemem
npm install
npm run build
npm link
```

### Option B — Install from npm (once published)

```bash
npm install -g codemem
```

---

## Quick Start

```bash
# 1. Go to any project you want to index
cd /path/to/your-project

# 2. Initialize CodeMem (downloads model ~22MB on first run, indexes codebase)
codemem init

# 3. Start the sidecar server
codemem start

# 4. Search from the CLI
codemem search "how does authentication work"

# 5. Or hit the HTTP API directly (works with any AI tool)
curl -X POST http://localhost:8432/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"query": "how does the payment flow work", "options": {"top_k": 5}}'
```

You can also trigger reindexing via HTTP:

```bash
curl -X POST http://localhost:8432/api/v1/index \
  -H "Content-Type: application/json" \
  -d '{"mode": "incremental"}'
```


---

## CLI Commands

### `codemem init`

Initialize CodeMem in the current directory. Downloads the embedding model on first run (~22 MB), scans all files, generates embeddings, and stores them in `.codemem/`.

```bash
codemem init          # interactive
codemem init --yes    # skip prompts
codemem init --debug  # verbose logging
```

**What it creates:**
```
your-project/
└── .codemem/
    ├── config.json       ← project settings
    ├── db/               ← local vector index (Vectra)
    ├── meta/             ← file hashes, stats, recent changes
    └── logs/             ← debug logs
```

---

### `codemem start`

Start the HTTP sidecar server. Loads the vector index and embedding model into memory, starts the file watcher, and serves the API on `localhost:8432`.

```bash
codemem start                # default port 8432
codemem start --port 9000    # custom port
codemem start --debug        # verbose logging
```

Press `Ctrl+C` to stop gracefully.

---

### `codemem stop`

Stop the running sidecar from another terminal window.

```bash
codemem stop
```

---

### `codemem status`

Show current index health and server state.

```bash
codemem status
```

```
  CodeMem Status

  Project
  ──────────────────────────────────────
    Name              my-project
    Language          typescript
    Framework         Fastify
    Root              /home/user/my-project

  Index
  ──────────────────────────────────────
    Files indexed     47
    Chunks            422
    Last indexed      2026-03-29T19:08:58Z

  Server
  ──────────────────────────────────────
    Status            ● Running (localhost:8432)

  Stats
  ──────────────────────────────────────
    Queries served    38
    Tokens saved      1.2M
```

---

### `codemem stats`

Show token savings and estimated cost saved.

```bash
codemem stats
```

---

### `codemem search <query>`

Search the indexed codebase from the terminal. Requires the sidecar to be running.

```bash
codemem search "how does the embedder load the model"
codemem search "error handling in HTTP routes" --top 8
```

---

### `codemem reindex`

Re-index after significant changes.

```bash
codemem reindex           # incremental (only changed files — fast)
codemem reindex --full    # force full re-index
```

---

## HTTP API

The sidecar exposes a REST API on `http://localhost:8432`. Any tool that can make an HTTP POST can use CodeMem.

### `POST /api/v1/query`

Semantic search — the main endpoint.

**Request:**
```json
{
  "query": "how does user authentication work",
  "options": {
    "top_k": 6,
    "token_budget": 4000
  }
}
```

**Response:**
```json
{
  "context": {
    "project_summary": "Project: myapp | Language: typescript | ...",
    "chunks": [
      {
        "id": "src/auth/middleware.ts::verifyToken",
        "file_path": "src/auth/middleware.ts",
        "content": "export async function verifyToken(req, res) { ... }",
        "relevance_score": 0.87,
        "type": "function",
        "lines": [12, 34]
      }
    ],
    "assembled_text": "## Project: ...\n\n--- src/auth/middleware.ts ---\n...",
    "token_count": 380
  },
  "stats": {
    "chunks_searched": 422,
    "chunks_returned": 6,
    "tokens_saved_estimate": 82000,
    "query_time_ms": 31
  }
}
```

---

### `POST /api/v1/index`

Trigger a full re-index via HTTP.

```json
{ "force": true }
```

### `POST /api/v1/update`

Trigger an incremental update for specific files.

```json
{ "files": ["src/auth/middleware.ts", "src/models/user.ts"] }
```

### `GET /api/v1/status`

Full sidecar status as JSON.

### `GET /api/v1/stats`

Token savings statistics as JSON.

### `GET /api/v1/health`

Health check. Returns `{"ok": true}`.

### `GET /api/v1/config` and `PUT /api/v1/config`

Read or update configuration at runtime.

```json
{
  "retrieval": { "top_k": 8, "token_budget": 6000 }
}
```

---

## How It Works

### 1. Chunking

Every source file is split into **semantic chunks** at function, class, and block boundaries. Each chunk is wrapped in an **envelope** that adds rich context before embedding:

```
[FILE: src/auth/middleware.ts | LANG: typescript | TYPE: function]
[DESC: verifyToken]
[IMPORTS: jsonwebtoken, prisma]
[CALLS: jwt.verify, db.user.findUnique]
[CODE]
export async function verifyToken(req, res) {
  const token = req.headers.authorization?.split(' ')[1];
  ...
}
```

The vector captures *context*, not just syntax — so semantically related code is found even when it uses different words.

### 2. Embedding

Each envelope is run through `all-MiniLM-L6-v2` — a 22MB quantized ONNX model running entirely on CPU via WebAssembly. Produces a 384-dimensional vector. No GPU, no cloud, no API key needed.

### 3. Storage

Vectors are stored in **Vectra** — a lightweight local vector database backed by plain JSON files in `.codemem/db/`. No separate database process, no Python, no Docker.

### 4. Retrieval & Context Assembly

At query time:
1. Query text is embedded into a 384-dim vector
2. Vectra finds top candidates by cosine similarity
3. Candidates are **re-ranked** with a hybrid score:
   - **55%** semantic similarity
   - **30%** BM25-lite keyword overlap
   - **15%** recency decay (recently edited files rank slightly higher)
4. Top chunks are assembled into a **structured, readable context block** — with project summary, file references, call flow, and code — within your token budget

### 5. File Watching

While `codemem start` is running, chokidar watches for file changes. A saved file is re-chunked and re-embedded within ~1 second. The index stays fresh automatically.

---

## Reliability

- **Safe incremental indexing** — only changed files are re-processed; the rest of the index is untouched
- **Graceful recovery on restart** — index is persisted on disk; no rebuild needed after a crash or reboot
- **No index corruption** — Vectra writes are atomic; a mid-write crash leaves the previous state intact
- **Automatic deduplication** — re-indexing a file replaces its chunks, never creates duplicates
- **Secrets never indexed** — `.env`, `*.key`, `*.pem`, and similar files are hard-excluded regardless of `.gitignore`

---

## Configuration

Configuration lives in `.codemem/config.json`. Edit directly or use `PUT /api/v1/config`.

```json
{
  "project": {
    "name": "my-project",
    "detected_language": "typescript",
    "detected_framework": "Fastify"
  },
  "server": {
    "port": 8432,
    "cors_origins": ["http://localhost:3000"]
  },
  "indexing": {
    "include_patterns": ["src/**/*", "lib/**/*"],
    "max_file_size_kb": 500,
    "debounce_ms": 500
  },
  "retrieval": {
    "top_k": 6,
    "token_budget": 4000,
    "min_score": 0.15
  },
  "embedding": {
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384,
    "batch_size": 32
  }
}
```

---

## Ignoring Files

CodeMem respects `.gitignore` automatically. Create `.codememignore` for extra exclusions:

```
# .codememignore
tests/fixtures/**
*.generated.ts
docs/**
coverage/**
```

Always excluded regardless of ignore files:
- `node_modules/`, `dist/`, `build/`, `.git/`
- Binary files (images, fonts, archives, executables)
- Secret files (`.env`, `*.key`, `*.pem`, `*.secret`)
- The `.codemem/` folder itself

---

## Integrating with AI Tools

### Any AI via HTTP

Add this to your AI system prompt or tool definition:

```
CodeMem is running at http://localhost:8432.
To get relevant codebase context, POST to /api/v1/query:
  { "query": "your question here", "options": { "top_k": 6 } }
Use the returned "assembled_text" field as codebase context.
```

### From a script

```bash
curl -s -X POST http://localhost:8432/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"query": "database connection pooling", "options": {"top_k": 5}}' \
  | jq '.context.assembled_text'
```

### MCP Server (coming soon)

A Model Context Protocol server is planned for native Claude Desktop and Cursor integration — CodeMem will be called automatically when codebase context is needed.

---

## Performance

| Operation | Typical time |
|---|---|
| `codemem init` — first run (model download) | 30–90s |
| `codemem init` — model cached, ~50 files | 60–180s |
| `codemem start` — load model + index into memory | 5–15s |
| Semantic query | 30–300ms (depends on index size) |
| Incremental re-index — 1 file changed | < 2s |
| Full re-index — 50 files | 60–180s |

Query time stays low regardless of codebase size because search is vector similarity (sub-linear). Indexing time scales linearly with file count.

---

## Supported Languages

| Language | Extensions | Chunk strategy |
|---|---|---|
| TypeScript | `.ts`, `.tsx` | Functions, classes, interfaces, arrow functions |
| JavaScript | `.js`, `.jsx`, `.mjs` | Functions, classes, arrow functions |
| Python | `.py` | Functions (`def`), classes |
| Rust | `.rs` | Functions (`fn`), structs, `impl` blocks |
| Go | `.go` | Functions (`func`) |
| Java | `.java` | Methods, classes |
| Ruby | `.rb` | Methods (`def`), classes |
| Other | `.md`, `.json`, `.yaml`, etc. | Paragraph / section splits |

---

## When NOT to Use CodeMem

CodeMem is designed for real codebases. It is overkill or unhelpful for:

- **Very small projects** (< 5 files) — just paste the files directly
- **One-off scripts** — not worth indexing something you run once
- **Non-code content** — large datasets, binary assets, log files
- **Frequently generated files** — build artifacts, compiled output (add to `.codememignore`)

---

## Project Structure

```
codemem/
├── src/
│   ├── index.ts                  ← CLI entry point (Commander)
│   ├── types/
│   │   ├── chunk.ts              ← Chunk, ChunkHeader, VectraMetadata types
│   │   ├── config.ts             ← CodeMemConfig, DEFAULT_CONFIG
│   │   └── query.ts              ← QueryOptions, QueryResult, IndexResult
│   ├── utils/
│   │   ├── logger.ts             ← Structured JSON logger
│   │   ├── hash.ts               ← SHA-256 file change detection
│   │   ├── tokens.ts             ← Token estimation + budget trimming
│   │   └── ignore.ts             ← .gitignore / .codememignore filter
│   ├── parsers/
│   │   └── regex-parser.ts       ← Language-aware semantic chunker
│   ├── core/
│   │   ├── embedder.ts           ← @xenova/transformers WASM wrapper
│   │   ├── indexer.ts            ← Full + incremental parallel indexing
│   │   ├── retriever.ts          ← Hybrid search + structured context assembly
│   │   ├── file-watcher.ts       ← chokidar-based live watcher
│   │   └── project-analyzer.ts   ← Language/framework/entrypoint detection
│   ├── storage/
│   │   ├── vectra-store.ts       ← Vectra LocalIndex wrapper
│   │   ├── config-store.ts       ← .codemem/config.json CRUD
│   │   └── meta-store.ts         ← File hashes, stats, recent changes
│   ├── server/
│   │   ├── http-server.ts        ← Fastify server + watcher integration
│   │   ├── routes/
│   │   │   ├── query.ts          ← POST /api/v1/query, /index, /update
│   │   │   └── status.ts         ← GET /api/v1/status, /stats, /config, /health
│   │   └── middleware/
│   │       └── error-handler.ts  ← Fastify error handler
│   └── cli/
│       ├── ui.ts                 ← Terminal UI (chalk, boxen, ora)
│       └── commands/
│           ├── init.ts           ← codemem init
│           ├── start.ts          ← codemem start
│           ├── stop.ts           ← codemem stop
│           ├── status.ts         ← codemem status
│           ├── stats.ts          ← codemem stats
│           ├── search.ts         ← codemem search
│           └── reindex.ts        ← codemem reindex
├── node_ort_shim/
│   ├── package.json              ← Masquerades as onnxruntime-node
│   └── index.js                  ← Redirects to onnxruntime-web (WASM)
├── dist/                         ← Compiled ESM output (tsup)
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Troubleshooting

### `codemem init` fails with "Failed to load model"

**Windows:** Ensure Node.js v18+ is installed. The model runs via WebAssembly — no Visual C++ Redistributable or GPU drivers needed.

**All platforms:** Check that `~/.codemem/models/` is writable. Delete it and re-run `codemem init` to re-download the model.

### Server won't start — "address already in use"

Another process is using port 8432. Use a different port:
```bash
codemem start --port 9000
# or edit .codemem/config.json → "server": { "port": 9000 }
```

### `codemem search` says "Is the sidecar running?"

The HTTP server must be running before you can search:
```bash
codemem start
```

### Search results are irrelevant

Reindex after major refactors:
```bash
codemem reindex --full
```

### `.codemem/` folder is large

The index grows with your codebase. To reset completely:
```bash
rm -rf .codemem/
codemem init
```

---

## Privacy & Security

- **No telemetry** — CodeMem never phones home
- **No cloud** — the embedding model runs locally via WebAssembly
- **Your code never leaves your machine** — all vectors are stored in `.codemem/` inside your project
- **Secrets are hard-excluded** — `.env`, `*.key`, `*.pem`, and similar files are never indexed
- **`.codemem/` is gitignored automatically** — `codemem init` adds it for you

---

## Roadmap

- [ ] MCP server for native Claude Desktop and Cursor integration
- [ ] VS Code extension with inline context panel
- [ ] Tree-sitter AST chunker (more precise than regex)
- [ ] Dependency graph awareness — index call chains across files
- [ ] `codemem doctor` — diagnose index health issues
- [ ] `@xenova/transformers` v3 upgrade for faster inference

---

## License

MIT
