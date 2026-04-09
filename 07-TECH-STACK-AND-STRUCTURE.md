# Tech Stack & Project Structure

## Tech Stack

### Core Runtime
| Component | Technology | Why |
|-----------|-----------|-----|
| Language | TypeScript (Node.js) | npm distribution, VS Code ecosystem, async I/O |
| Build | tsup (esbuild) | Fast bundling, single-file output |
| Runtime | Node.js >= 18 | Stable, widely installed, native fetch |

### Vector Database
| Option | Status | Notes |
|--------|--------|-------|
| ChromaDB | **Primary (MVP)** | Best docs, metadata filtering, HNSW index, proven |
| Vectra | Fallback | Pure TypeScript, used when Python unavailable |
| LanceDB | Future (v2) | Rust-based, native Node.js bindings, fastest |

**Decision: Start with ChromaDB for v1, Vectra as no-Python fallback.**
Rationale: ChromaDB has the best documentation, supports metadata filtering
(critical for language/file-type queries), and is battle-tested. The Python
dependency is handled via an isolated virtualenv at `~/.codemem/venv/`.
If Python is unavailable, falls back to Vectra with a recommendation to
install Python for better performance. See doc 10 for full reasoning.

### Embedding Model
| Component | Technology | Why |
|-----------|-----------|-----|
| Runtime | ONNX Runtime (Node.js) | Runs ML models natively in Node |
| Model | all-MiniLM-L6-v2 | 90MB, CPU-only, 384 dimensions |
| Tokenizer | @xenova/transformers | HuggingFace Transformers.js |

### Code Parsing
| Component | Technology | Why |
|-----------|-----------|-----|
| AST Parser | tree-sitter (WASM) | Language-agnostic, fast, accurate |
| Bindings | web-tree-sitter | Runs in Node.js via WASM |
| Fallback | Regex patterns | For unsupported languages |

### File System
| Component | Technology | Why |
|-----------|-----------|-----|
| File watcher | chokidar | Battle-tested, cross-platform |
| Glob matching | picomatch | Fast, .gitignore compatible |
| File hashing | xxhash (xxhash-wasm) | Fastest hash for change detection |

### Server & Communication
| Component | Technology | Why |
|-----------|-----------|-----|
| HTTP Server | fastify | Fastest Node.js server, low overhead |
| MCP Server | @modelcontextprotocol/sdk | Official MCP SDK |
| CLI Framework | commander + ora + chalk | Standard Node.js CLI tooling |

### Testing
| Component | Technology |
|-----------|-----------|
| Unit tests | vitest |
| Integration | vitest + test fixtures |
| E2E | Playwright (for VS Code extension testing) |

## Project Structure

```
codemem/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
├── LICENSE (MIT)
├── CHANGELOG.md
│
├── src/
│   ├── index.ts                    # CLI entry point
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── init.ts             # codemem init
│   │   │   ├── status.ts           # codemem status
│   │   │   ├── stats.ts            # codemem stats
│   │   │   ├── config.ts           # codemem config
│   │   │   ├── reindex.ts          # codemem reindex
│   │   │   ├── search.ts           # codemem search
│   │   │   ├── doctor.ts           # codemem doctor
│   │   │   ├── clean.ts            # codemem clean
│   │   │   ├── start.ts            # codemem start
│   │   │   └── stop.ts             # codemem stop
│   │   ├── ui.ts                   # Terminal UI helpers (progress bars, boxes)
│   │   └── detect-ide.ts           # IDE auto-detection
│   │
│   ├── core/
│   │   ├── indexer.ts              # Orchestrates full/incremental indexing
│   │   ├── chunker.ts              # AST-based semantic chunking
│   │   ├── chunk-envelope.ts       # Builds enriched chunk envelopes (header + code)
│   │   ├── embedder.ts             # Local embedding model wrapper (preloaded)
│   │   ├── vector-store.ts         # Vector DB abstraction layer
│   │   ├── retriever.ts            # Hybrid retrieval (semantic + BM25 + recency)
│   │   ├── keyword-index.ts        # In-memory BM25-lite inverted index
│   │   ├── context-assembler.ts    # Structured context with flow maps
│   │   ├── dependency-graph.ts     # Inter-file dependency tracking
│   │   ├── file-watcher.ts         # Filesystem change detection (async)
│   │   ├── project-analyzer.ts     # Detect language, framework, structure
│   │   ├── query-cache.ts          # LRU cache for recent queries
│   │   ├── stats-tracker.ts        # Token savings statistics
│   │   ├── concurrency.ts          # p-limit pools, backpressure queue
│   │   ├── wal.ts                  # Write-ahead log for crash safety
│   │   ├── recovery.ts             # Startup recovery and repair
│   │   ├── secret-detector.ts      # Detect and skip secrets in code
│   │   └── intent-detector.ts      # Query intent classification
│   │
│   ├── parsers/
│   │   ├── tree-sitter-parser.ts   # AST-based chunking
│   │   ├── regex-parser.ts         # Fallback regex chunking
│   │   └── language-configs/
│   │       ├── typescript.ts
│   │       ├── python.ts
│   │       ├── rust.ts
│   │       ├── go.ts
│   │       ├── java.ts
│   │       └── index.ts            # Language registry
│   │
│   ├── server/
│   │   ├── http-server.ts          # Fastify REST API
│   │   ├── mcp-server.ts           # MCP protocol server
│   │   ├── routes/
│   │   │   ├── query.ts            # POST /query
│   │   │   ├── index.ts            # POST /index
│   │   │   ├── status.ts           # GET /status
│   │   │   ├── stats.ts            # GET /stats
│   │   │   ├── config.ts           # GET/PUT /config
│   │   │   └── update.ts           # POST /update
│   │   └── middleware/
│   │       └── error-handler.ts
│   │
│   ├── storage/
│   │   ├── chromadb-store.ts       # ChromaDB vector DB implementation (primary)
│   │   ├── vectra-store.ts         # Vectra fallback (no Python needed)
│   │   ├── lancedb-store.ts        # LanceDB implementation (v2)
│   │   ├── config-store.ts         # .codemem/config.json management
│   │   ├── meta-store.ts           # .codemem/meta/ management
│   │   └── global-store.ts         # ~/.codemem/ global data
│   │
│   ├── types/
│   │   ├── chunk.ts                # Chunk, ChunkMetadata interfaces
│   │   ├── config.ts               # Configuration interfaces
│   │   ├── query.ts                # Query, QueryResult interfaces
│   │   ├── project.ts              # ProjectInfo, ProjectSummary
│   │   └── stats.ts                # StatsData interfaces
│   │
│   └── utils/
│       ├── hash.ts                 # File content hashing
│       ├── tokens.ts               # Token counting utilities
│       ├── ignore.ts               # .gitignore + .codememignore parsing
│       ├── logger.ts               # Logging to .codemem/logs/
│       └── process.ts              # Background process management
│
├── adapters/
│   ├── vscode/
│   │   ├── package.json
│   │   ├── src/
│   │   │   └── extension.ts        # VS Code extension (~150 lines)
│   │   └── README.md
│   │
│   ├── jetbrains/
│   │   ├── build.gradle.kts
│   │   ├── src/
│   │   │   └── main/kotlin/dev/codemem/
│   │   │       └── Plugin.kt       # JetBrains plugin (~200 lines)
│   │   └── plugin.xml
│   │
│   └── neovim/
│       └── lua/
│           └── codemem.lua          # Neovim plugin (~100 lines)
│
├── tests/
│   ├── unit/
│   │   ├── chunker.test.ts
│   │   ├── chunk-envelope.test.ts
│   │   ├── keyword-index.test.ts
│   │   ├── embedder.test.ts
│   │   ├── retriever.test.ts
│   │   ├── context-assembler.test.ts
│   │   ├── dependency-graph.test.ts
│   │   ├── file-watcher.test.ts
│   │   ├── wal.test.ts
│   │   ├── secret-detector.test.ts
│   │   ├── query-cache.test.ts
│   │   └── intent-detector.test.ts
│   │
│   ├── integration/
│   │   ├── indexing.test.ts
│   │   ├── query-flow.test.ts
│   │   ├── incremental-update.test.ts
│   │   ├── mcp-server.test.ts
│   │   ├── crash-recovery.test.ts
│   │   ├── concurrent-access.test.ts
│   │   └── project-isolation.test.ts
│   │
│   ├── performance/
│   │   ├── indexing-benchmark.ts
│   │   ├── query-latency.ts
│   │   ├── memory-usage.ts
│   │   └── cache-effectiveness.ts
│   │
│   └── fixtures/
│       ├── sample-project/          # Minimal project for testing
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── auth.ts
│       │   │   └── utils.ts
│       │   └── package.json
│       ├── sample-with-secrets/     # Files with fake secrets (test skip)
│       └── expected-chunks/         # Expected chunking output
│
├── docs/
│   ├── architecture.md
│   ├── api-reference.md
│   ├── mcp-integration.md
│   ├── contributing.md
│   └── faq.md
│
└── scripts/
    ├── build.sh                    # Build all packages
    ├── release.sh                  # Publish to npm
    └── download-model.sh           # Download embedding model
```

## Key Dependencies

```json
{
  "dependencies": {
    // Server
    "fastify": "^5.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0",

    // CLI
    "commander": "^12.0.0",
    "ora": "^8.0.0",
    "chalk": "^5.0.0",
    "boxen": "^8.0.0",

    // Embedding
    "@xenova/transformers": "^2.17.0",
    "onnxruntime-node": "^1.17.0",

    // Vector Store
    "chromadb-default-embed": "^0.1.0",
    "chromadb": "^1.8.0",
    "vectra": "^0.9.0",          // fallback when Python unavailable
    "lru-cache": "^11.0.0",      // query caching

    // Code Parsing
    "web-tree-sitter": "^0.22.0",

    // File System
    "chokidar": "^4.0.0",
    "picomatch": "^4.0.0",
    "xxhash-wasm": "^1.0.0",

    // Utilities
    "tiktoken": "^1.0.0",
    "proper-lockfile": "^4.1.0",
    "p-limit": "^6.0.0",
    "semver": "^7.6.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0"
  }
}
```

## Build & Distribution

### npm Package
```bash
# User installs globally
npm install -g codemem

# Or runs directly (zero install)
npx codemem init
```

### Bundle Strategy
- Single executable bundle via tsup
- Tree-shaken, minified
- ONNX runtime as optional peer dependency
- tree-sitter WASM files bundled
- Total package size: ~15MB (excluding model download)

### Platform Support
| Platform | Status | Notes |
|----------|--------|-------|
| macOS (ARM) | Full | Primary dev platform |
| macOS (Intel) | Full | |
| Linux (x64) | Full | |
| Linux (ARM) | Full | Raspberry Pi compatible |
| Windows (x64) | Full | |
| Windows (ARM) | Partial | ONNX runtime support varies |
