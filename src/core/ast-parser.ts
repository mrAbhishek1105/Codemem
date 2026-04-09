/**
 * AST-based parser for TypeScript and JavaScript files.
 * Uses @typescript-eslint/typescript-estree to extract semantic nodes
 * (functions, classes, methods, interfaces, type aliases) with full metadata.
 *
 * Falls back gracefully — returns [] on any parse error so the caller
 * can transparently fall back to the regex parser.
 */

import { extname } from 'path';
import { logger } from '../utils/logger.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export type ASTNodeType = 'function' | 'class' | 'method' | 'interface' | 'type' | 'constant' | 'other';

export interface ASTChunkNode {
  name: string;
  type: ASTNodeType;
  code: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  params: string[];
  calls: string[];
  jsDoc: string;
}

// ─── Language gate ─────────────────────────────────────────────────────────────

const AST_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export function canParseAST(filePath: string): boolean {
  return AST_EXTENSIONS.has(extname(filePath).toLowerCase());
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function parseFileAST(
  filePath: string,
  source: string,
): Promise<ASTChunkNode[]> {
  try {
    const { parse } = await import('@typescript-eslint/typescript-estree');

    const ast = parse(source, {
      jsx: filePath.endsWith('.tsx') || filePath.endsWith('.jsx'),
      loc: true,
      range: true,
      comment: true,
      tokens: false,
      errorOnUnknownASTType: false,
      allowInvalidAST: true,
    });

    const sourceLines = source.split('\n');
    const nodes: ASTChunkNode[] = [];

    walkBody(ast.body, source, sourceLines, nodes);

    return nodes;
  } catch (err) {
    logger.debug('ast-parser', `Parse failed for ${filePath} — falling back to regex`, {
      error: String(err),
    } as unknown as Record<string, unknown>);
    return [];
  }
}

// ─── Import extraction (regex is actually better here) ───────────────────────

export function extractImportsAST(source: string): string[] {
  const imports: string[] = [];
  const importRegex = /^import\s+.+$/gm;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(source)) !== null) {
    imports.push(m[0].trim());
  }
  return imports.slice(0, 20);
}

// ─── AST walkers ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

function getLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

function getJSDoc(node: AnyNode, source: string): string {
  if (!node.range) return '';
  const before = source.slice(Math.max(0, (node.range[0] as number) - 600), node.range[0] as number);

  const jsdoc = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
  if (jsdoc) {
    return jsdoc[1].replace(/\s*\*\s*/g, ' ').trim().split(/[.\n]/)[0].trim();
  }
  const lineComment = before.match(/\/\/\s*(.+)\s*\n\s*$/);
  if (lineComment) return lineComment[1].trim();
  return '';
}

function extractParams(node: AnyNode): string[] {
  if (!node?.params) return [];
  const names: string[] = [];
  for (const p of node.params as AnyNode[]) {
    switch (p.type) {
      case 'Identifier':
        names.push(p.name as string);
        break;
      case 'AssignmentPattern':
        if (p.left?.type === 'Identifier') names.push(p.left.name as string);
        break;
      case 'RestElement':
        if (p.argument?.type === 'Identifier') names.push('...' + (p.argument.name as string));
        break;
      case 'TSParameterProperty':
        if (p.parameter?.type === 'Identifier') names.push(p.parameter.name as string);
        break;
      case 'ObjectPattern': names.push('{...}'); break;
      case 'ArrayPattern': names.push('[...]'); break;
    }
  }
  return names;
}

const CALL_SKIP = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'new', 'return',
  'typeof', 'instanceof', 'void', 'require', 'Promise', 'Array',
  'Object', 'Error', 'console', 'JSON', 'Math', 'Date', 'Symbol',
  'Boolean', 'Number', 'String', 'parseInt', 'parseFloat',
]);

function collectCalls(node: AnyNode, calls: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (calls.size >= 10) return;

  if (node.type === 'CallExpression') {
    const callee = node.callee as AnyNode;
    if (callee?.type === 'Identifier' && !CALL_SKIP.has(callee.name as string)) {
      calls.add(callee.name as string);
    } else if (callee?.type === 'MemberExpression') {
      const obj = callee.object?.name as string | undefined;
      const prop = callee.property?.name as string | undefined;
      if (obj && prop && !CALL_SKIP.has(obj)) calls.add(`${obj}.${prop}`);
    }
  }

  for (const key of Object.keys(node)) {
    const child = (node as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && 'type' in item) collectCalls(item, calls);
      }
    } else if (child && typeof child === 'object' && 'type' in child) {
      collectCalls(child, calls);
    }
  }
}

function isExported(node: AnyNode): boolean {
  return (
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ExportDefaultDeclaration'
  );
}

function walkBody(
  body: AnyNode[],
  source: string,
  lines: string[],
  out: ASTChunkNode[],
): void {
  for (const rawNode of body) {
    if (!rawNode) continue;

    const exported = isExported(rawNode);
    const node: AnyNode = exported ? (rawNode.declaration ?? rawNode) : rawNode;
    if (!node?.loc) continue;

    const startLine: number = node.loc.start.line;
    const endLine: number = node.loc.end.line;
    const code = getLines(lines, startLine, endLine);

    switch (node.type as string) {
      case 'FunctionDeclaration': {
        if (!node.id?.name) break;
        const calls = new Set<string>();
        collectCalls(node.body, calls);
        out.push({
          name: node.id.name as string,
          type: 'function',
          code,
          startLine,
          endLine,
          exported,
          params: extractParams(node),
          calls: [...calls],
          jsDoc: getJSDoc(rawNode, source),
        });
        break;
      }

      case 'ClassDeclaration': {
        if (!node.id?.name) break;
        const className = node.id.name as string;
        out.push({
          name: className,
          type: 'class',
          code,
          startLine,
          endLine,
          exported,
          params: [],
          calls: [],
          jsDoc: getJSDoc(rawNode, source),
        });
        // Extract methods from the class body
        if (node.body?.body) {
          walkClassBody(node.body.body as AnyNode[], className, source, lines, out);
        }
        break;
      }

      case 'VariableDeclaration': {
        for (const decl of node.declarations as AnyNode[]) {
          if (!decl.id?.name) continue;
          const init = decl.init as AnyNode | undefined;
          if (!init) continue;
          const isFn =
            init.type === 'ArrowFunctionExpression' ||
            init.type === 'FunctionExpression';
          if (!isFn) continue;
          if (!decl.loc) continue;

          const dCode = getLines(lines, decl.loc.start.line as number, decl.loc.end.line as number);
          const calls = new Set<string>();
          collectCalls(init, calls);

          out.push({
            name: decl.id.name as string,
            type: 'function',
            code: dCode,
            startLine: decl.loc.start.line as number,
            endLine: decl.loc.end.line as number,
            exported,
            params: extractParams(init),
            calls: [...calls],
            jsDoc: getJSDoc(rawNode, source),
          });
        }
        break;
      }

      case 'TSInterfaceDeclaration': {
        if (!node.id?.name) break;
        out.push({
          name: node.id.name as string,
          type: 'interface',
          code,
          startLine,
          endLine,
          exported,
          params: [],
          calls: [],
          jsDoc: getJSDoc(rawNode, source),
        });
        break;
      }

      case 'TSTypeAliasDeclaration': {
        if (!node.id?.name) break;
        out.push({
          name: node.id.name as string,
          type: 'type',
          code,
          startLine,
          endLine,
          exported,
          params: [],
          calls: [],
          jsDoc: getJSDoc(rawNode, source),
        });
        break;
      }

      case 'TSModuleDeclaration': {
        // Namespace / module declaration — recurse into body
        if (node.body?.body) walkBody(node.body.body as AnyNode[], source, lines, out);
        break;
      }
    }
  }
}

function walkClassBody(
  members: AnyNode[],
  className: string,
  source: string,
  lines: string[],
  out: ASTChunkNode[],
): void {
  for (const member of members) {
    if (!member?.loc) continue;
    if (member.type !== 'MethodDefinition' && member.type !== 'PropertyDefinition') continue;

    const key = member.key as AnyNode | undefined;
    const methodName =
      key?.type === 'Identifier' ? (key.name as string) :
      key?.type === 'Literal' ? String(key.value) :
      null;

    if (!methodName || methodName === 'constructor') continue;

    const startLine: number = member.loc.start.line;
    const endLine: number = member.loc.end.line;
    const code = getLines(lines, startLine, endLine);
    const calls = new Set<string>();
    if (member.value) collectCalls(member.value, calls);

    out.push({
      name: `${className}.${methodName}`,
      type: 'method',
      code,
      startLine,
      endLine,
      exported: false,
      params: member.value ? extractParams(member.value) : [],
      calls: [...calls],
      jsDoc: getJSDoc(member, source),
    });
  }
}
