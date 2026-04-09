# Competitive Analysis & Positioning

## Landscape Overview

Several tools already do codebase indexing or AI-assisted coding.
CodeMem's positioning must be clear: what it does differently.

## Competitor Comparison

### Cursor
- Built-in codebase indexing
- LOCKED to Cursor IDE only
- Cloud-based indexing
- Proprietary, closed ecosystem
- CodeMem advantage: Works in ANY IDE, fully local, switch AI freely

### GitHub Copilot
- Workspace indexing via @workspace command
- VS Code and JetBrains only
- Microsoft/GitHub cloud infrastructure
- Tied to GitHub Copilot subscription
- CodeMem advantage: AI-agnostic, no subscription for memory, local-first

### Continue.dev
- Open-source AI coding assistant
- Has basic codebase indexing
- Supports MCP
- Limited IDE support
- CodeMem advantage: Better chunking, universal IDE support, token tracking

### Cline
- VS Code extension with MCP support
- Reads files on demand (no persistent indexing)
- CodeMem advantage: Persistent memory, incremental updates, cross-IDE

### Cody (Sourcegraph)
- Enterprise-focused
- Cloud-based indexing
- Excellent code search
- Expensive, complex setup
- CodeMem advantage: Free, local, one-command setup, individual-friendly

### Aider
- Terminal-based AI coding
- Sends repository map to AI
- Smart file selection
- Terminal only — no IDE integration
- CodeMem advantage: IDE integration, vector search, visual status

## CodeMem's Unique Position

```
                    ┌─────────────────────────────────────────┐
                    │         CodeMem Unique Position          │
                    │                                         │
  Works in ALL IDEs ◄─── No competitor does this ────►  100% Local
   (VS Code,        │                                  (No cloud,
    JetBrains,      │   AI-Provider                     no cost,
    Neovim,         │   Agnostic                        offline)
    Cursor,         │   ──────────
    Windsurf,       │   Switch GPT → Claude → Gemini
    Continue,       │   with ZERO re-indexing
    Cline)          │
                    └─────────────────────────────────────────┘
```

### Three Pillars

1. **Universal** — One tool across all IDEs and all AI providers
2. **Local** — Zero cloud, zero cost, zero data leaving machine
3. **Effortless** — One command setup, invisible after that

No existing tool combines all three. That's the gap.

## Positioning Statement

"CodeMem is a free, open-source memory layer that gives any AI coding
assistant instant, persistent knowledge of your codebase — across any IDE
and any AI provider, running entirely on your machine."

## Key Differentiators to Emphasize

### In Marketing
- "npx codemem init — that's it. 30 seconds to AI memory."
- "Switch from GPT to Claude? Your AI remembers everything."
- "Save 96% of tokens. See exactly how much with codemem stats."
- "Your code never leaves your machine. Ever."

### In Technical Documentation
- Universal MCP server — works with any MCP-compatible tool
- AST-based smart chunking — not naive line-splitting
- Dependency-aware retrieval — gets the types and callers too
- Co-change detection — knows which files change together
- Incremental indexing — 50ms updates, not full re-scans

## Open Source Strategy

- MIT License — maximum adoption, no friction
- Core engine is fully open source
- No "premium" features locked behind paywall
- Revenue model (future): optional team/enterprise cloud sync
- Community contributions welcome for:
  - New language parsers
  - New IDE adapters
  - Embedding model improvements
  - Performance optimizations
