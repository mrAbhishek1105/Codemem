import { existsSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import { MetaStore } from '../../storage/meta-store.js';
import { VectraStore } from '../../storage/vectra-store.js';
import { Embedder } from '../../core/embedder.js';
import { Indexer } from '../../core/indexer.js';
import { analyzeProject, buildProjectSummary } from '../../core/project-analyzer.js';
import { logger } from '../../utils/logger.js';
import { IndexProgress } from '../../core/indexer.js';
import { getPackageVersion } from '../../utils/runtime.js';

const VERSION = getPackageVersion();

const DEFAULT_CODEMEMIGNORE = `# CodeMem ignore file
# Inherits all .gitignore patterns automatically.
# Add extra patterns below.

# Large data directories
data/
fixtures/
datasets/

# Generated docs
docs/api/
docs/generated/

# IDE generated
.vscode/
.idea/

# Specific generated files
src/generated/**
`;

export async function runInit(options: { debug?: boolean; yes?: boolean }): Promise<void> {
  const projectRoot = resolve(process.cwd());

  // Setup logger first (before .codemem/ exists)
  if (options.debug) logger.setDebug(true);

  ui.banner(VERSION);

  console.log('  Detecting project...');

  // Analyze project
  const projectInfo = analyzeProject(projectRoot);
  ui.success(`Project root: ${projectRoot}`);
  ui.success(`Language: ${projectInfo.language}`);
  if (projectInfo.framework !== 'unknown') ui.success(`Framework: ${projectInfo.framework}`);
  ui.success(`Package manager: ${projectInfo.packageManager}`);
  ui.blank();

  // Create .codemem/ directory and config
  const configStore = new ConfigStore(projectRoot);
  const metaStore = new MetaStore(projectRoot);

  if (configStore.exists() && !options.yes) {
    ui.warn('Project already initialized. Re-indexing...');
    ui.blank();
  }

  const config = configStore.create({
    project: {
      name: projectInfo.name,
      root: '.',
      detected_language: projectInfo.language,
      detected_framework: projectInfo.framework,
    },
  });

  // Configure logger now that .codemem/ exists
  logger.configure(projectRoot, options.debug ?? false);

  // Add .codemem/ to .gitignore
  addToGitignore(projectRoot);

  // Write default .codememignore if it doesn't exist
  const codememignorePath = join(projectRoot, '.codememignore');
  if (!existsSync(codememignorePath)) {
    writeFileSync(codememignorePath, DEFAULT_CODEMEMIGNORE, 'utf-8');
    ui.success('Created .codememignore');
  }

  // Initialize vector store
  const store = new VectraStore(projectRoot);
  await store.init();

  // Set up embedder with download progress
  console.log('  Loading embedding model...');
  console.log(ui.progress(0, 1));
  process.stdout.write('\x1b[1A\x1b[2K'); // overwrite line

  let lastPct = 0;
  const embedder = new Embedder({
    onProgress: (p) => {
      if (p.status === 'downloading' && p.total && p.loaded) {
        const pct = Math.round((p.loaded / p.total) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          process.stdout.write('\x1b[1A\x1b[2K');
          process.stdout.write(`  ${ui.progress(p.loaded, p.total)}  ${ui.formatBytes(p.loaded)} / ${ui.formatBytes(p.total)}\n`);
        }
      }
    },
  });

  const modelSpinner = ui.spinner('Loading model (downloading ~90MB on first run)...').start();
  try {
    await embedder.load();
    modelSpinner.succeed('Embedding model ready');
  } catch (err) {
    modelSpinner.fail(`Failed to load model: ${String(err)}`);
    process.exit(1);
  }

  ui.blank();

  // Index the codebase
  console.log('  Indexing codebase...');
  const indexer = new Indexer(projectRoot, store, metaStore, configStore, embedder);

  let lastFile = '';
  const indexResult = await indexer.indexFull((progress: IndexProgress) => {
    if (progress.currentFile && progress.currentFile !== lastFile) {
      lastFile = progress.currentFile;
    }
    if (progress.phase === 'embedding' && progress.filesTotal > 0) {
      process.stdout.write('\x1b[1A\x1b[2K');
      process.stdout.write(
        `  ${ui.progress(progress.filesProcessed, progress.filesTotal)}  ` +
        `${progress.filesProcessed}/${progress.filesTotal} files\n`
      );
    }
  });

  ui.blank();
  ui.success(`Scanned ${indexResult.filesScanned} files`);
  ui.success(`Created ${indexResult.chunksCreated} code chunks`);
  ui.success(`Index size: ${join(projectRoot, '.codemem', 'db')} (on disk)`);
  ui.success(`Completed in ${ui.formatMs(indexResult.durationMs)}`);

  if (indexResult.errors.length > 0) {
    ui.warn(`${indexResult.errors.length} files had errors (see .codemem/logs/errors.log)`);
  }

  // Store project summary
  const summary = buildProjectSummary(projectInfo);
  metaStore.setProjectSummary(summary);

  ui.blank();

  // Show port info
  const port = config.server.port;
  ui.successBox([
    `✓ Ready! Your AI now has memory.`,
    ``,
    `  Run the sidecar:   codemem start`,
    `  Query the index:   codemem search "your query"`,
    `  Check status:      codemem status`,
    `  See token savings: codemem stats`,
    ``,
    `  API available at:  http://localhost:${port}`,
  ]);

  logger.info('init', 'Initialization complete', {
    filesIndexed: indexResult.filesIndexed,
    chunksCreated: indexResult.chunksCreated,
    durationMs: indexResult.durationMs,
  } as unknown as Record<string, unknown>);
}

function addToGitignore(projectRoot: string): void {
  const gitignorePath = join(projectRoot, '.gitignore');
  const entry = '\n# CodeMem index (machine-specific)\n.codemem/\n';

  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.codemem')) {
        appendFileSync(gitignorePath, entry);
        ui.success('Added .codemem/ to .gitignore');
      }
    } catch {}
  } else {
    try {
      writeFileSync(gitignorePath, `.codemem/\n`, 'utf-8');
      ui.success('Created .gitignore with .codemem/ entry');
    } catch {}
  }
}
