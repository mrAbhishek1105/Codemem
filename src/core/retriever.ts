import { LRUCache } from 'lru-cache';
import { VectraStore } from '../storage/vectra-store.js';
import { MetaStore } from '../storage/meta-store.js';
import { Embedder } from './embedder.js';
import { Chunk, RankedChunk } from '../types/chunk.js';
import { QueryOptions, QueryResult } from '../types/query.js';
import { estimateTokens } from '../utils/tokens.js';
import { hashString } from '../utils/hash.js';
import { logger } from '../utils/logger.js';

interface CachedResult {
  result: QueryResult;
  timestamp: number;
}

export class Retriever {
  private store: VectraStore;
  private meta: MetaStore;
  private embedder: Embedder;
  private projectSummary: string;
  private queryCache: LRUCache<string, CachedResult>;

  constructor(store: VectraStore, meta: MetaStore, embedder: Embedder, projectSummary: string) {
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

    // Check cache
    const cacheKey = hashString(`${queryText}:${topK}:${tokenBudget}`);
    const cached = this.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.result;
    }

    // Step 1: Embed the query
    const queryVector = await this.embedder.embed(queryText);

    // Step 2: Semantic search — get top candidates (2x for re-ranking)
    const candidates = await this.store.search(queryVector, topK * 2);

    if (candidates.length === 0) {
      const emptyResult: QueryResult = {
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
      return emptyResult;
    }

    // Step 3: Hybrid re-ranking (semantic + keyword + recency)
    const ranked = this.hybridRank(queryText, candidates, topK);

    // Step 4: Assemble context within token budget
    const assembled = this.assembleContext(ranked, tokenBudget);

    // Step 5: Get recent changes
    const recentChanges = this.meta.getRecentChanges(24).slice(0, 5).map(c => ({
      file: c.file,
      change: `${c.action} (${c.hash ? 'hash changed' : ''})`,
      when: this.formatRelativeTime(new Date(c.timestamp)),
    }));

    // Estimate tokens saved (vs reading full codebase)
    const totalChunks = await this.store.count();
    const avgChunkTokens = 200;
    const fullReadTokens = totalChunks * avgChunkTokens;
    const tokensSaved = Math.max(0, fullReadTokens - assembled.totalTokens);

    const result: QueryResult = {
      context: {
        project_summary: this.projectSummary,
        chunks: assembled.chunks.map(rc => ({
          id: rc.metadata.chunk_id,
          file_path: rc.header.file_path,
          content: rc.code,
          relevance_score: Math.round(rc.score * 100) / 100,
          type: rc.header.type,
          lines: [rc.metadata.start_line, rc.metadata.end_line],
          is_dependency: rc.is_dependency,
        })),
        recent_changes: recentChanges,
        assembled_text: assembled.text,
        token_count: assembled.totalTokens,
      },
      stats: {
        chunks_searched: candidates.length,
        chunks_returned: assembled.chunks.length,
        tokens_saved_estimate: tokensSaved,
        query_time_ms: Date.now() - startTime,
      },
    };

    // Update stats
    this.meta.incrementQueries(tokensSaved);

    // Cache result
    this.queryCache.set(cacheKey, { result, timestamp: Date.now() });

    logger.info('retriever', `Query completed`, {
      query: queryText.slice(0, 80),
      chunks_returned: result.context.chunks.length,
      query_time_ms: result.stats.query_time_ms,
    } as unknown as Record<string, unknown>);

    return result;
  }

  private hybridRank(
    query: string,
    candidates: Array<{ chunk: Chunk; score: number }>,
    topK: number,
  ): RankedChunk[] {
    const queryTerms = this.tokenize(query.toLowerCase());
    const now = Date.now();

    const W_SEMANTIC = 0.55;
    const W_KEYWORD = 0.30;
    const W_RECENCY = 0.15;

    const ranked = candidates.map(({ chunk, score }) => {
      const semantic = Math.max(0, Math.min(1, score));

      // BM25-lite keyword score
      const keyword = this.bm25Lite(queryTerms, chunk.envelope_text);

      // Recency score
      const lastMod = new Date(chunk.metadata.last_modified).getTime();
      const hoursAgo = (now - lastMod) / (1000 * 60 * 60);
      const recency = hoursAgo < 1 ? 1.0
        : hoursAgo < 4 ? 0.9
        : hoursAgo < 24 ? 0.7
        : hoursAgo < 72 ? 0.4
        : hoursAgo < 168 ? 0.2
        : 0.0;

      const finalScore = semantic * W_SEMANTIC + keyword * W_KEYWORD + recency * W_RECENCY;

      const rankedChunk: RankedChunk = {
        ...chunk,
        score: finalScore,
        semantic_score: semantic,
        keyword_score: keyword,
        recency_score: recency,
        is_dependency: false,
      };
      return rankedChunk;
    });

    // Sort by final score descending, take top K
    return ranked.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  private bm25Lite(queryTerms: string[], docText: string): number {
    if (queryTerms.length === 0) return 0;

    const docTerms = this.tokenize(docText.toLowerCase());
    const docLength = docTerms.length;
    const avgDocLength = 300;
    const k1 = 1.2;
    const b = 0.75;

    let score = 0;
    for (const term of queryTerms) {
      const tf = docTerms.filter(t => t === term).length;
      if (tf === 0) continue;

      const idf = Math.log(1 + 1 / (1 + tf)); // simplified IDF
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
      score += idf * tfNorm;
    }

    // Normalize to 0-1
    return Math.min(1, score / (queryTerms.length * 2));
  }

  private tokenize(text: string): string[] {
    return text
      .replace(/[^a-z0-9_]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  private assembleContext(chunks: RankedChunk[], tokenBudget: number): {
    text: string;
    chunks: RankedChunk[];
    totalTokens: number;
  } {
    const header = `## Project: ${this.projectSummary}\n\n`;
    const headerTokens = estimateTokens(header);

    // Build the file list summary
    const fileList = '### Relevant files:\n' +
      chunks.map((c, i) => `${i + 1}. ${c.header.file_path} — ${c.header.description}`).join('\n') +
      '\n\n';
    const fileListTokens = estimateTokens(fileList);

    let remainingBudget = tokenBudget - headerTokens - fileListTokens - 100; // 100 token buffer
    const includedChunks: RankedChunk[] = [];
    const codeBlocks: string[] = [];

    for (const chunk of chunks) {
      const block = `--- ${chunk.header.file_path} (lines ${chunk.metadata.start_line}-${chunk.metadata.end_line}) [score: ${chunk.score.toFixed(2)}] ---\n${chunk.code}\n`;
      const blockTokens = estimateTokens(block);

      if (remainingBudget - blockTokens < 0 && includedChunks.length > 0) break;

      includedChunks.push(chunk);
      codeBlocks.push(block);
      remainingBudget -= blockTokens;
    }

    const codeSection = '### Code:\n\n' + codeBlocks.join('\n');
    const fullText = header + fileList + codeSection;
    const totalTokens = estimateTokens(fullText);

    return { text: fullText, chunks: includedChunks, totalTokens };
  }

  private formatRelativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return `${Math.floor(diffHrs / 24)}d ago`;
  }
}
