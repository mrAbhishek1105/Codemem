# Development Roadmap

## Phase 0: Foundation (Week 1-2)
**Goal: Bare minimum working prototype**

### Tasks
- [ ] Initialize TypeScript project with tsup build
- [ ] Set up project structure (src/, tests/, adapters/)
- [ ] Implement basic CLI scaffold (commander)
  - [ ] `codemem init` — create .codemem/ directory
  - [ ] `codemem start` / `codemem stop`
- [ ] File scanner — walk directory, respect .gitignore
- [ ] Basic regex-based chunker (function/class detection)
- [ ] Vectra vector store integration
  - [ ] Store chunks with metadata
  - [ ] Basic similarity search
- [ ] ONNX embedding model loader
  - [ ] Download all-MiniLM-L6-v2 on first run
  - [ ] Generate embeddings for code chunks
- [ ] Basic HTTP server (Fastify)
  - [ ] POST /query endpoint
  - [ ] GET /status endpoint

### Milestone
```
$ npx codemem init
# Indexes project into Vectra
$ curl -X POST localhost:8432/api/v1/query \
    -d '{"query": "authentication logic"}'
# Returns relevant code chunks
```

## Phase 1: Core Engine (Week 3-4)
**Goal: Production-quality indexing and retrieval**

### Tasks
- [ ] tree-sitter integration for AST-based chunking
  - [ ] TypeScript/JavaScript parser
  - [ ] Python parser
  - [ ] Add 3-4 more language parsers
- [ ] Smart chunking algorithm
  - [ ] Chunk by semantic units (functions, classes, modules)
  - [ ] Attach context (imports, exports, parent scope)
  - [ ] Respect chunk size limits (50-1000 tokens)
- [ ] Context assembler
  - [ ] Dependency expansion (pull in related types/functions)
  - [ ] Recency boost for recently modified files
  - [ ] Token budget fitting algorithm
  - [ ] Formatted output for AI consumption
- [ ] File watcher (chokidar)
  - [ ] Incremental re-indexing on file save
  - [ ] Debouncing for rapid changes
  - [ ] Batch processing for git operations
- [ ] File hash tracking for change detection
- [ ] Dependency graph builder
  - [ ] Import/export analysis
  - [ ] Call graph tracking (basic)
- [ ] Project analyzer
  - [ ] Auto-detect language, framework, package manager
  - [ ] Generate project summary

### Milestone
```
$ npx codemem init
# Full AST-based indexing with smart chunking
# File watcher starts, incremental updates work
# Query returns relevant chunks with dependency context
```

## Phase 2: MCP & IDE Integration (Week 5-6)
**Goal: Works inside actual IDEs**

### Tasks
- [ ] MCP server implementation
  - [ ] search_codebase tool
  - [ ] get_file_context tool
  - [ ] get_project_overview tool
  - [ ] report_change tool
  - [ ] project:// resources
- [ ] VS Code extension
  - [ ] Status bar indicator
  - [ ] Command palette integration
  - [ ] Auto-start sidecar
  - [ ] Notifications
- [ ] Cursor/Continue MCP configuration
  - [ ] Auto-generate MCP config during init
  - [ ] Test with Cursor's MCP integration
- [ ] IDE auto-detection during init
  - [ ] Detect installed IDEs
  - [ ] Auto-install appropriate adapter
  - [ ] Configure MCP where supported
- [ ] Full REST API
  - [ ] All endpoints from API design
  - [ ] Error handling
  - [ ] Input validation

### Milestone
```
# User installs, opens Cursor, types a prompt
# Cursor calls CodeMem's MCP tools automatically
# AI gets focused context instead of full codebase
# Status bar shows "CodeMem: 847 files | 42M saved"
```

## Phase 3: Polish, Stats & Production Hardening (Week 7-9)
**Goal: Delightful UX, token savings tracking, crash-safe operation**

### Tasks
- [ ] CLI polish
  - [ ] Beautiful terminal UI (progress bars, boxes, colors)
  - [ ] `codemem stats` with detailed savings report
  - [ ] `codemem search` interactive mode
  - [ ] `codemem doctor` diagnostics
  - [ ] `codemem clean` cleanup command
  - [ ] `codemem repair` crash recovery
  - [ ] `codemem upgrade` auto-update
  - [ ] `codemem feedback --good/--bad` retrieval feedback
  - [ ] `codemem query --debug` diagnostic output
- [ ] Token savings tracker
  - [ ] Count tokens per query (input vs full-read)
  - [ ] Track by AI provider
  - [ ] Calculate estimated cost savings
  - [ ] Weekly summary notifications
- [ ] Configuration system
  - [ ] `codemem config` command
  - [ ] config.json management
  - [ ] .codememignore support
  - [ ] Per-project and global settings
  - [ ] Schema versioning and migrations
- [ ] Crash safety
  - [ ] Write-ahead logging (WAL) for all DB writes
  - [ ] Atomic writes (temp file + rename)
  - [ ] Startup recovery (replay pending WAL entries)
  - [ ] `codemem repair` command
  - [ ] Stale lock detection and breaking
- [ ] Concurrency control
  - [ ] p-limit pools (CPU, disk, DB)
  - [ ] Backpressure queue (reject when overloaded)
  - [ ] File locking (proper-lockfile)
  - [ ] Query priority over background indexing
- [ ] Security
  - [ ] Secret detection in chunker (skip .env, API keys)
  - [ ] Default .codememignore with sensitive patterns
  - [ ] Localhost-only binding (127.0.0.1, not 0.0.0.0)
  - [ ] No telemetry, no outbound network
- [ ] Performance optimization
  - [ ] Multi-layer cache (query, embedding, hash)
  - [ ] Cold start optimization (model preload + warmup)
  - [ ] Benchmark indexing speed
  - [ ] Optimize embedding batch size
  - [ ] Cache frequently accessed chunks
  - [ ] Lazy-load tree-sitter parsers
- [ ] Observability
  - [ ] Structured JSON logging
  - [ ] Query log with timing breakdown
  - [ ] Error log for debugging
  - [ ] Debug mode (--debug flag)
- [ ] Error handling & edge cases
  - [ ] Corrupted DB recovery
  - [ ] Large file handling (>500KB)
  - [ ] Binary file detection and skip
  - [ ] Symlink handling
  - [ ] Permission errors

### Milestone
```
$ codemem stats
# Beautiful savings report
# "You've saved 42M tokens ($63.00) across 4,230 queries"
```

## Phase 4: Advanced Features (Week 9-12)
**Goal: Semantic context layer — the differentiator**

### Tasks
- [ ] Co-change detection
  - [ ] Track which files change together
  - [ ] Auto-include co-changed files in context
  - [ ] Surface patterns to user
- [ ] Change history tracking
  - [ ] What changed, when, by whom
  - [ ] AI-generated change summaries
  - [ ] Recent changes context in queries
- [ ] Architecture pattern detection
  - [ ] MVC, microservices, monolith patterns
  - [ ] API surface detection (routes, endpoints)
  - [ ] Store as project metadata
- [ ] JetBrains plugin
  - [ ] Kotlin plugin implementation
  - [ ] Status bar widget
  - [ ] Settings panel
- [ ] Neovim plugin
  - [ ] Lua plugin
  - [ ] Telescope integration
  - [ ] Lualine component
- [ ] Multiple project support
  - [ ] Monorepo handling
  - [ ] Workspace-level indexing
  - [ ] Cross-project references

### Milestone
```
# AI modifies auth handler
# CodeMem automatically includes related test file
# because co-change detection knows they change together
```

## Phase 5: Launch & Distribution (Week 13-14)
**Goal: Public release**

### Tasks
- [ ] npm package publishing
  - [ ] Package optimization
  - [ ] Publish to npmjs.com as "codemem"
  - [ ] npx codemem init works globally
- [ ] VS Code marketplace
  - [ ] Extension packaging
  - [ ] Marketplace listing
  - [ ] Screenshots and demo GIF
- [ ] JetBrains marketplace
  - [ ] Plugin packaging
  - [ ] Marketplace listing
- [ ] Documentation site
  - [ ] Quick start guide
  - [ ] API reference
  - [ ] MCP integration guide
  - [ ] FAQ
  - [ ] Architecture overview
- [ ] GitHub repository
  - [ ] README with demo GIF
  - [ ] Contributing guide
  - [ ] Issue templates
  - [ ] CI/CD pipeline
- [ ] Landing page (codemem.dev)
  - [ ] Product overview
  - [ ] Installation instructions
  - [ ] Token savings calculator
  - [ ] Comparison with alternatives
- [ ] Launch marketing
  - [ ] Product Hunt launch
  - [ ] Hacker News post
  - [ ] Reddit (r/programming, r/vscode, r/neovim)
  - [ ] Twitter/X thread
  - [ ] Dev.to article

### Milestone
```
# Anyone in the world can run:
$ npx codemem init
# And have AI memory working in 30 seconds
```

## Future Roadmap (Post-Launch)

### v1.1 — Team Features
- Shared vector DB across team members (via git)
- Project-level coding conventions stored in memory
- Team-wide token savings dashboard

### v1.2 — Enhanced Intelligence
- Multi-model embedding (code-specific models)
- Query intent classification (bug fix vs feature vs refactor)
- Automatic context window optimization per AI model
- Smart prompt enhancement (inject relevant context automatically)

### v1.3 — Ecosystem
- Plugin marketplace for custom parsers
- Pre-built project templates (Rails, Django, Next.js)
- Integration with error tracking (Sentry, Bugsnag)
- Integration with git (commit-aware indexing)

### v2.0 — Cloud Sync (Optional)
- Optional cloud backup of vector DB
- Cross-machine synchronization
- Team analytics dashboard
- Remains local-first — cloud is opt-in only

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| ONNX model too slow on old hardware | Users abandon tool | Offer "lite" mode with smaller model |
| Tree-sitter WASM fails on some platforms | Chunking broken | Regex fallback parser always available |
| ChromaDB/Vectra corruption | Data loss | Auto-backup, `codemem doctor` repair |
| IDE extension store rejection | Can't distribute | Sideload instructions, MCP as fallback |
| Competitor ships similar feature | Market share loss | Focus on universal (all IDEs) advantage |
| Large monorepos too slow to index | Enterprise users blocked | Incremental + selective indexing options |

## Success Metrics

| Metric | Target (3 months) | Target (12 months) |
|--------|-------------------|---------------------|
| npm weekly downloads | 1,000 | 20,000 |
| GitHub stars | 500 | 5,000 |
| VS Code installs | 2,000 | 30,000 |
| Active daily users | 200 | 5,000 |
| Avg tokens saved/user/day | 100,000 | 200,000 |
| Setup completion rate | > 90% | > 95% |
| User retention (30-day) | > 60% | > 75% |
