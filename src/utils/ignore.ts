import ignore, { Ignore } from 'ignore';
import { readFileSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';

const DEFAULT_IGNORE_PATTERNS = [
  // Dependencies
  'node_modules/',
  'vendor/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.env/',
  'target/',
  'build/',
  'dist/',
  '.next/',
  '.nuxt/',
  'out/',

  // Generated
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Cargo.lock',

  // Binary & media
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.ico',
  '*.woff', '*.woff2', '*.ttf', '*.eot',
  '*.mp3', '*.mp4', '*.avi', '*.mov',
  '*.zip', '*.tar', '*.gz', '*.rar',
  '*.pdf', '*.doc', '*.docx', '*.xls', '*.xlsx',
  '*.exe', '*.dll', '*.so', '*.dylib',
  '*.bin', '*.dat',

  // IDE & OS
  '.git/',
  '.DS_Store',
  '*.swp',
  '*.swo',
  '.idea/',
  '.vscode/settings.json',
  'Thumbs.db',

  // Data files (large)
  '*.sqlite',
  '*.db',

  // Secrets — never index these
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.jks',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  '.aws/',
  '.ssh/',
  'id_rsa*',
  '*.secret',

  // CodeMem own data
  '.codemem/',
];

export class IgnoreFilter {
  private ig: Ignore;
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.ig = ignore();
    this.ig.add(DEFAULT_IGNORE_PATTERNS);
    this.loadGitignore();
    this.loadCodeMemIgnore();
  }

  private loadGitignore(): void {
    const gitignorePath = join(this.projectRoot, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        const content = readFileSync(gitignorePath, 'utf-8');
        this.ig.add(content);
      } catch {
        // Skip if unreadable
      }
    }
  }

  private loadCodeMemIgnore(): void {
    const codememignorePath = join(this.projectRoot, '.codememignore');
    if (existsSync(codememignorePath)) {
      try {
        const content = readFileSync(codememignorePath, 'utf-8');
        this.ig.add(content);
      } catch {
        // Skip if unreadable
      }
    }
  }

  /** Returns true if the file should be excluded from indexing */
  shouldIgnore(absolutePath: string): boolean {
    // Get path relative to project root, using forward slashes
    let rel = relative(this.projectRoot, absolutePath);
    // normalize to forward slashes on Windows
    rel = rel.split(sep).join('/');
    if (!rel || rel.startsWith('..')) return true;
    return this.ig.ignores(rel);
  }
}

export { DEFAULT_IGNORE_PATTERNS };
