import chalk from 'chalk';
import boxen from 'boxen';
import ora, { Ora } from 'ora';

export const ui = {
  // ── Symbols ───────────────────────────────────────────────────────────────
  tick: chalk.green('✓'),
  cross: chalk.red('✗'),
  circle: chalk.gray('○'),
  arrow: chalk.cyan('→'),
  warnSymbol: chalk.yellow('⚠'),

  // ── Formatted messages ────────────────────────────────────────────────────
  success(msg: string): void {
    console.log(`  ${chalk.green('✓')} ${msg}`);
  },

  fail(msg: string): void {
    console.log(`  ${chalk.red('✗')} ${msg}`);
  },

  info(msg: string): void {
    console.log(`  ${chalk.cyan('→')} ${msg}`);
  },

  warn(msg: string): void {
    console.log(`  ${chalk.yellow('⚠')} ${msg}`);
  },

  skip(msg: string): void {
    console.log(`  ${chalk.gray('○')} ${msg}`);
  },

  blank(): void {
    console.log('');
  },

  // ── Boxes ─────────────────────────────────────────────────────────────────
  banner(version: string): void {
    const content = [
      chalk.bold.cyan('CodeMem') + ' ' + chalk.gray(`v${version}`),
      chalk.gray('AI Memory Layer for Your Codebase'),
      '',
      chalk.italic.gray('"Index once, remember forever, switch AI freely."'),
    ].join('\n');

    console.log(boxen(content, {
      padding: 1,
      margin: { top: 1, bottom: 0, left: 2, right: 2 },
      borderStyle: 'round',
      borderColor: 'cyan',
    }));
    console.log('');
  },

  successBox(lines: string[]): void {
    const content = lines.join('\n');
    console.log('');
    console.log(boxen(content, {
      padding: 1,
      margin: { top: 0, bottom: 1, left: 2, right: 2 },
      borderStyle: 'round',
      borderColor: 'green',
    }));
  },

  section(title: string): void {
    console.log('');
    console.log('  ' + chalk.bold(title));
    console.log('  ' + chalk.gray('─'.repeat(38)));
  },

  // ── Spinners ──────────────────────────────────────────────────────────────
  spinner(text: string): Ora {
    return ora({ text, indent: 2 });
  },

  // ── Progress bar (simple text-based) ─────────────────────────────────────
  progress(current: number, total: number, width = 32): string {
    const pct = total === 0 ? 1 : current / total;
    const filled = Math.round(pct * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const pctStr = Math.round(pct * 100).toString().padStart(3);
    return chalk.cyan(bar) + ' ' + chalk.gray(`${pctStr}%`);
  },

  // ── Tables ────────────────────────────────────────────────────────────────
  row(label: string, value: string | number, labelWidth = 18): void {
    const l = chalk.gray(label.padEnd(labelWidth));
    const v = chalk.white(String(value));
    console.log(`    ${l}${v}`);
  },

  // ── Numbers ───────────────────────────────────────────────────────────────
  formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  },

  formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  },

  formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  },
};
