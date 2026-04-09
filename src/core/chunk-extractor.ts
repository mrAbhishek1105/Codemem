/**
 * Unified chunk extractor.
 *
 * Strategy:
 *   • TypeScript / JavaScript → AST parser (precise, semantic, extracts params + calls)
 *   • All other languages (Python, Rust, Go, Java, Ruby…) → regex parser (unchanged)
 *   • AST parse failure → silently falls back to regex
 */

import { Chunk, ChunkHeader, ChunkMetadata, ChunkType } from '../types/chunk.js';
import { parseFile, buildEnvelope, detectLanguage } from '../parsers/regex-parser.js';
import { canParseAST, parseFileAST, extractImportsAST, ASTChunkNode } from './ast-parser.js';
import { hashContent } from '../utils/hash.js';
import { estimateTokens } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ExtractOptions {
  filePath: string;
  content: string;
  lastModified: string;
  minTokens?: number;
  maxTokens?: number;
}

/**
 * Extract semantic chunks from a source file.
 * Automatically chooses AST (TS/JS) or regex (everything else).
 */
export async function extractChunks(opts: ExtractOptions): Promise<Chunk[]> {
  const { filePath, content, lastModified, minTokens = 20, maxTokens = 1000 } = opts;

  if (canParseAST(filePath)) {
    const astNodes = await parseFileAST(filePath, content);

    if (astNodes.length > 0) {
      logger.debug('chunk-extractor', `AST: ${astNodes.length} nodes from ${filePath}`);
      return buildFromAST(astNodes, filePath, content, lastModified, minTokens, maxTokens);
    }

    logger.debug('chunk-extractor', `AST empty for ${filePath} — regex fallback`);
  }

  // Regex fallback (also canonical path for non-TS/JS languages)
  return parseFile({ filePath, content, lastModified, minTokens, maxTokens });
}

// ─── AST → Chunk conversion ───────────────────────────────────────────────────

function buildFromAST(
  nodes: ASTChunkNode[],
  filePath: string,
  source: string,
  lastModified: string,
  minTokens: number,
  maxTokens: number,
): Chunk[] {
  const language = detectLanguage(filePath);
  const imports = extractImportsAST(source);
  const chunks: Chunk[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    const tokens = estimateTokens(node.code);
    if (tokens < minTokens) continue;

    const codeBlocks =
      tokens > maxTokens ? splitLargeBlock(node.code, maxTokens) : [node.code];

    for (let idx = 0; idx < codeBlocks.length; idx++) {
      const code = codeBlocks[idx];
      const chunkName =
        codeBlocks.length > 1 ? `${node.name}[${idx + 1}/${codeBlocks.length}]` : node.name;
      const chunkId = `${filePath}::${chunkName}`;

      if (seen.has(chunkId)) continue;
      seen.add(chunkId);

      // Map AST method type to ChunkType (method → function for backward compat)
      const chunkType: ChunkType =
        node.type === 'method' ? 'function' : (node.type as ChunkType);

      const description =
        node.jsDoc ||
        autoDescription(node.name, node.type, node.params);

      const header: ChunkHeader = {
        file_path: filePath,
        language,
        type: chunkType,
        name: chunkName,
        exported: node.exported,
        description: idx > 0 ? `${description} (part ${idx + 1})` : description,
        imports,
        called_by: [],
        calls: node.calls,
        params: node.params,
      };

      const metadata: ChunkMetadata = {
        chunk_id: chunkId,
        start_line: node.startLine,
        end_line: node.endLine,
        token_count: estimateTokens(code),
        content_hash: hashContent(code),
        last_modified: lastModified,
      };

      const envelope = buildEnvelope(header, code);
      chunks.push({ header, code, metadata, envelope_text: envelope });
    }
  }

  return chunks;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function autoDescription(name: string, type: string, params: string[]): string {
  const readable = name
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .replace(/\./g, ' → ')
    .trim();

  const labels: Record<string, string> = {
    function: 'fn',
    method: 'method',
    class: 'class',
    interface: 'interface',
    type: 'type',
    constant: 'const',
    other: 'code',
  };
  const label = labels[type] ?? 'code';
  const paramStr = params.length > 0 ? `(${params.slice(0, 4).join(', ')})` : '';
  return `${label}: ${readable}${paramStr}`;
}

function splitLargeBlock(code: string, maxTokens: number): string[] {
  const lines = code.split('\n');
  const parts: string[] = [];
  let current: string[] = [];
  let tokens = 0;

  for (const line of lines) {
    const lt = estimateTokens(line);
    if (tokens + lt > maxTokens && current.length > 0) {
      parts.push(current.join('\n'));
      current = [];
      tokens = 0;
    }
    current.push(line);
    tokens += lt;
  }
  if (current.length > 0) parts.push(current.join('\n'));
  return parts;
}
