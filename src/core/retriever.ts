/**
 * Retriever — semantic search + hybrid re-ranking + structured context assembly.
 *
 * Scoring pipeline (per chunk):
 *   finalScore = semantic×0.55 + keyword×0.30 + recency×0.15
 *              + fileTypeBoost
 *              + chunkTypeBoost
 *              + intentBoost   (applied when query intent = 'code')
 *
 * Query intent detection:
 *   If query contains implement/fix/debug/how/where/add/create/refactor →
 *   source-code chunks get +0.15 and markdown chunks get -0.25
 */

import { LRUCache } from 'lru-cache';
import { VectraStore } from '../storage/vectra-store.js';
import { MetaStore } from '../storage/meta-store.js';
import { Embedder } from './embedder.js';
import { buildStructuredContext } from './context-builder.js';
import { Chunk, RankedChunk } from '../types/chunk.js';
import { QueryOptions, QueryResult } from '../types/query.js';
import { estimateTokens } from '../utils/tokens.js';
import { hashString } from '../utils/hash.js';
import { logger } from '../utils/logger.js';

// ─── Cache entry ──────────────────────────────────────────────────────────────

interface CachedResult {
  result: QueryResult;
  timestamp: number;
}

// ─── Query intent ─────────────────────────────────────────────────────────────

type QueryIntent = 'code' | 'general';

const CODE_INTENT_TERMS = new Set([
  'implement', 'fix', 'debug', 'how', 'where', 'add', 'create',
  'refactor', 'change', 'update', 'write', 'build', 'make',
  'show me', 'find', 'explain', 'what does', 'what is',
]);

function detectIntent(query: string): QueryIntent {
  const lower = query.toLowerCase();
  for (const term of CODE_INTENT_TERMS) {
    if (lower.includes(term)) return 'code';
  }
  return 'general';
}

// ─── Scoring boosts ───────────────────────────────────────────────────────────

function fileTypeBoost(filePath: string, intent: QueryIntent): number {
  const lower = filePath.toLowerCase();
  // Markdown / docs
  if (lower.endsWith('.md') || lower.endsWith('.txt')) {
    return intent === 'code' ? -0.25 : -0.10;
  }
  // Config / data files
  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return intent === 'code' ? -0.10 : 0;
  }
  // Tests — slightly lower unless query explicitly mentions tests
  if (lower.includes('test') || lower.includes('spec')) {
    return intent === 'code' ? -0.05 : 0;
  }
  // Core source files
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 0.20;
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 0.15;
  return 0;
}

function chunkTypeBoost(type: string): number {
  switch (type) {
    case 'function': return 0.20;
    case 'method':   return 0.20;
    case 'class':    return 0.15;
    case 'constant': return 0.05;
    default:         return 0;
  }
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class Retriever {
  private store: VectraStore;
  private meta: MetaStore;
  private embedder: Embedder;
  private projectSummary: string;
  private queryCache: LRUCache<string, CachedResult>;

  constructor(
    store: VectraStore,
    meta: MetaStore,
    embedder: Embedder,
    projectSummary: string,
  ) {
    this.store = store;
    this.meta = meta;
    this.embedder = embedder;
    this.projectSummary = projectSummary;
    this.queryCache = new LRUCache<string, CachedResult>({ max: 100 });
  }

  invalidateCache(): void {
    this.queryCache.clear();
  }

  updateProjectSummary(summary: string): void {
    this.projectSummary = summary;
  }

  async query(queryText: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const startTime = Date.now();
    const topK = opts.top_k ?? 6;
    const tokenBudget = opts.token_budget ?? 4000;

    // Cache check
    const cacheKey = hashString(`${queryText}:${topK}:${tokenBudget}`);
    const cached = this.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.result;
    }

    // 1. Embed the query
    const queryVector = await this.embedder.embed(queryText);

    // 2. Get candidates (2× for re-ranking headroom)
    const candidates = await this.store.search(queryVector, topK * 2);

    if (candidates.length === 0) {
      const empty: QueryResult = {
        context: {
          project_summary: this.projectSummary,
          chunks: [],
          recent_changes: [],
          assembled_text: `## Project: ${this.projectSummary}\n\nNo relevant code found for: "${queryText}"`,
          token_count: estimateTokens(this.projectSummary),
        },
        stats: {
          chunks_searched: 0,
          chunks_returned: 0,
          tokens_saved_estimate: 0,
          query_time_ms: Date.now() - startTime,
        },
      };
      return empty;
    }

    // 3. Hybrid re-ranking with all boosts
    const intent = detectIntent(queryText);
    const ranked = this.hybridRank(queryText, candidates, topK, intent);

    // 4. Build structured context (context-builder)
    const built = buildStructuredContext(ranked, this.projectSummary, tokenBudget);

    // 5. Recent changes
    const recentChanges = this.meta.getRecentChanges(24).slice(0, 5).map(c => ({
      file: c.file,
      change: `${c.action} (${c.hash ? 'hash changed' : ''})`,
      when: this.formatRelativeTime(new Date(c.timestamp)),
    }));

    // 6. Token savings estimate
    const totalChunks = await this.store.count();
    const tokensSaved = Math.max(0, totalChunks * 200 - built.totalTokens);

    const result: QueryResult = {
      context: {
        project_summary: this.projectSummary,
        chunks: built.chunks.map(rc => ({
          id: rc.metadata.chunk_id,
          file_path: rc.header.file_path,
          content: rc.code,
          relevance_score: Math.round(rc.score * 100) / 100,
          type: rc.header.type,
          lines: [rc.metadata.start_line, rc.metadata.end_line],
          is_dependency: rc.is_dependency,
        })),
        recent_changes: recentChanges,
        assembled_text: built.text,
        token_count: built.totalTokens,
      },
      stats: {
        chunks_searched: candidates.length,
        chunks_returned: built.chunks.length,
        tokens_saved_estimate: tokensSaved,
        query_time_ms: Date.now() - startTime,
      },
    };

    this.meta.incrementQueries(tokensSaved);
    this.queryCache.set(cacheKey, { result, timestamp: Date.now() });

    logger.info('retriever', 'Query completed', {
      query: queryText.slice(0, 80),
      intent,
      chunks_returned: result.context.chunks.length,
      query_time_ms: result.stats.query_time_ms,
    } as unknown as Record<string, unknown>);

    return result;
  }

  // ─── Hybrid ranking ─────────────────────────────────────────────────────────

  private hybridRank(
    query: string,
    candidates: Array<{ chunk: Chunk; score: number }>,
    topK: number,
    intent: QueryIntent,
  ): RankedChunk[] {
    const queryTerms = this.tokenize(query.toLowerCase());
    const now = Date.now();

    const W_SEMANTIC = 0.55;
    const W_KEYWORD  = 0.30;
    const W_RECENCY  = 0.15;

    const ranked = candidates.map(({ chunk, score }) => {
      const semantic = Math.max(0, Math.min(1, score));
      const keyword  = this.bm25Lite(queryTerms, chunk.envelope_text);

      // Recency score
      const hoursAgo =
        (now - new Date(chunk.metadata.last_modified).getTime()) / 3_600_000;
      const recency =
        hoursAgo < 1   ? 1.0 :
        hoursAgo < 4   ? 0.9 :
        hoursAgo < 24  ? 0.7 :
        hoursAgo < 72  ? 0.4 :
        hoursAgo < 168 ? 0.2 : 0.0;

      const baseScore =
        semantic * W_SEMANTIC +
        keyword  * W_KEYWORD  +
        recency  * W_RECENCY;

      // Apply boosts (clamped to 0–1)
      const boosted = Math.min(
        1,
        Math.max(
          0,
          baseScore +
            fileTypeBoost(chunk.header.file_path, intent) +
            chunkTypeBoost(chunk.header.type),
        ),
      );

      const rc: RankedChunk = {
        ...chunk,
        score: boosted,
        semantic_score: semantic,
        keyword_score: keyword,
        recency_score: recency,
        is_dependency: false,
      };
      return rc;
    });

    return ranked.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // ─── BM25-lite ───────────────────────────────────────────────────────────────

  private bm25Lite(queryTerms: string[], docText: string): number {
    if (queryTerms.length === 0) return 0;

    const docTerms = this.tokenize(docText.toLowerCase());
    const docLength = docTerms.length;
    const k1 = 1.2;
    const b  = 0.75;
    const avgDoc = 300;

    let score = 0;
    for (const term of queryTerms) {
      const tf = docTerms.filter(t => t === term).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + 1 / (1 + tf));
      const tfNorm =
        (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDoc)));
      score += idf * tfNorm;
    }
    return Math.min(1, score / (queryTerms.length * 2));
  }

  private tokenize(text: string): string[] {
    return text
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private formatRelativeTime(date: Date): string {
    const diffMin = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return `${Math.floor(diffHrs / 24)}d ago`;
  }
}
