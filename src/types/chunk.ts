export type ChunkType =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'constant'
  | 'module'
  | 'other';

export interface ChunkHeader {
  file_path: string;
  language: string;
  type: ChunkType;
  name: string;
  exported: boolean;
  description: string;
  imports: string[];
  called_by: string[];
  calls: string[];
}

export interface ChunkMetadata {
  chunk_id: string;
  start_line: number;
  end_line: number;
  token_count: number;
  content_hash: string;
  last_modified: string;
}

export interface Chunk {
  header: ChunkHeader;
  code: string;
  metadata: ChunkMetadata;
  /** The enriched text sent to the embedding model (header comment + code) */
  envelope_text: string;
}

export interface RankedChunk extends Chunk {
  score: number;
  semantic_score: number;
  keyword_score: number;
  recency_score: number;
  is_dependency: boolean;
}

/** Flat record stored in Vectra metadata (all values must be primitives) */
export interface VectraMetadata {
  chunk_id: string;
  file_path: string;
  language: string;
  type: string;
  name: string;
  exported: boolean;
  description: string;
  imports: string;       // JSON-serialized string[]
  called_by: string;     // JSON-serialized string[]
  calls: string;         // JSON-serialized string[]
  code: string;
  envelope_text: string;
  start_line: number;
  end_line: number;
  token_count: number;
  content_hash: string;
  last_modified: string;
}
