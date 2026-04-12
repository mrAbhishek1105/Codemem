/**
 * Patch Generator — given a plan and codebase context, calls the AI to produce
 * complete updated file contents for each step in the plan.
 *
 * Each patch contains the FULL new content of a file (not a unified diff).
 * The executor applies them by replacing file contents with backup.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { callAI, AIConfig, AIMessage } from '../ai-agent.js';
import { Plan } from './planner.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FilePatch {
  file: string;       // path relative to project root
  content: string;    // complete new file content
}

export interface PatchSet {
  description: string;
  patches: FilePatch[];
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const PATCH_SYSTEM_PROMPT = `You are an expert software engineer. Given codebase context, an implementation plan, and the current contents of files to be changed, generate the COMPLETE updated content for each file.

Output ONLY valid JSON — no markdown fences, no prose before or after — matching this schema:
{
  "description": "Brief description of what was changed",
  "patches": [
    { "file": "relative/path/to/file.ts", "content": "...complete new file content as a string..." }
  ]
}

Rules:
- Each "content" value must be the COMPLETE new file (not a diff, not a fragment).
- Preserve all imports, exports, types, and surrounding code that is not being changed.
- Use exact file paths from the plan.
- For new files (action: "create"), provide the full file content.
- Do not include patches for files marked action: "delete" — omit them entirely.
- Output nothing except the JSON object.`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate file patches (complete replacements) based on a plan and context.
 */
export async function generatePatch(
  plan: Plan,
  context: string,
  aiConfig: AIConfig,
  projectRoot: string,
): Promise<PatchSet> {
  // Read current contents of files that will be modified
  const currentFiles = plan.steps
    .filter(s => s.action !== 'create')
    .map(s => {
      const fullPath = join(projectRoot, s.file);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        return `--- Current: ${s.file} ---\n${content}`;
      }
      return `--- Current: ${s.file} --- (file not found, treat as new)`;
    })
    .join('\n\n');

  const planText = plan.steps
    .map((s, i) => `${i + 1}. [${s.action}] ${s.file}: ${s.description}`)
    .join('\n');

  const messages: AIMessage[] = [
    { role: 'system', content: PATCH_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `[Codebase Context]\n${context}\n\n` +
        `[Implementation Plan]\nSummary: ${plan.summary}\n${planText}\n\n` +
        (currentFiles ? `[Current File Contents]\n${currentFiles}` : ''),
    },
  ];

  // Use higher token limit for potentially large file outputs
  const response = await callAI({ ...aiConfig, maxTokens: 8192 }, messages);

  const jsonMatch = response.content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Patch generator returned no valid JSON.\nRaw response:\n${response.content.slice(0, 500)}`);
  }

  let parsed: { description?: string; patches?: unknown[] };
  try {
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch (e) {
    throw new Error(`Patch generator JSON parse failed: ${String(e)}`);
  }

  const patches: FilePatch[] = (parsed.patches ?? []).map((p) => {
    const patch = p as Record<string, unknown>;
    return {
      file: String(patch['file'] ?? ''),
      content: String(patch['content'] ?? ''),
    };
  }).filter(p => p.file && p.content);

  return {
    description: String(parsed.description ?? 'Generated patches'),
    patches,
  };
}
