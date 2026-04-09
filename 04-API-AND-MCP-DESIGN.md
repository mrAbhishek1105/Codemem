# API & MCP Server Design

## REST API (Sidecar Server)

Base URL: `http://localhost:8432/api/v1`

### Endpoints

#### POST /query
Primary endpoint — search the codebase for relevant context.

```json
// Request
{
  "query": "Fix the login validation bug on signup form",
  "options": {
    "top_k": 10,
    "token_budget": 4000,
    "include_dependencies": true,
    "include_recent_changes": true,
    "file_filter": null,
    "language_filter": null
  }
}

// Response
{
  "context": {
    "project_summary": "my-saas-app — Node.js/TypeScript, React frontend, PostgreSQL",
    "chunks": [
      {
        "id": "src/auth/login.ts::validateCredentials",
        "file_path": "src/auth/login.ts",
        "content": "async function validateCredentials(...) { ... }",
        "relevance_score": 0.94,
        "type": "function",
        "lines": [24, 45],
        "is_dependency": false
      },
      {
        "id": "src/components/SignupForm.tsx::SignupForm",
        "file_path": "src/components/SignupForm.tsx",
        "content": "export function SignupForm() { ... }",
        "relevance_score": 0.87,
        "type": "component",
        "lines": [15, 62],
        "is_dependency": false
      }
    ],
    "recent_changes": [
      {
        "file": "src/auth/login.ts",
        "change": "modified validateCredentials",
        "when": "2h ago"
      }
    ],
    "assembled_text": "## Project: my-saas-app...\n\n--- src/auth/login.ts ---\n...",
    "token_count": 2340
  },
  "stats": {
    "chunks_searched": 12340,
    "chunks_returned": 7,
    "tokens_saved_estimate": 48000,
    "query_time_ms": 45
  }
}
```

#### POST /index
Trigger manual re-indexing.

```json
// Request
{
  "mode": "full" | "incremental" | "file",
  "target": null | "src/auth/"  // optional path filter
}

// Response
{
  "status": "completed",
  "files_indexed": 847,
  "chunks_created": 12340,
  "duration_ms": 23400,
  "errors": []
}
```

#### GET /status
Check sidecar health and project state.

```json
// Response
{
  "status": "running",
  "project": {
    "name": "my-saas-app",
    "root": "/home/user/projects/my-saas-app",
    "files_indexed": 847,
    "total_chunks": 12340,
    "last_indexed": "2025-03-28T10:30:00Z",
    "db_size_mb": 25.4
  },
  "watcher": {
    "active": true,
    "pending_changes": 0
  },
  "model": {
    "name": "all-MiniLM-L6-v2",
    "loaded": true,
    "dimension": 384
  },
  "stats": {
    "queries_served": 342,
    "tokens_saved_total": 4200000,
    "avg_query_time_ms": 38
  }
}
```

#### GET /stats
Detailed token savings statistics.

```json
// Response
{
  "session": {
    "queries": 23,
    "tokens_saved": 184000,
    "avg_context_size": 2100,
    "avg_full_read_size": 52000,
    "savings_percentage": 95.9
  },
  "all_time": {
    "queries": 4230,
    "tokens_saved": 42000000,
    "cost_saved_estimate_usd": 63.00
  },
  "by_provider": {
    "claude": { "queries": 2100, "tokens_saved": 21000000 },
    "gpt-4": { "queries": 1800, "tokens_saved": 18000000 },
    "gemini": { "queries": 330, "tokens_saved": 3000000 }
  }
}
```

#### POST /update
Notify sidecar that AI has generated new code (write-back).

```json
// Request
{
  "file_path": "src/auth/login.ts",
  "action": "modified",
  "content": "// ... new file content ..."
}

// Response
{
  "status": "indexed",
  "chunks_updated": 3,
  "chunks_added": 1,
  "chunks_removed": 0
}
```

#### GET /config
Read current configuration.

#### PUT /config
Update configuration.

```json
// Request
{
  "ai_provider": "claude",
  "token_budget": 4000,
  "top_k": 10,
  "include_tests": false,
  "auto_index": true,
  "debounce_ms": 500
}
```

## MCP Server Specification

CodeMem exposes an MCP (Model Context Protocol) server so that any MCP-compatible
AI tool can directly use it as a context provider.

### MCP Tools

#### search_codebase
```json
{
  "name": "search_codebase",
  "description": "Search the indexed codebase for code relevant to the current task. Returns the most relevant code chunks with their file paths, line numbers, and dependency context. Use this instead of reading files directly to save tokens.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language description of what code you're looking for"
      },
      "max_results": {
        "type": "number",
        "description": "Maximum chunks to return (default: 10)"
      },
      "file_pattern": {
        "type": "string",
        "description": "Optional glob pattern to filter files (e.g., 'src/auth/**')"
      }
    },
    "required": ["query"]
  }
}
```

#### get_file_context
```json
{
  "name": "get_file_context",
  "description": "Get a specific file's content along with its imports, exports, and dependency relationships. More targeted than search_codebase when you know which file you need.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "Relative path to the file"
      },
      "include_dependencies": {
        "type": "boolean",
        "description": "Include imported types and called functions (default: true)"
      }
    },
    "required": ["file_path"]
  }
}
```

#### get_project_overview
```json
{
  "name": "get_project_overview",
  "description": "Get a high-level overview of the project including directory structure, tech stack, main entry points, and architecture patterns. Useful for understanding project context before making changes.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "detail_level": {
        "type": "string",
        "enum": ["brief", "standard", "detailed"],
        "description": "How much detail to include (default: standard)"
      }
    }
  }
}
```

#### report_change
```json
{
  "name": "report_change",
  "description": "Report that you have created or modified a file, so the index can be updated. Call this after generating or modifying code.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "Path of the file that was changed"
      },
      "change_type": {
        "type": "string",
        "enum": ["created", "modified", "deleted"],
        "description": "What kind of change occurred"
      },
      "summary": {
        "type": "string",
        "description": "Brief description of what changed (stored in change history)"
      }
    },
    "required": ["file_path", "change_type"]
  }
}
```

### MCP Resources

#### project://structure
```json
{
  "uri": "project://structure",
  "name": "Project Structure",
  "description": "Current project file tree and module organization",
  "mimeType": "text/plain"
}
```

#### project://recent-changes
```json
{
  "uri": "project://recent-changes",
  "name": "Recent Changes",
  "description": "Files modified in the last 24 hours with change descriptions",
  "mimeType": "text/plain"
}
```

#### project://tech-stack
```json
{
  "uri": "project://tech-stack",
  "name": "Tech Stack",
  "description": "Detected frameworks, libraries, and tooling",
  "mimeType": "application/json"
}
```

### MCP Prompts

#### code-review
```json
{
  "name": "code-review",
  "description": "Review code changes using project context and coding patterns",
  "arguments": [
    {
      "name": "file_path",
      "description": "File to review",
      "required": true
    }
  ]
}
```

#### find-related
```json
{
  "name": "find-related",
  "description": "Find all code related to a specific feature or concept",
  "arguments": [
    {
      "name": "feature",
      "description": "Feature or concept to search for",
      "required": true
    }
  ]
}
```

## Error Handling

All endpoints return consistent error format:

```json
{
  "error": {
    "code": "INDEX_NOT_READY",
    "message": "Codebase is still being indexed. 45% complete.",
    "details": {
      "progress": 0.45,
      "eta_seconds": 12
    }
  }
}
```

### Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| INDEX_NOT_READY | 503 | Indexing in progress |
| PROJECT_NOT_FOUND | 404 | No .codemem/ in current directory |
| MODEL_NOT_LOADED | 503 | Embedding model still loading |
| QUERY_TOO_LONG | 400 | Query exceeds 1000 characters |
| CONFIG_INVALID | 400 | Invalid configuration value |
| DB_CORRUPTED | 500 | Vector DB integrity check failed |
| FILE_NOT_INDEXED | 404 | Requested file not in index |
