import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
}

class Logger {
  private logDir: string | null = null;
  private debugMode = false;

  configure(projectRoot: string, debug = false): void {
    this.logDir = join(projectRoot, '.codemem', 'logs');
    this.debugMode = debug;
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  setDebug(enabled: boolean): void {
    this.debugMode = enabled;
  }

  private write(level: LogLevel, component: string, message: string, data?: Record<string, unknown>, duration_ms?: number): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...(data ? { data } : {}),
      ...(duration_ms !== undefined ? { duration_ms } : {}),
    };

    if (this.logDir) {
      const line = JSON.stringify(entry) + '\n';
      try {
        appendFileSync(join(this.logDir, 'codemem.log'), line);
        if (level === 'error') {
          appendFileSync(join(this.logDir, 'errors.log'), line);
        }
      } catch {
        // If we can't write logs, silently skip — don't break the main flow
      }
    }

    if (this.debugMode || level === 'error' || level === 'warn') {
      const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${component}]`;
      if (level === 'error') {
        console.error(prefix, message, data ?? '');
      } else if (level === 'warn') {
        console.warn(prefix, message, data ?? '');
      } else if (this.debugMode) {
        console.log(prefix, message, data ?? '');
      }
    }
  }

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.write('debug', component, message, data);
  }

  info(component: string, message: string, data?: Record<string, unknown>, duration_ms?: number): void {
    this.write('info', component, message, data, duration_ms);
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.write('warn', component, message, data);
  }

  error(component: string, message: string, data?: Record<string, unknown>): void {
    this.write('error', component, message, data);
  }
}

export const logger = new Logger();
