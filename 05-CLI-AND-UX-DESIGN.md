# CLI Design & User Experience

## Installation

### Method 1: npx (Zero Install — Recommended)
```bash
npx codemem init
```
This downloads and runs CodeMem without permanent global installation.
After first run, it caches locally for instant re-use.

### Method 2: Global Install
```bash
npm install -g codemem
codemem init
```

### Method 3: pip (Python users)
```bash
pip install codemem
codemem init
```

## Command Reference

### codemem init

The most important command. Sets up everything in one shot.

```
$ codemem init

  ╭─────────────────────────────────────────╮
  │                                         │
  │   CodeMem v1.0.0                        │
  │   AI Memory Layer for Your Codebase     │
  │                                         │
  ╰─────────────────────────────────────────╯

  Detecting project...
  ✓ Project root: /home/user/projects/my-app
  ✓ Language: TypeScript/JavaScript
  ✓ Framework: React + Express
  ✓ Package manager: npm

  Downloading embedding model (first time only)...
  ████████████████████████████░░░░  87% (78MB/90MB)
  ✓ Model cached at ~/.codemem/models/

  Indexing codebase...
  ████████████████████████████████  100%
  ✓ Scanned 847 files
  ✓ Created 12,340 code chunks
  ✓ Built dependency graph
  ✓ Index size: 25.4 MB

  Detecting IDEs...
  ✓ VS Code detected — adapter installed
  ✓ Cursor detected — MCP config added
  ○ JetBrains not detected — skipped

  Starting background service...
  ✓ Sidecar running on localhost:8432
  ✓ File watcher active

  ╭─────────────────────────────────────────╮
  │                                         │
  │   Ready! Your AI now has memory.        │
  │                                         │
  │   Try a prompt in your IDE —            │
  │   CodeMem will serve relevant           │
  │   context automatically.                │
  │                                         │
  │   Run `codemem status` to check health  │
  │   Run `codemem stats` to see savings    │
  │                                         │
  ╰─────────────────────────────────────────╯
```

### Init Flow (Behind the Scenes)

```
codemem init
  │
  ├─ 1. Check prerequisites
  │     ├─ Node.js >= 18 installed?
  │     ├─ Python >= 3.9 installed? (for ChromaDB; Vectra fallback if not)
  │     ├─ Disk space available? (need ~200MB for model + DB)
  │     └─ Write permissions in project directory?
  │
  ├─ 2. Create .codemem/ directory
  │     ├─ Initialize config.json with detected settings
  │     ├─ Create .codememignore with sensible defaults
  │     └─ Add .codemem/ to .gitignore (if not present)
  │
  ├─ 3. Download embedding model (if not cached)
  │     ├─ Check ~/.codemem/models/ for existing download
  │     ├─ Download all-MiniLM-L6-v2 ONNX model (~90MB)
  │     └─ Verify checksum
  │
  ├─ 4. Index codebase
  │     ├─ Scan files (respect ignore patterns)
  │     ├─ Detect language per file
  │     ├─ Chunk using tree-sitter parsers
  │     ├─ Generate embeddings (batched, ~500 chunks/sec)
  │     ├─ Store in ChromaDB
  │     └─ Build dependency graph
  │
  ├─ 5. Detect and configure IDEs
  │     ├─ VS Code: copy adapter to .vscode/extensions/
  │     ├─ Cursor: add MCP server config to cursor settings
  │     ├─ JetBrains: install plugin via CLI
  │     ├─ Neovim: add lua config snippet
  │     └─ Continue/Cline: add MCP server config
  │
  ├─ 6. Start sidecar
  │     ├─ Launch background process on localhost:8432
  │     ├─ Start file watcher
  │     ├─ Register auto-start on IDE open
  │     └─ Write PID to .codemem/server.pid
  │
  └─ 7. Output success summary
```

### codemem status

```
$ codemem status

  CodeMem Status
  ──────────────────────────────────

  Project     my-app
  Root        /home/user/projects/my-app

  Index
    Files          847
    Chunks         12,340
    DB size        25.4 MB
    Last sync      2 minutes ago

  Server
    Status         ● Running (localhost:8432)
    Uptime         4h 23m
    File watcher   ● Active (0 pending)

  Model
    Name           all-MiniLM-L6-v2
    Dimensions     384
    Status         ● Loaded

  Connected IDEs
    VS Code        ● Connected
    Cursor         ● Connected (MCP)
```

### codemem stats

```
$ codemem stats

  Token Savings Report
  ──────────────────────────────────

  Today
    Queries           23
    Tokens saved      184,000
    Avg context       2,100 tokens (vs 52,000 full read)
    Savings           95.9%

  This Week
    Queries           142
    Tokens saved      1,240,000
    Est. cost saved   $1.86

  All Time
    Queries           4,230
    Tokens saved      42,000,000
    Est. cost saved   $63.00

  By AI Provider
    Claude            2,100 queries   $31.50 saved
    GPT-4             1,800 queries   $27.00 saved
    Gemini              330 queries    $4.50 saved

  ──────────────────────────────────
  Tip: You've saved enough tokens to fill 420
  full context windows. That's 42 million tokens
  your AI didn't need to re-read.
```

### codemem config

```
$ codemem config --list

  Current Configuration
  ──────────────────────────────────

  ai_provider        claude
  token_budget       4000
  top_k              10
  include_tests      false
  auto_index         true
  debounce_ms        500
  model              all-MiniLM-L6-v2
  port               8432

$ codemem config --ai claude          # Switch AI provider
$ codemem config --budget 6000        # Increase token budget
$ codemem config --include-tests      # Include test files in index
$ codemem config --port 9000          # Change sidecar port
```

### codemem reindex

```
$ codemem reindex

  Re-indexing codebase...
  ████████████████████████████████  100%

  ✓ 847 files scanned
  ✓ 12,340 chunks created
  ✓ 23 chunks updated (changed files)
  ✓ 2 chunks removed (deleted files)
  ✓ Dependency graph rebuilt
  ✓ Completed in 8.2s
```

### codemem search

Interactive search for debugging and exploration.

```
$ codemem search "authentication middleware"

  Results (top 5):
  ──────────────────────────────────

  1. src/middleware/auth.ts :: authMiddleware     [0.96]
     JWT token validation and user session management

  2. src/routes/auth.ts :: loginHandler           [0.89]
     Handles POST /api/auth/login

  3. src/utils/jwt.ts :: verifyToken              [0.84]
     Token verification and refresh logic

  4. src/types/auth.ts :: AuthContext             [0.78]
     TypeScript interfaces for auth types

  5. src/tests/auth.test.ts :: authTests          [0.71]
     Authentication test suite
```

### codemem stop / start

```
$ codemem stop
  ✓ Sidecar stopped (was running for 4h 23m)

$ codemem start
  ✓ Sidecar started on localhost:8432
  ✓ File watcher active
  ✓ 847 files indexed, ready to serve
```

### codemem doctor

Diagnostics command for troubleshooting.

```
$ codemem doctor

  CodeMem Diagnostics
  ──────────────────────────────────

  ✓ Node.js v20.11.0 (>= 18 required)
  ✓ Disk space: 42 GB available
  ✓ Model downloaded and verified
  ✓ ChromaDB operational
  ✓ Port 8432 available
  ✓ File watcher permissions OK
  ✓ .codemem/ directory writable
  ✓ .gitignore includes .codemem/

  IDE Connections
  ✓ VS Code adapter installed (v1.0.0)
  ✓ Cursor MCP config present
  ○ JetBrains not detected

  Index Health
  ✓ 12,340 chunks indexed
  ✓ No orphaned vectors
  ✓ Dependency graph consistent
  ✓ File hashes up to date

  ──────────────────────────────────
  All checks passed. CodeMem is healthy.
```

### codemem clean

```
$ codemem clean

  This will delete the local index and all cached data.
  The embedding model will NOT be removed (shared across projects).

  Are you sure? (y/N): y

  ✓ Removed .codemem/db/ (25.4 MB)
  ✓ Removed .codemem/meta/
  ✓ Removed .codemem/logs/
  ✓ Config preserved at .codemem/config.json

  Run `codemem init` to re-index.
```

### codemem repair

Diagnose and fix index corruption. Safe to run at any time.

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

### codemem upgrade

Check for updates and upgrade in place.

```
$ codemem upgrade

  Current version: 1.1.0
  Latest version:  1.2.0

  Upgrade? (y/N): y

  ✓ Updated codemem to 1.2.0
  ✓ Running schema migration v1 → v2
  ✓ Done!
```

### codemem feedback

Rate the last query result to improve retrieval over time.

```
$ codemem feedback --good    # Last query returned relevant code
$ codemem feedback --bad     # Last query missed relevant code
```

### codemem query --debug

Run a query with full diagnostic output (timing, scores, chunks).

```
$ codemem query --debug "fix login validation"

  Query: "fix login validation"
  Intent: bug_fix (auto-detected)
  Embedding: 11ms
  Vector search: 26ms (20 candidates)
  Hybrid ranking: 9ms
  Context assembly: 6ms
  Total: 52ms

  Top chunks:
    1. src/auth/login.ts::validateCredentials   score=0.91
    2. src/routes/auth.ts::loginHandler          score=0.82
    ...
```

## IDE Integration UX

### VS Code

**Status Bar Item:**
```
CodeMem: ● 847 files | 42M tokens saved
```

**Commands (Ctrl+Shift+P):**
- CodeMem: Show Status
- CodeMem: Re-index Project
- CodeMem: Search Code Memory
- CodeMem: Show Token Savings
- CodeMem: Open Configuration

**Notifications:**
- On first install: "CodeMem is indexing your project... (23s remaining)"
- On large file change: "CodeMem: Re-indexed 45 files after git pull"
- Weekly summary: "CodeMem saved you 1.2M tokens this week (~$1.86)"

### Cursor / Continue / Cline (MCP Integration)

These tools support MCP natively. CodeMem appears as an available tool:

```
Available MCP Tools:
  🔍 search_codebase — Find relevant code chunks
  📁 get_file_context — Get file with dependencies
  📋 get_project_overview — Project structure summary
  📝 report_change — Update index after changes
```

The AI assistant automatically uses these tools instead of reading raw files,
resulting in dramatically fewer tokens per query.

## Configuration File

### .codemem/config.json

```json
{
  "version": "1.0",
  "project": {
    "name": "my-app",
    "root": ".",
    "detected_language": "typescript",
    "detected_framework": "react"
  },
  "indexing": {
    "auto_index": true,
    "debounce_ms": 500,
    "include_tests": false,
    "max_file_size_kb": 500,
    "chunk_size_target": 300,
    "chunk_size_max": 1000
  },
  "retrieval": {
    "default_top_k": 10,
    "default_token_budget": 4000,
    "include_dependencies": true,
    "include_recent_changes": true,
    "recency_boost_hours": 24,
    "recency_boost_factor": 1.2
  },
  "server": {
    "port": 8432,
    "auto_start": true
  },
  "model": {
    "name": "all-MiniLM-L6-v2",
    "path": "~/.codemem/models/all-MiniLM-L6-v2"
  },
  "ai_provider": {
    "default": "claude",
    "providers": {
      "claude": { "model": "claude-sonnet-4-20250514" },
      "openai": { "model": "gpt-4o" },
      "gemini": { "model": "gemini-2.5-pro" }
    }
  },
  "stats": {
    "track_savings": true,
    "weekly_summary": true
  }
}
```

### .codememignore

```gitignore
# Inherits all .gitignore patterns automatically
# Add additional patterns below

# Large data files
data/
fixtures/
*.sql

# Generated documentation
docs/api/

# Specific files to skip
src/generated/**
```
