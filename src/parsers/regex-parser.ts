import { createHash } from 'crypto';
import { Chunk, ChunkHeader, ChunkMetadata, ChunkType } from '../types/chunk.js';
import { estimateTokens } from '../utils/tokens.js';
import { hashContent } from '../utils/hash.js';

/** Patterns to detect function/class/const declarations per language */
interface LangPattern {
  extensions: string[];
  patterns: Array<{
    regex: RegExp;
    type: ChunkType;
    nameGroup: number;
    exportedKeywords: string[];
  }>;
}

const LANG_PATTERNS: LangPattern[] = [
  {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    patterns: [
      {
        regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m,
        type: 'function',
        nameGroup: 1,
        exportedKeywords: ['export'],
      },
      {
        regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m,
        type: 'class',
        nameGroup: 1,
        exportedKeywords: ['export'],
      },
      {
        regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?:=\s*(?:async\s+)?\(|:\s*\w)/m,
        type: 'constant',
        nameGroup: 1,
        exportedKeywords: ['export'],
      },
      {
        regex: /^(?:export\s+)?(?:interface)\s+(\w+)/m,
        type: 'interface',
        nameGroup: 1,
        exportedKeywords: ['export'],
      },
      {
        regex: /^(?:export\s+)?(?:type)\s+(\w+)\s*=/m,
        type: 'type',
        nameGroup: 1,
        exportedKeywords: ['export'],
      },
    ],
  },
  {
    extensions: ['.py'],
    patterns: [
      {
        regex: /^(?:async\s+)?def\s+(\w+)/m,
        type: 'function',
        nameGroup: 1,
        exportedKeywords: [],
      },
      {
        regex: /^class\s+(\w+)/m,
        type: 'class',
        nameGroup: 1,
        exportedKeywords: [],
      },
    ],
  },
  {
    extensions: ['.rs'],
    patterns: [
      {
        regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m,
        type: 'function',
        nameGroup: 1,
        exportedKeywords: ['pub'],
      },
      {
        regex: /^(?:pub\s+)?struct\s+(\w+)/m,
        type: 'class',
        nameGroup: 1,
        exportedKeywords: ['pub'],
      },
      {
        regex: /^(?:pub\s+)?enum\s+(\w+)/m,
        type: 'type',
        nameGroup: 1,
        exportedKeywords: ['pub'],
      },
    ],
  },
  {
    extensions: ['.go'],
    patterns: [
      {
        regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m,
        type: 'function',
        nameGroup: 1,
        exportedKeywords: [],
      },
      {
        regex: /^type\s+(\w+)\s+struct/m,
        type: 'class',
        nameGroup: 1,
        exportedKeywords: [],
      },
      {
        regex: /^type\s+(\w+)\s+interface/m,
        type: 'interface',
        nameGroup: 1,
        exportedKeywords: [],
      },
    ],
  },
  {
    extensions: ['.java', '.kt'],
    patterns: [
      {
        regex: /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/m,
        type: 'function',
        nameGroup: 1,
        exportedKeywords: ['public'],
      },
      {
        regex: /^(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/m,
        type: 'class',
        nameGroup: 1,
        exportedKeywords: ['public'],
      },
      {
        regex: /^(?:public\s+)?interface\s+(\w+)/m,
        type: 'interface',
        nameGroup: 1,
        exportedKeywords: ['public'],
      },
    ],
  },
  {
    extensions: ['.rb'],
    patterns: [
      { regex: /^(?:def\s+)(\w+)/m, type: 'function', nameGroup: 1, exportedKeywords: [] },
      { regex: /^class\s+(\w+)/m, type: 'class', nameGroup: 1, exportedKeywords: [] },
      { regex: /^module\s+(\w+)/m, type: 'module', nameGroup: 1, exportedKeywords: [] },
    ],
  },
];

/** Detect language from file extension */
export function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.kt': 'kotlin',
    '.rb': 'ruby',
    '.php': 'php',
    '.cs': 'csharp',
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.swift': 'swift',
    '.scala': 'scala',
    '.sh': 'bash',
    '.md': 'markdown',
    '.json': 'json',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sql': 'sql',
  };
  return map[ext] ?? 'text';
}

/** Extract imports from a file's content */
function extractImports(content: string, language: string): string[] {
  const imports: string[] = [];
  if (language === 'typescript' || language === 'javascript') {
    const importRegex = /^import\s+.+$/gm;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[0].trim());
    }
    // Also catch require() statements
    const requireRegex = /(?:const|let|var)\s+\{?[\w\s,]+\}?\s*=\s*require\(['"]([^'"]+)['"]\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
      imports.push(match[0].trim());
    }
  } else if (language === 'python') {
    const importRegex = /^(?:import|from)\s+.+$/gm;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[0].trim());
    }
  } else if (language === 'rust') {
    const useRegex = /^use\s+.+;$/gm;
    let match: RegExpExecArray | null;
    while ((match = useRegex.exec(content)) !== null) {
      imports.push(match[0].trim());
    }
  } else if (language === 'go') {
    const importBlockRegex = /import\s*\(([\s\S]*?)\)/g;
    let match: RegExpExecArray | null;
    while ((match = importBlockRegex.exec(content)) !== null) {
      const lines = match[1].split('\n').map(l => l.trim()).filter(l => l);
      imports.push(...lines);
    }
  }
  return imports.slice(0, 20); // Limit to 20 most relevant
}

/** Generate a simple description from function name and signature */
function generateDescription(name: string, type: ChunkType, firstLines: string): string {
  // Check for JSDoc/docstring above the function
  const jsdocMatch = firstLines.match(/\/\*\*\s*([\s\S]*?)\s*\*\//);
  if (jsdocMatch) {
    const text = jsdocMatch[1].replace(/\s*\*\s*/g, ' ').trim();
    const firstSentence = text.split(/[.\n]/)[0].trim();
    if (firstSentence.length > 10) return firstSentence;
  }

  // Check for single-line comment above
  const commentMatch = firstLines.match(/\/\/\s*(.+)$/m);
  if (commentMatch && commentMatch[1].length > 10) {
    return commentMatch[1].trim();
  }

  // Python docstring
  const pyDocMatch = firstLines.match(/"""([\s\S]*?)"""/);
  if (pyDocMatch) {
    return pyDocMatch[1].trim().split('\n')[0].trim();
  }

  // Fallback: generate from name
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  const typeLabel: Record<ChunkType, string> = {
    function: 'Function',
    method: 'Method',
    class: 'Class',
    interface: 'Interface',
    type: 'Type',
    constant: 'Constant',
    module: 'Module',
    other: 'Code',
  };
  return `${typeLabel[type]}: ${words}`;
}

/** Detect function calls within a code block */
function extractCalls(code: string, language: string): string[] {
  const calls: string[] = [];
  if (language === 'typescript' || language === 'javascript') {
    // await someFunction( or someFunction(
    const callRegex = /(?:await\s+)?([a-zA-Z_]\w*(?:\.\w+)*)\s*\(/g;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = callRegex.exec(code)) !== null) {
      const name = match[1];
      // Filter out keywords and built-ins
      if (!['if', 'for', 'while', 'switch', 'catch', 'new', 'return', 'typeof', 'instanceof', 'void'].includes(name) && !seen.has(name)) {
        seen.add(name);
        calls.push(name);
      }
    }
  }
  return calls.slice(0, 10);
}

/** Split file content into logical blocks at blank lines or declaration boundaries */
function splitIntoBlocks(content: string): Array<{ text: string; startLine: number }> {
  const lines = content.split('\n');
  const blocks: Array<{ text: string; startLine: number }> = [];
  let blockStart = 0;
  let braceDepth = 0;
  let currentBlock: string[] = [];
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentBlock.push(line);

    // Count braces to detect block boundaries
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    // Block ends when braces balance back to 0 after opening, or on blank line at top level
    if (inBlock && braceDepth <= 0) {
      blocks.push({ text: currentBlock.join('\n'), startLine: blockStart });
      currentBlock = [];
      blockStart = i + 1;
      inBlock = false;
      braceDepth = 0;
    } else if (!inBlock && braceDepth > 0) {
      inBlock = true;
    } else if (!inBlock && braceDepth === 0 && line.trim() === '' && currentBlock.length > 1) {
      const text = currentBlock.join('\n').trim();
      if (text) {
        blocks.push({ text, startLine: blockStart });
      }
      currentBlock = [];
      blockStart = i + 1;
    }
  }

  // Flush remaining content
  if (currentBlock.length > 0) {
    const text = currentBlock.join('\n').trim();
    if (text) {
      blocks.push({ text, startLine: blockStart });
    }
  }

  return blocks;
}

const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*['"][^'"]{8,}/i,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /ghp_[a-zA-Z0-9]{36}/,
  /sk-[a-zA-Z0-9]{32,}/,
];

function containsSecret(content: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(content));
}

export interface ParseOptions {
  filePath: string;
  content: string;
  lastModified: string;
  minTokens?: number;
  maxTokens?: number;
}

/** Parse a source file into semantic chunks using regex patterns */
export function parseFile(opts: ParseOptions): Chunk[] {
  const { filePath, content, lastModified, minTokens = 20, maxTokens = 1000 } = opts;

  if (containsSecret(content)) return [];

  const ext = '.' + filePath.split('.').pop()!.toLowerCase();
  const language = detectLanguage(filePath);
  const langConfig = LANG_PATTERNS.find(l => l.extensions.includes(ext));
  const imports = extractImports(content, language);
  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  if (!langConfig) {
    // Fallback: chunk by blank-line-separated blocks
    return fallbackChunk({ filePath, content, language, imports, lastModified, minTokens, maxTokens });
  }

  // Use the block splitter to get candidate blocks
  const blocks = splitIntoBlocks(content);

  for (const block of blocks) {
    const blockText = block.text.trim();
    if (!blockText) continue;

    let matched = false;

    for (const pattern of langConfig.patterns) {
      const match = blockText.match(pattern.regex);
      if (!match) continue;

      const name = match[pattern.nameGroup];
      if (!name) continue;

      const exported = pattern.exportedKeywords.some(kw => blockText.startsWith(kw + ' '));
      const type = pattern.type;
      const description = generateDescription(name, type, blockText.slice(0, 500));
      const calls = extractCalls(blockText, language);
      const tokens = estimateTokens(blockText);

      if (tokens < minTokens) { matched = true; break; }

      // Split very large chunks
      const codeBlocks = tokens > maxTokens
        ? splitLargeBlock(blockText, maxTokens)
        : [blockText];

      for (let idx = 0; idx < codeBlocks.length; idx++) {
        const code = codeBlocks[idx];
        const chunkName = codeBlocks.length > 1 ? `${name}[${idx + 1}/${codeBlocks.length}]` : name;
        const chunkId = `${filePath}::${chunkName}`;
        const contentHash = hashContent(code);

        const header: ChunkHeader = {
          file_path: filePath,
          language,
          type,
          name: chunkName,
          exported,
          description: idx > 0 ? `${description} (part ${idx + 1})` : description,
          imports,
          called_by: [],
          calls,
        };

        const envelope = buildEnvelope(header, code);

        const metadata: ChunkMetadata = {
          chunk_id: chunkId,
          start_line: block.startLine + 1,
          end_line: block.startLine + blockText.split('\n').length,
          token_count: estimateTokens(code),
          content_hash: contentHash,
          last_modified: lastModified,
        };

        chunks.push({ header, code, metadata, envelope_text: envelope });
      }

      matched = true;
      break;
    }

    // If no pattern matched but block has enough content, add as 'other'
    if (!matched) {
      const tokens = estimateTokens(blockText);
      if (tokens >= minTokens) {
        const chunkId = `${filePath}::block@${block.startLine + 1}`;
        const header: ChunkHeader = {
          file_path: filePath,
          language,
          type: 'other',
          name: `block@${block.startLine + 1}`,
          exported: false,
          description: `Code block at line ${block.startLine + 1}`,
          imports,
          called_by: [],
          calls: [],
        };
        chunks.push({
          header,
          code: blockText,
          metadata: {
            chunk_id: chunkId,
            start_line: block.startLine + 1,
            end_line: block.startLine + blockText.split('\n').length,
            token_count: tokens,
            content_hash: hashContent(blockText),
            last_modified: lastModified,
          },
          envelope_text: buildEnvelope(header, blockText),
        });
      }
    }
  }

  // Deduplicate by chunk_id
  const seen = new Set<string>();
  return chunks.filter(c => {
    if (seen.has(c.metadata.chunk_id)) return false;
    seen.add(c.metadata.chunk_id);
    return true;
  });
}

/** Build the enriched envelope text that gets embedded */
export function buildEnvelope(header: ChunkHeader, code: string): string {
  const lines: string[] = [
    `// File: ${header.file_path}`,
    `// Language: ${header.language}`,
    `// Type: ${header.type}`,
    `// Name: ${header.name}`,
  ];

  if (header.exported) lines.push('// Exported: yes');
  if (header.description) lines.push(`// Description: ${header.description}`);
  if (header.imports.length > 0) lines.push(`// Imports: ${header.imports.slice(0, 5).join('; ')}`);
  if (header.calls.length > 0) lines.push(`// Calls: ${header.calls.join(', ')}`);

  lines.push('');
  lines.push(code);

  return lines.join('\n');
}

function splitLargeBlock(code: string, maxTokens: number): string[] {
  const lines = code.split('\n');
  const parts: string[] = [];
  let current: string[] = [];
  let tokens = 0;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > maxTokens && current.length > 0) {
      parts.push(current.join('\n'));
      current = [];
      tokens = 0;
    }
    current.push(line);
    tokens += lineTokens;
  }
  if (current.length > 0) parts.push(current.join('\n'));
  return parts;
}

function fallbackChunk(opts: {
  filePath: string;
  content: string;
  language: string;
  imports: string[];
  lastModified: string;
  minTokens: number;
  maxTokens: number;
}): Chunk[] {
  const { filePath, content, language, imports, lastModified, minTokens, maxTokens } = opts;
  const blocks = content.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let lineOffset = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) { lineOffset += blocks[i].split('\n').length; continue; }

    const tokens = estimateTokens(block);
    if (tokens < minTokens) { lineOffset += blocks[i].split('\n').length; continue; }

    if (containsSecret(block)) { lineOffset += blocks[i].split('\n').length; continue; }

    const chunkId = `${filePath}::part${i + 1}`;
    const header: ChunkHeader = {
      file_path: filePath,
      language,
      type: 'other',
      name: `part${i + 1}`,
      exported: false,
      description: `Code section ${i + 1}`,
      imports,
      called_by: [],
      calls: [],
    };

    chunks.push({
      header,
      code: block,
      metadata: {
        chunk_id: chunkId,
        start_line: lineOffset + 1,
        end_line: lineOffset + blocks[i].split('\n').length,
        token_count: tokens,
        content_hash: hashContent(block),
        last_modified: lastModified,
      },
      envelope_text: buildEnvelope(header, block),
    });

    lineOffset += blocks[i].split('\n').length;
  }

  return chunks;
}
