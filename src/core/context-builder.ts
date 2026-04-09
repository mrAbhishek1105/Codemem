/**
 * Structured context builder.
 *
 * Turns a flat list of ranked chunks into a human-readable context block:
 *
 *   ## Project: <summary>
 *
 *   ### Relevant Files:
 *   - login.ts → handles login
 *   - authMiddleware.ts → validates JWT
 *
 *   ### Flow:
 *   validateUser → authMiddleware.verify → respond
 *
 *   ### Code:
 *   --- validateUser (src/auth/login.ts:12-40) ---
 *   // Params: email, password | Calls: db.findOne, bcrypt.compare
 *   function validateUser(...) { ... }
 */

import { RankedChunk } from '../types/chunk.js';
import { estimateTokens } from '../utils/tokens.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FileGroup {
  filePath: string;
  purpose: string;
  chunks: RankedChunk[];
}

export interface BuiltContext {
  text: string;
  chunks: RankedChunk[];
  totalTokens: number;
  fileGroups: FileGroup[];
  flow: string | null;
}

// ─── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build a structured, token-budgeted context block from ranked chunks.
 */
export function buildStructuredContext(
  chunks: RankedChunk[],
  projectSummary: string,
  tokenBudget: number,
): BuiltContext {
  // 1. Group chunks by file
  const fileMap = new Map<string, RankedChunk[]>();
  for (const chunk of chunks) {
    const fp = chunk.header.file_path;
    if (!fileMap.has(fp)) fileMap.set(fp, []);
    fileMap.get(fp)!.push(chunk);
  }

  const fileGroups: FileGroup[] = [...fileMap.entries()].map(([fp, fc]) => ({
    filePath: fp,
    purpose: inferPurpose(fp, fc),
    chunks: fc,
  }));

  // 2. Sort: source files first, markdown last
  fileGroups.sort((a, b) => fileRank(b.filePath) - fileRank(a.filePath));

  // 3. Detect call flow
  const flow = buildFlow(chunks);

  // 4. Assemble header (always present)
  const headerLines: string[] = [
    `## Project: ${projectSummary}`,
    '',
    '### Relevant Files:',
    ...fileGroups.map(g => `- ${g.filePath} → ${g.purpose}`),
    '',
  ];
  if (flow) {
    headerLines.push('### Flow:', flow, '');
  }
  headerLines.push('### Code:', '');

  const headerText = headerLines.join('\n');
  let remainingBudget = tokenBudget - estimateTokens(headerText) - 50;

  // 5. Fill code blocks within budget
  const includedChunks: RankedChunk[] = [];
  const codeLines: string[] = [];

  for (const group of fileGroups) {
    for (const chunk of group.chunks) {
      const block = formatCodeBlock(chunk);
      const blockTokens = estimateTokens(block);

      if (remainingBudget - blockTokens < 0 && includedChunks.length > 0) break;

      includedChunks.push(chunk);
      codeLines.push(block);
      remainingBudget -= blockTokens;
    }
  }

  const fullText = headerText + codeLines.join('\n');

  return {
    text: fullText,
    chunks: includedChunks,
    totalTokens: estimateTokens(fullText),
    fileGroups,
    flow,
  };
}

// ─── Code block formatter ──────────────────────────────────────────────────────

function formatCodeBlock(chunk: RankedChunk): string {
  const loc = `${chunk.header.file_path}:${chunk.metadata.start_line}-${chunk.metadata.end_line}`;
  const header = `--- ${chunk.header.name} (${loc}) [${(chunk.score * 100).toFixed(0)}%]`;

  const meta: string[] = [];
  if (chunk.header.params && chunk.header.params.length > 0) {
    meta.push(`Params: ${chunk.header.params.join(', ')}`);
  }
  if (chunk.header.calls.length > 0) {
    meta.push(`Calls: ${chunk.header.calls.slice(0, 5).join(', ')}`);
  }

  const metaLine = meta.length > 0 ? `// ${meta.join(' | ')}\n` : '';
  return `${header}\n${metaLine}${chunk.code}\n`;
}

// ─── File purpose inference ───────────────────────────────────────────────────

const PURPOSE_MAP: Array<[RegExp, string]> = [
  [/auth|login|jwt|session|passport/i, 'authentication / authorization'],
  [/route|router|controller|handler/i, 'HTTP routing / controller'],
  [/model|schema|entity|orm/i, 'data model / schema'],
  [/service|manager|provider/i, 'business logic / service'],
  [/util|helper|lib|common/i, 'utility / helpers'],
  [/store|storage|db|database|repository/i, 'data storage / persistence'],
  [/config|settings|env/i, 'configuration'],
  [/test|spec|__tests__/i, 'tests'],
  [/middleware/i, 'middleware'],
  [/embed|vector|index/i, 'vector indexing / embeddings'],
  [/parser|parse|ast/i, 'code parsing'],
  [/server|http|api|fastify|express/i, 'HTTP server / API'],
  [/cli|command|cmd/i, 'CLI command'],
  [/type|interface|dto/i, 'type definitions'],
];

function inferPurpose(filePath: string, chunks: RankedChunk[]): string {
  for (const [pattern, label] of PURPOSE_MAP) {
    if (pattern.test(filePath)) return label;
  }
  // Fall back to top chunk's description
  return chunks[0]?.header.description ?? filePath.split('/').pop() ?? filePath;
}

// ─── File rank (higher = shown earlier) ──────────────────────────────────────

function fileRank(fp: string): number {
  const lower = fp.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.json')) return -1;
  if (lower.includes('test') || lower.includes('spec')) return 0;
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 3;
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 2;
  return 1;
}

// ─── Flow detection ───────────────────────────────────────────────────────────

/**
 * Build a simple call-chain description from the chunks' call graphs.
 * e.g. "validateUser → db.findOne → bcrypt.compare"
 */
function buildFlow(chunks: RankedChunk[]): string | null {
  const callGraph = new Map<string, string[]>();
  for (const c of chunks) {
    if (c.header.calls.length > 0) {
      callGraph.set(c.header.name, c.header.calls);
    }
  }
  if (callGraph.size === 0) return null;

  const chunkNames = new Set(chunks.map(c => c.header.name));
  const allCalledNames = new Set<string>();
  for (const calls of callGraph.values()) {
    for (const call of calls) allCalledNames.add(call.split('.')[0]);
  }

  // Entry points: have calls but are not called by anyone in the set
  const entryPoints = [...callGraph.keys()].filter(
    n => !allCalledNames.has(n.split('.')[0]),
  );
  if (entryPoints.length === 0) return null;

  const chain: string[] = [];
  const visited = new Set<string>();

  const trace = (name: string, depth = 0): void => {
    if (visited.has(name) || depth > 6) return;
    visited.add(name);
    chain.push(name);
    for (const call of callGraph.get(name) ?? []) {
      const base = call.split('.')[0];
      if (chunkNames.has(base)) trace(base, depth + 1);
    }
  };

  trace(entryPoints[0]);
  return chain.length >= 2 ? chain.join(' → ') : null;
}
