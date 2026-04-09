import { resolve } from 'path';
import { ui } from '../ui.js';
import { ConfigStore } from '../../storage/config-store.js';
import { MetaStore } from '../../storage/meta-store.js';

export async function runStatus(): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const configStore = new ConfigStore(projectRoot);

  if (!configStore.exists()) {
    ui.fail('No .codemem/ found. Run "codemem init" first.');
    process.exit(1);
  }

  const config = configStore.read();
  const meta = new MetaStore(projectRoot);
  const stats = meta.getStats();

  // Check if server is running by hitting health endpoint
  let serverRunning = false;
  try {
    const res = await fetch(`http://localhost:${config.server.port}/api/v1/health`, {
      signal: AbortSignal.timeout(1000),
    });
    serverRunning = res.ok;
  } catch {
    serverRunning = false;
  }

  ui.blank();
  console.log('  CodeMem Status');
  ui.section('Project');
  ui.row('Name', config.project.name);
  ui.row('Language', config.project.detected_language);
  if (config.project.detected_framework !== 'unknown') {
    ui.row('Framework', config.project.detected_framework);
  }
  ui.row('Root', projectRoot);

  ui.section('Index');
  ui.row('Files indexed', stats.files_indexed);
  ui.row('Chunks', stats.chunks_indexed);
  ui.row('Last indexed', stats.last_indexed ?? 'never');

  ui.section('Server');
  if (serverRunning) {
    ui.row('Status', `● Running (localhost:${config.server.port})`);
  } else {
    ui.row('Status', `○ Stopped (run "codemem start")`);
  }

  ui.section('Stats');
  ui.row('Queries served', stats.queries_served);
  ui.row('Tokens saved', ui.formatTokens(stats.tokens_saved_total));
  ui.blank();
}
