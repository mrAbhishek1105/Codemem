# IDE Adapter Design

## Philosophy

IDE adapters are intentionally thin — they contain ZERO business logic.
All they do is:
1. Detect if the sidecar is running
2. Forward requests to localhost:8432
3. Display status information
4. Provide UI commands (reindex, config, etc.)

This means:
- Bug fixes happen in the sidecar, not in N different plugins
- New features are instantly available in ALL IDEs
- Each adapter is ~100-200 lines of code
- Maintenance burden is minimal

## VS Code Extension

### manifest (package.json)
```json
{
  "name": "codemem",
  "displayName": "CodeMem — AI Memory Layer",
  "description": "Persistent codebase memory for AI assistants. Index once, remember forever.",
  "version": "1.0.0",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["AI", "Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "codemem.status", "title": "CodeMem: Show Status" },
      { "command": "codemem.reindex", "title": "CodeMem: Re-index Project" },
      { "command": "codemem.search", "title": "CodeMem: Search Code Memory" },
      { "command": "codemem.stats", "title": "CodeMem: Show Token Savings" },
      { "command": "codemem.config", "title": "CodeMem: Open Configuration" }
    ],
    "configuration": {
      "title": "CodeMem",
      "properties": {
        "codemem.port": {
          "type": "number",
          "default": 8432,
          "description": "Sidecar server port"
        },
        "codemem.autoStart": {
          "type": "boolean",
          "default": true,
          "description": "Auto-start sidecar when VS Code opens"
        }
      }
    }
  }
}
```

### Core Logic (~150 lines)
```typescript
// extension.ts — simplified structure
import * as vscode from 'vscode';
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:8432/api/v1';

let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  // Create status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusBarItem.command = 'codemem.status';
  statusBarItem.show();

  // Auto-start sidecar if configured
  const config = vscode.workspace.getConfiguration('codemem');
  if (config.get('autoStart')) {
    await startSidecar();
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codemem.status', showStatus),
    vscode.commands.registerCommand('codemem.reindex', triggerReindex),
    vscode.commands.registerCommand('codemem.search', interactiveSearch),
    vscode.commands.registerCommand('codemem.stats', showStats),
    vscode.commands.registerCommand('codemem.config', openConfig),
  );

  // Poll status every 30s
  setInterval(updateStatusBar, 30000);
  updateStatusBar();
}

async function updateStatusBar() {
  try {
    const res = await fetch(`${BASE_URL}/status`);
    const data = await res.json();
    const saved = formatTokens(data.stats.tokens_saved_total);
    statusBarItem.text = `$(database) CodeMem: ${data.project.files_indexed} files | ${saved} saved`;
    statusBarItem.tooltip = `CodeMem is running\nChunks: ${data.project.total_chunks}\nLast sync: ${data.project.last_indexed}`;
  } catch {
    statusBarItem.text = '$(warning) CodeMem: Offline';
    statusBarItem.tooltip = 'Sidecar is not running. Click to start.';
  }
}

// ... other command implementations follow same pattern:
//     make HTTP request to sidecar, display result in VS Code UI
```

## JetBrains Plugin

### plugin.xml
```xml
<idea-plugin>
  <id>dev.codemem.jetbrains</id>
  <name>CodeMem — AI Memory Layer</name>
  <vendor>CodeMem</vendor>
  <description>Persistent codebase memory for AI assistants</description>

  <depends>com.intellij.modules.platform</depends>

  <extensions defaultExtensionNs="com.intellij">
    <postStartupActivity implementation="dev.codemem.StartupActivity"/>
    <statusBarWidgetFactory implementation="dev.codemem.StatusBarFactory"/>
    <projectConfigurable instance="dev.codemem.ConfigPanel"/>
  </extensions>

  <actions>
    <group id="CodeMem.Menu" text="CodeMem" popup="true">
      <add-to-group group-id="ToolsMenu" anchor="last"/>
      <action id="CodeMem.Status" text="Show Status"/>
      <action id="CodeMem.Reindex" text="Re-index Project"/>
      <action id="CodeMem.Search" text="Search Code Memory"/>
      <action id="CodeMem.Stats" text="Show Token Savings"/>
    </group>
  </actions>
</idea-plugin>
```

### Core Logic (~200 lines Kotlin)
```kotlin
// Same pattern: HTTP calls to localhost:8432, display in IDE UI
// Status bar widget shows file count + tokens saved
// Actions trigger REST API calls to sidecar
```

## Neovim Plugin

### Lua Plugin (~100 lines)
```lua
-- codemem.lua
local M = {}
local base_url = "http://localhost:8432/api/v1"

function M.setup(opts)
  opts = opts or {}
  base_url = opts.base_url or base_url

  -- Status line component
  vim.api.nvim_create_user_command("CodeMemStatus", M.status, {})
  vim.api.nvim_create_user_command("CodeMemReindex", M.reindex, {})
  vim.api.nvim_create_user_command("CodeMemSearch", M.search, {})
  vim.api.nvim_create_user_command("CodeMemStats", M.stats, {})

  -- Lualine component (if available)
  -- Returns "CM: 847 files | 42M saved"
end

function M.query(prompt)
  local response = vim.fn.system({
    "curl", "-s", "-X", "POST",
    base_url .. "/query",
    "-H", "Content-Type: application/json",
    "-d", vim.fn.json_encode({ query = prompt })
  })
  return vim.fn.json_decode(response)
end

-- Telescope integration for search
function M.search()
  -- Opens Telescope picker showing indexed chunks
  -- Type to filter by semantic similarity
end

return M
```

## MCP Configuration (Cursor / Continue / Cline)

These tools already support MCP — no plugin needed. Just add config:

### Cursor (~/.cursor/mcp.json)
```json
{
  "mcpServers": {
    "codemem": {
      "command": "npx",
      "args": ["codemem", "mcp-server"],
      "env": {
        "CODEMEM_PROJECT": "${workspaceFolder}"
      }
    }
  }
}
```

### Continue (~/.continue/config.json)
```json
{
  "experimental": {
    "mcpServers": {
      "codemem": {
        "command": "npx",
        "args": ["codemem", "mcp-server"]
      }
    }
  }
}
```

### Claude Code (if using MCP)
```json
{
  "mcpServers": {
    "codemem": {
      "command": "npx",
      "args": ["codemem", "mcp-server"],
      "env": {
        "CODEMEM_PROJECT": "."
      }
    }
  }
}
```

## Auto-Detection Logic

During `codemem init`, the installer auto-detects IDEs:

```
Detection Strategy:
  │
  ├─ VS Code
  │   ├─ Check: `code --version` succeeds?
  │   ├─ Check: ~/.vscode/extensions/ exists?
  │   └─ Action: Install extension to extensions folder
  │
  ├─ Cursor
  │   ├─ Check: ~/.cursor/ directory exists?
  │   ├─ Check: `cursor --version` succeeds?
  │   └─ Action: Add MCP config to ~/.cursor/mcp.json
  │
  ├─ JetBrains (IntelliJ, WebStorm, PyCharm, etc.)
  │   ├─ Check: ~/.config/JetBrains/ exists? (Linux)
  │   ├─ Check: ~/Library/Application Support/JetBrains/ exists? (macOS)
  │   └─ Action: Install plugin via JetBrains CLI
  │
  ├─ Neovim
  │   ├─ Check: `nvim --version` succeeds?
  │   ├─ Check: ~/.config/nvim/ exists?
  │   └─ Action: Add require("codemem").setup() to init.lua
  │
  ├─ Windsurf
  │   ├─ Check: ~/.windsurf/ directory exists?
  │   └─ Action: Add MCP config
  │
  └─ Continue / Cline
      ├─ Check: ~/.continue/ or ~/.cline/ exists?
      └─ Action: Add MCP server config
```

## Communication Protocol

All IDE adapters use the same simple protocol:

```
IDE Adapter                     Sidecar (localhost:8432)
    │                                    │
    │── GET /status ─────────────────────>│  Health check
    │<─ { status: "running", ... } ──────│
    │                                    │
    │── POST /query ─────────────────────>│  AI needs context
    │   { query: "fix login bug" }       │
    │<─ { context: { chunks: [...] } } ──│  Returns relevant code
    │                                    │
    │── POST /index ─────────────────────>│  Manual reindex
    │   { mode: "incremental" }          │
    │<─ { status: "completed" } ─────────│
    │                                    │
```

For MCP-compatible tools, the MCP server handles this natively via
stdio transport — the tool sends MCP tool calls, CodeMem responds
with MCP tool results. No HTTP involved.
