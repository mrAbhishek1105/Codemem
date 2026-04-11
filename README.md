# CodeMem

> **AI-agnostic local memory layer for codebases.**
> Index once, remember forever, switch AI freely.

**Status:** `v1.0.1` — Early release. Core is stable and working. Active development.

CodeMem runs as a local sidecar and gives any AI assistant a persistent, semantic memory of your codebase without sending your source code to the cloud. Use it from the CLI, from HTTP, or as an MCP tool bridge for Claude Desktop / Cursor.

---

## What CodeMem Solves

- AI chat contexts forget your project between sessions.
- Pasting large files wastes tokens and slows down responses.
- Different AI tools require different integration paths.

CodeMem solves this by indexing your codebase locally and retrieving only the most relevant chunks for each query. That keeps prompts small, answers accurate, and your code private.

---

## Requirements

- Node.js `>= 18.0.0` (`node -v`)
- npm `>= 8` (`npm -v`)
- Windows, macOS, or Linux
- No Python required
- No external database required
- Disk space: ~50 MB for model cache + ~5 MB per 1,000 indexed files
- RAM: ~300 MB while running

### Verify your environment

```bash
node -v
npm -v
```

If a command is missing, install Node.js from https://nodejs.org or use your platform package manager.

---

## Installation

### Option A — Clone and build locally (recommended)

```bash
git clone https://github.com/mrabhishek1105/Codemem.git
cd Codemem
npm install
npm run build
npm link
```

### Option B — Install from npm (when published)

```bash
npm install -g @mrabhishek1105/codemem
```

---

## Getting Started

1. Open a terminal in your project folder:

```bash
cd /path/to/your-project
```

2. Initialize CodeMem for that project:

```bash
codemem init
```

This creates a `.codemem/` directory and downloads the embedding model on the first run.

3. Start the local sidecar server:

```bash
codemem start
```

By default, the server listens on `localhost:8432`.

4. Search your codebase from the CLI:

```bash
codemem search "how does authentication work"
```

5. Query the HTTP API directly:

```bash
curl -X POST http://localhost:8432/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"query":"how does the payment flow work","options":{"top_k":5}}'
```

If the sidecar is running on a custom port, replace `8432` with that port.

### Need command help?

```bash
codemem --help
codemem <command> --help
```

---

## Core Usage

### `codemem init`

Create the local project index and download the model.

```bash
codemem init
codemem init --yes
codemem init --debug
```

### `codemem start`

Start the sidecar server.

```bash
codemem start
codemem start --port 9000
codemem start --debug
```

### `codemem stop`

Stop the running sidecar.

```bash
codemem stop
```

### `codemem status`

Show the current index and server state.

```bash
codemem status
```

### `codemem stats`

Show token savings and usage statistics.

```bash
codemem stats
```

### `codemem search <query>`

Search your indexed codebase.

```bash
codemem search "how does auth work"
codemem search "database models" --top 8
```

### `codemem reindex`

Rebuild the local index.

```bash
codemem reindex
codemem reindex --full
```

### `codemem ask <query>`

Ask an AI about your project with code-based context.

This command auto-detects provider from `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, but you can override using `--provider`.

```bash
codemem ask "what does the payment service do"
codemem ask "where is auth handled" --provider openai --model gpt-4o --mode direct
codemem ask "explain the codebase" --provider openai --base-url https://openrouter.ai/api/v1
```

### `codemem chat`

Start an interactive multi-turn chat session with code memory.

```bash
codemem chat
codemem chat --provider openai --base-url https://openrouter.ai/api/v1
```

### Hosted web AI providers

CodeMem now supports OpenAI-compatible hosted APIs through `--base-url` or `OPENAI_BASE_URL`.

```bash
export OPENAI_API_KEY=your-key
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
codemem ask "summarize the authentication flow" --provider openai
```

This works with OpenAI-compatible gateways such as OpenRouter and similar web-based AI services.

### `codemem mcp`

Start the MCP JSON-RPC bridge for Claude Desktop / Cursor style tools.

```bash
codemem mcp
```

If your sidecar is running on a non-default port:

```bash
CODEMEM_PORT=9000 codemem mcp
```

### `codemem doctor`

Run a health check on the installation and environment.

```bash
codemem doctor
```

---

## HTTP API

CodeMem provides a local REST API on the running sidecar.

### `POST /api/v1/query`

Search the current project and return assembled code context.

```bash
curl -X POST http://localhost:8432/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"query":"how does authentication work","options":{"top_k":5}}'
```

### `POST /api/v1/index`

Trigger indexing from the API.

```bash
curl -X POST http://localhost:8432/api/v1/index \
  -H "Content-Type: application/json" \
  -d '{"mode":"incremental"}'
```

### `GET /api/v1/status`

Check server and index state.

```bash
curl http://localhost:8432/api/v1/status
```

If you use a custom port, replace `8432` with the port passed to `codemem start --port <port>`.

---

## MCP Tool Bridge

`codemem mcp` starts a JSON-RPC tool bridge over stdin/stdout.

It exposes the `search_codebase` tool for local semantic code search and forwards requests to the HTTP sidecar.

Use `CODEMEM_PORT` to point the MCP bridge at a custom sidecar port.

```bash
CODEMEM_PORT=9000 codemem mcp
```

This is useful for AI applications that support local tool integration via Claude Desktop, Cursor, or other JSON-RPC tool runners.

---

## How to resolve common requirements

- If `codemem` is not installed, run `npm install` and `npm run build`.
- If the CLI is not found, run `npm link` from the repo root.
- If the sidecar cannot connect, ensure it is running with `codemem start` and use `CODEMEM_PORT` when needed.
- If the index is stale or corrupted, remove `.codemem/db` and run `codemem init` again.
- If the model is missing, `codemem init` downloads it automatically.

---

## Notes

- `.codemem/` is generated automatically by `codemem init`.
- The first initialization downloads the model and performs the full index build.
- Incremental updates after that are much faster.
- Use different project folders for separate indexes.
- If a port is busy, choose a different port and update `CODEMEM_PORT` for MCP.
