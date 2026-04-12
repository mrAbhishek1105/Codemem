import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FALLBACK_VERSION = '0.26.0';

let cachedVersion: string | null = null;

export function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) {
        cachedVersion = pkg.version;
        return cachedVersion;
      }
    }
  } catch {
    // Fall back to the bundled version string if package.json is unavailable.
  }

  cachedVersion = FALLBACK_VERSION;
  return cachedVersion;
}

export function resolveServerPort(configPort?: number, fallbackPort = 8432): number {
  const raw = process.env['CODEMEM_PORT'];
  if (raw) {
    const envPort = Number.parseInt(raw, 10);
    if (Number.isFinite(envPort) && envPort > 0) {
      return envPort;
    }
  }

  return configPort ?? fallbackPort;
}

// Centralised runtime config — port/version/baseUrl without needing a project config file.
// CLI commands that have the per-project config should still call resolveServerPort(config.server.port).
const _defaultPort = resolveServerPort();

export const runtimeConfig = {
  port: _defaultPort,
  version: getPackageVersion(),
  baseUrl: `http://localhost:${_defaultPort}`,
} as const;
