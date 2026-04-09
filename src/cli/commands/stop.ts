import { resolve, join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { ui } from '../ui.js';

export async function runStop(): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const pidFile = join(projectRoot, '.codemem', 'server.pid');

  if (!existsSync(pidFile)) {
    ui.warn('No running sidecar found for this project.');
    ui.info('PID file not found at .codemem/server.pid');
    process.exit(0);
  }

  let pid: number;
  try {
    pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) throw new Error('Invalid PID');
  } catch (err) {
    ui.fail(`Could not read PID file: ${String(err)}`);
    process.exit(1);
  }

  try {
    process.kill(pid, 'SIGTERM');
    ui.success(`Sent SIGTERM to sidecar (PID ${pid})`);
    // Give it a moment to clean up
    await new Promise(r => setTimeout(r, 500));

    // Check if still running
    try {
      process.kill(pid, 0); // Signal 0 = check if process exists
      // Still alive — force kill
      process.kill(pid, 'SIGKILL');
      ui.warn('Process did not stop gracefully, sent SIGKILL');
    } catch {
      // Process is gone — good
    }

    // Clean up PID file
    try { unlinkSync(pidFile); } catch {}
    ui.success('Sidecar stopped');
  } catch (err) {
    // Process might already be gone
    const msg = String(err);
    if (msg.includes('ESRCH') || msg.includes('No such process')) {
      ui.warn('Sidecar was not running (stale PID file)');
      try { unlinkSync(pidFile); } catch {}
    } else {
      ui.fail(`Failed to stop sidecar: ${msg}`);
      process.exit(1);
    }
  }
}
