export interface IndexingConfig {
  auto_index: boolean;
  debounce_ms: number;
  include_tests: boolean;
  max_file_size_kb: number;
  chunk_size_target: number;
  chunk_size_max: number;
}

export interface RetrievalConfig {
  default_top_k: number;
  default_token_budget: number;
  include_dependencies: boolean;
  include_recent_changes: boolean;
  recency_boost_hours: number;
  recency_boost_factor: number;
}

export interface ServerConfig {
  port: number;
  auto_start: boolean;
}

export interface ModelConfig {
  name: string;
  path: string;
}

export interface CodeMemConfig {
  version: string;
  schema_version: number;
  project: {
    name: string;
    root: string;
    detected_language: string;
    detected_framework: string;
  };
  indexing: IndexingConfig;
  retrieval: RetrievalConfig;
  server: ServerConfig;
  model: ModelConfig;
}

export const DEFAULT_CONFIG: Omit<CodeMemConfig, 'project'> = {
  version: '0.1.0',
  schema_version: 1,
  indexing: {
    auto_index: true,
    debounce_ms: 500,
    include_tests: false,
    max_file_size_kb: 500,
    chunk_size_target: 300,
    chunk_size_max: 1000,
  },
  retrieval: {
    default_top_k: 6,
    default_token_budget: 4000,
    include_dependencies: true,
    include_recent_changes: true,
    recency_boost_hours: 24,
    recency_boost_factor: 1.2,
  },
  server: {
    port: 8432,
    auto_start: true,
  },
  model: {
    name: 'Xenova/all-MiniLM-L6-v2',
    path: '',
  },
};
