# System Architecture

## Architecture Philosophy

CodeMem follows a **sidecar architecture** — a standalone local process that runs
alongside any IDE. The core logic is written once; each IDE gets a thin adapter
plugin (~100-200 lines) that communicates with the sidecar over localhost.

## High-Level Components

### 1. CodeMem Core (Sidecar Server)

The central process that runs on localhost. Written in Node.js (TypeScript).

**Responsibilities:**
- Manages the vector database (ChromaDB)
- Runs the local embedding model
- Watches filesystem for changes (incremental re-indexing)
- Exposes MCP server for AI tool integration
- Exposes REST API for IDE adapters
- Manages project configuration (.codemem/ folder)
- Handles code chunking and context assembly

**Why Node.js/TypeScript:**
- Same ecosystem as VS Code extensions (largest IDE market share)
- npm distribution (npx codemem init — zero install friction)
- Excellent filesystem watching libraries (chokidar)
- Native async I/O for non-blocking file operations
- Can call Python embedding models via child process or ONNX.js

### 2. Vector Database (ChromaDB)

Local, embedded vector database. No external server needed.

**Why ChromaDB:**
- Runs in-process (no separate database server)
- Stores data as files in .codemem/db/ folder
- Supports metadata filtering (search by file type, directory, etc.)
- Open source, well-maintained
- Python-based but can be called from Node via chromadb-client

**Alternative considered:** LanceDB (Rust-based, embeddable, faster)
- Can switch to LanceDB if performance is a concern
- LanceDB has a Node.js native binding

### 3. Embedding Model (Local)

Converts code into vector representations. Runs entirely on CPU.

**Primary: all-MiniLM-L6-v2**
- 90MB model size (one-time download)
- Runs on CPU — no GPU required
- 384-dimensional vectors
- Good enough for code similarity search
- Available via ONNX runtime (runs in Node.js natively)

**Upgrade path: nomic-embed-text or voyage-code-3**
- Better code understanding
- Larger model but significantly better retrieval
- Can be swapped without re-architecting

### 4. File Watcher

Monitors the project filesystem for changes in real time.

**Implementation: chokidar (Node.js)**
- Watches for file create, modify, delete events
- Respects .gitignore and .codememignore patterns
- Debounces rapid changes (e.g., git checkout switching many files)
- Triggers incremental re-indexing only for changed files

### 5. IDE Adapters (Thin Plugins)

Minimal plugins for each IDE that forward requests to the sidecar.

**VS Code Extension (~150 lines):**
- Registers as an MCP tool provider
- Forwards context requests to localhost:8432
- Shows status bar indicator (indexed files count, last sync)
- Provides commands: reindex, status, configure

**JetBrains Plugin (~200 lines):**
- Kotlin-based plugin
- Same REST API communication
- Status bar widget
- Settings panel for configuration

**Neovim Plugin (~100 lines):**
- Lua-based plugin
- HTTP calls to sidecar REST API
- Telescope integration for searching indexed code

**Cursor/Windsurf/Continue:**
- These already support MCP — just connect to CodeMem's MCP server
- Zero plugin code needed for MCP-compatible tools

### 6. MCP Server

Model Context Protocol server that any MCP-compatible AI tool can connect to.

**Exposed Tools:**
- `search_codebase` — semantic search across indexed code
- `get_file_context` — retrieve a specific file with its dependencies
- `get_project_summary` — high-level project structure overview
- `update_index` — manually trigger re-indexing

**Exposed Resources:**
- `project://structure` — file tree and module organization
- `project://recent-changes` — recently modified files
- `project://dependencies` — dependency graph

## Port & Communication

| Component | Protocol | Address |
|-----------|----------|---------|
| Sidecar Server | HTTP REST | localhost:8432 |
| MCP Server | stdio / SSE | Launched per-IDE session |
| Vector DB | In-process | No network (file-based) |
| File Watcher | In-process | OS filesystem events |

## Directory Structure (On User's Machine)

```
project-root/
├── .codemem/                    # CodeMem project data
│   ├── config.json              # Project configuration
│   ├── db/                      # ChromaDB vector storage
│   │   ├── chroma.sqlite3       # Vector index
│   │   └── embeddings/          # Raw embedding data
│   ├── meta/                    # Metadata and caches
│   │   ├── file-hashes.json     # File content hashes (for change detection)
│   │   ├── dependency-graph.json # Inter-file dependency map
│   │   ├── project-summary.json  # Cached project overview
│   │   └── stats.json           # Token savings statistics
│   └── logs/                    # Debug logs
│       └── codemem.log
├── .codememignore               # Files to exclude from indexing
└── (user's project files)
```

## Global Installation Structure

```
~/.codemem/                      # Global CodeMem data
├── models/                      # Downloaded embedding models (shared)
│   └── all-MiniLM-L6-v2/       # ~90MB, downloaded once
├── config.json                  # Global settings (default AI provider, etc.)
├── adapters/                    # Cached IDE adapter plugins
│   ├── vscode/
│   ├── jetbrains/
│   └── neovim/
└── stats/                       # Global token savings across all projects
    └── usage.json
```

## Security & Privacy

- ALL data stays on the user's machine — never transmitted anywhere
- Vector DB files are local SQLite — can be inspected, backed up, or deleted
- No telemetry, no analytics, no phone-home
- The MCP server only listens on localhost — not accessible from network
- .codemem/ can be added to .gitignore (it's machine-specific)
- Embedding model runs locally — code is never sent to an embedding API
