import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, basename } from 'path';
import { logger } from '../utils/logger.js';

export interface ProjectInfo {
  name: string;
  root: string;
  language: string;
  framework: string;
  packageManager: string;
  entryPoints: string[];
  totalFiles: number;
  description: string;
}

interface PackageJson {
  name?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  main?: string;
}

export function analyzeProject(projectRoot: string): ProjectInfo {
  logger.info('project-analyzer', `Analyzing project at ${projectRoot}`);

  const name = detectProjectName(projectRoot);
  const { language, framework, packageManager } = detectStack(projectRoot);
  const entryPoints = detectEntryPoints(projectRoot, language);
  const totalFiles = countFiles(projectRoot);

  const info: ProjectInfo = {
    name,
    root: projectRoot,
    language,
    framework,
    packageManager,
    entryPoints,
    totalFiles,
    description: `${name} — ${language}${framework !== 'unknown' ? `/${framework}` : ''} project`,
  };

  logger.info('project-analyzer', 'Analysis complete', info as unknown as Record<string, unknown>);
  return info;
}

function detectProjectName(projectRoot: string): string {
  // Try package.json
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
      if (pkg.name) return pkg.name;
    } catch {}
  }

  // Try Cargo.toml
  const cargoPath = join(projectRoot, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    try {
      const content = readFileSync(cargoPath, 'utf-8');
      const match = content.match(/name\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
  }

  // Try pyproject.toml
  const pyprojectPath = join(projectRoot, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      const match = content.match(/name\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
  }

  // Fallback to directory name
  return basename(projectRoot);
}

function detectStack(projectRoot: string): { language: string; framework: string; packageManager: string } {
  // Node.js / JavaScript / TypeScript
  if (existsSync(join(projectRoot, 'package.json'))) {
    let framework = 'unknown';
    let language = 'javascript';

    try {
      const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as PackageJson;
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (existsSync(join(projectRoot, 'tsconfig.json'))) language = 'typescript';
      if (allDeps['next']) framework = 'Next.js';
      else if (allDeps['react']) framework = 'React';
      else if (allDeps['vue']) framework = 'Vue';
      else if (allDeps['svelte']) framework = 'Svelte';
      else if (allDeps['express']) framework = 'Express';
      else if (allDeps['fastify']) framework = 'Fastify';
      else if (allDeps['@nestjs/core']) framework = 'NestJS';
      else if (allDeps['electron']) framework = 'Electron';
    } catch {}

    const packageManager = existsSync(join(projectRoot, 'pnpm-lock.yaml')) ? 'pnpm'
      : existsSync(join(projectRoot, 'yarn.lock')) ? 'yarn'
      : 'npm';

    return { language, framework, packageManager };
  }

  // Python
  if (existsSync(join(projectRoot, 'requirements.txt')) ||
      existsSync(join(projectRoot, 'pyproject.toml')) ||
      existsSync(join(projectRoot, 'setup.py'))) {
    let framework = 'unknown';

    const reqPath = join(projectRoot, 'requirements.txt');
    if (existsSync(reqPath)) {
      try {
        const content = readFileSync(reqPath, 'utf-8').toLowerCase();
        if (content.includes('django')) framework = 'Django';
        else if (content.includes('flask')) framework = 'Flask';
        else if (content.includes('fastapi')) framework = 'FastAPI';
      } catch {}
    }

    return { language: 'python', framework, packageManager: 'pip' };
  }

  // Rust
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    return { language: 'rust', framework: 'unknown', packageManager: 'cargo' };
  }

  // Go
  if (existsSync(join(projectRoot, 'go.mod'))) {
    return { language: 'go', framework: 'unknown', packageManager: 'go modules' };
  }

  // Java
  if (existsSync(join(projectRoot, 'pom.xml')) || existsSync(join(projectRoot, 'build.gradle'))) {
    const hasMaven = existsSync(join(projectRoot, 'pom.xml'));
    return { language: 'java', framework: 'unknown', packageManager: hasMaven ? 'maven' : 'gradle' };
  }

  // Ruby
  if (existsSync(join(projectRoot, 'Gemfile'))) {
    let framework = 'unknown';
    try {
      const content = readFileSync(join(projectRoot, 'Gemfile'), 'utf-8').toLowerCase();
      if (content.includes('rails')) framework = 'Rails';
      else if (content.includes('sinatra')) framework = 'Sinatra';
    } catch {}
    return { language: 'ruby', framework, packageManager: 'bundler' };
  }

  return { language: 'unknown', framework: 'unknown', packageManager: 'unknown' };
}

function detectEntryPoints(projectRoot: string, language: string): string[] {
  const candidates: string[] = [];

  if (language === 'typescript' || language === 'javascript') {
    const entries = ['src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
                     'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js'];
    for (const e of entries) {
      if (existsSync(join(projectRoot, e))) candidates.push(e);
    }
  } else if (language === 'python') {
    const entries = ['main.py', 'app.py', '__main__.py', 'manage.py', 'run.py'];
    for (const e of entries) {
      if (existsSync(join(projectRoot, e))) candidates.push(e);
    }
  } else if (language === 'rust') {
    if (existsSync(join(projectRoot, 'src/main.rs'))) candidates.push('src/main.rs');
    if (existsSync(join(projectRoot, 'src/lib.rs'))) candidates.push('src/lib.rs');
  } else if (language === 'go') {
    if (existsSync(join(projectRoot, 'main.go'))) candidates.push('main.go');
  }

  return candidates;
}

function countFiles(projectRoot: string, maxDepth = 4): number {
  let count = 0;
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) walk(fullPath, depth + 1);
          else count++;
        } catch {}
      }
    } catch {}
  }
  walk(projectRoot, 0);
  return count;
}

export function buildProjectSummary(info: ProjectInfo): string {
  const parts: string[] = [
    `Project: ${info.name}`,
    `Language: ${info.language}`,
  ];
  if (info.framework !== 'unknown') parts.push(`Framework: ${info.framework}`);
  if (info.packageManager !== 'unknown') parts.push(`Package manager: ${info.packageManager}`);
  if (info.entryPoints.length > 0) parts.push(`Entry points: ${info.entryPoints.join(', ')}`);
  parts.push(`Files: ~${info.totalFiles}`);
  return parts.join(' | ');
}
