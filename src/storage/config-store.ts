import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { CodeMemConfig, DEFAULT_CONFIG } from '../types/config.js';
import { logger } from '../utils/logger.js';

const CONFIG_FILE = 'config.json';
const CODEMEM_DIR = '.codemem';

export class ConfigStore {
  private configPath: string;
  private codememDir: string;

  constructor(projectRoot: string) {
    this.codememDir = join(projectRoot, CODEMEM_DIR);
    this.configPath = join(this.codememDir, CONFIG_FILE);
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }

  /** Initialize a new config for a project */
  create(overrides: Partial<CodeMemConfig> = {}): CodeMemConfig {
    if (!existsSync(this.codememDir)) {
      mkdirSync(this.codememDir, { recursive: true });
    }

    const projectRoot = join(this.codememDir, '..');
    const config: CodeMemConfig = {
      ...DEFAULT_CONFIG,
      ...overrides,
      project: {
        name: basename(projectRoot),
        root: '.',
        detected_language: 'unknown',
        detected_framework: 'unknown',
        ...(overrides.project ?? {}),
      },
    };

    this.write(config);
    return config;
  }

  read(): CodeMemConfig {
    if (!existsSync(this.configPath)) {
      throw new Error(`No .codemem/config.json found. Run "codemem init" first.`);
    }
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf-8')) as CodeMemConfig;
    } catch (err) {
      throw new Error(`Failed to parse config: ${String(err)}`);
    }
  }

  write(config: CodeMemConfig): void {
    if (!existsSync(this.codememDir)) {
      mkdirSync(this.codememDir, { recursive: true });
    }
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.debug('config-store', `Config written to ${this.configPath}`);
  }

  update(patch: Partial<CodeMemConfig>): CodeMemConfig {
    const current = this.read();
    const updated = deepMerge(
      current as unknown as Record<string, unknown>,
      patch as unknown as Record<string, unknown>,
    ) as unknown as CodeMemConfig;
    this.write(updated);
    return updated;
  }

  get codememDirectory(): string {
    return this.codememDir;
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
        tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result;
}
