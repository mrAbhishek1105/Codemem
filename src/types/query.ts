export interface QueryOptions {
  top_k?: number;
  token_budget?: number;
  include_dependencies?: boolean;
  include_recent_changes?: boolean;
  file_filter?: string | null;
  language_filter?: string | null;
}

export interface QueryResultChunk {
  id: string;
  file_path: string;
  content: string;
  relevance_score: number;
  type: string;
  lines: [number, number];
  is_dependency: boolean;
}

export interface RecentChange {
  file: string;
  change: string;
  when: string;
}

export interface QueryResult {
  context: {
    project_summary: string;
    chunks: QueryResultChunk[];
    recent_changes: RecentChange[];
    assembled_text: string;
    token_count: number;
  };
  stats: {
    chunks_searched: number;
    chunks_returned: number;
    tokens_saved_estimate: number;
    query_time_ms: number;
  };
}

export interface IndexRequest {
  mode: 'full' | 'incremental' | 'file';
  target?: string | null;
}

export interface IndexResult {
  status: 'completed' | 'failed' | 'in_progress';
  files_indexed: number;
  chunks_created: number;
  duration_ms: number;
  errors: string[];
}
