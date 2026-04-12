/**
 * Planner — analyses codebase context and a user query to produce a
 * step-by-step implementation plan.
 *
 * Output is a structured JSON plan describing which files to touch and why.
 * The plan is consumed by patch-generator.ts and the CLI apply command.
 */

import { callAI, AIConfig, AIMessage } from '../ai-agent.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlanStep {
  file: string;
  action: 'modify' | 'create' | 'delete';
  description: string;
}

export interface Plan {
  query: string;
  summary: string;
  steps: PlanStep[];
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = `You are an expert software architect. Given a codebase context and a user request, produce a concise implementation plan.

Output ONLY valid JSON — no markdown fences, no prose before or after — matching this schema exactly:
{
  "summary": "One-sentence description of the overall change",
  "steps": [
    { "file": "relative/path/from/project/root.ts", "action": "modify|create|delete", "description": "What to change and why" }
  ]
}

Rules:
- Use file paths relative to the project root (e.g. "src/auth/login.ts").
- Base file paths only on files mentioned in the context.
- Keep steps focused — one meaningful change per step.
- Do not include steps for files unrelated to the request.`;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a structured plan for the given query using retrieved codebase context.
 */
export async function generatePlan(
  query: string,
  context: string,
  aiConfig: AIConfig,
): Promise<Plan> {
  const messages: AIMessage[] = [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `[Codebase Context]\n${context}\n\n[Request]\n${query}`,
    },
  ];

  const response = await callAI(aiConfig, messages);

  const jsonMatch = response.content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Planner returned no valid JSON.\nRaw response:\n${response.content.slice(0, 500)}`);
  }

  let parsed: { summary?: string; steps?: unknown[] };
  try {
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch (e) {
    throw new Error(`Planner JSON parse failed: ${String(e)}`);
  }

  const steps: PlanStep[] = (parsed.steps ?? []).map((s) => {
    const step = s as Record<string, unknown>;
    return {
      file: String(step['file'] ?? ''),
      action: (step['action'] as PlanStep['action']) ?? 'modify',
      description: String(step['description'] ?? ''),
    };
  });

  return {
    query,
    summary: String(parsed.summary ?? 'No summary provided'),
    steps,
  };
}

/**
 * Format a plan as a human-readable string for CLI display.
 */
export function formatPlan(plan: Plan): string {
  const lines: string[] = [
    `Summary: ${plan.summary}`,
    '',
    'Steps:',
  ];
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    lines.push(`  ${i + 1}. [${s.action}] ${s.file}`);
    lines.push(`     ${s.description}`);
  }
  return lines.join('\n');
}
