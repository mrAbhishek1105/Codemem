/**
 * Executor — safely applies file patches to the project.
 *
 * Safety invariants:
 *   - Never writes files unless `approved === true`.
 *   - Backs up existing files to .codemem/backups/<timestamp>/ before overwriting.
 *   - Provides a preview function for the CLI "show diff before applying" step.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { FilePatch } from './patch-generator.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApplyResult {
  applied: string[];
  backups: string[];
  backupDir: string;
}

// ─── Preview ──────────────────────────────────────────────────────────────────

/**
 * Generate a human-readable diff preview of the patches — no files are written.
 */
export function previewPatches(patches: FilePatch[], projectRoot: string): string {
  const sections: string[] = [];

  for (const patch of patches) {
    const fullPath = join(projectRoot, patch.file);
    sections.push(`=== ${patch.file} ===`);

    if (!existsSync(fullPath)) {
      const lineCount = patch.content.split('\n').length;
      sections.push(`  [NEW FILE] ${lineCount} lines`);
    } else {
      const oldLines = readFileSync(fullPath, 'utf-8').split('\n');
      const newLines = patch.content.split('\n');
      const netChange = newLines.length - oldLines.length;

      // Count changed lines via simple comparison
      const maxLen = Math.max(oldLines.length, newLines.length);
      let changedCount = 0;
      for (let i = 0; i < maxLen; i++) {
        if (oldLines[i] !== newLines[i]) changedCount++;
      }

      sections.push(
        `  ${oldLines.length} → ${newLines.length} lines` +
        ` (${changedCount} line${changedCount !== 1 ? 's' : ''} changed,` +
        ` ${netChange >= 0 ? '+' : ''}${netChange} net)`,
      );

      // Show up to 8 sample changed lines for context
      let shown = 0;
      for (let i = 0; i < Math.min(oldLines.length, newLines.length) && shown < 8; i++) {
        if (oldLines[i] !== newLines[i]) {
          sections.push(`  line ${i + 1}:`);
          sections.push(`    - ${oldLines[i].slice(0, 100)}`);
          sections.push(`    + ${newLines[i].slice(0, 100)}`);
          shown++;
        }
      }
      if (changedCount > shown) {
        sections.push(`  ... and ${changedCount - shown} more changed line(s)`);
      }
    }

    sections.push('');
  }

  return sections.join('\n');
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/**
 * Apply patches to the filesystem.
 *
 * @throws if approved !== true — patches are never written without explicit approval.
 */
export async function applyPatches(
  patches: FilePatch[],
  projectRoot: string,
  approved: boolean,
): Promise<ApplyResult> {
  if (!approved) {
    throw new Error('Patches not approved — set approved=true to apply');
  }

  const backupDir = join(projectRoot, '.codemem', 'backups', String(Date.now()));
  const applied: string[] = [];
  const backups: string[] = [];

  for (const patch of patches) {
    if (!patch.file || !patch.content) continue;

    const fullPath = join(projectRoot, patch.file);

    // Back up the existing file
    if (existsSync(fullPath)) {
      const backupPath = join(backupDir, patch.file);
      mkdirSync(dirname(backupPath), { recursive: true });
      writeFileSync(backupPath, readFileSync(fullPath));
      backups.push(relative(projectRoot, backupPath));
    }

    // Write the new content
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, patch.content, 'utf-8');
    applied.push(patch.file);
  }

  return {
    applied,
    backups,
    backupDir: relative(projectRoot, backupDir),
  };
}
