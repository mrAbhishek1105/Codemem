/**
 * Agent HTTP routes — plan → patch → validate → apply pipeline.
 *
 * POST /api/v1/plan      Generate a structured implementation plan
 * POST /api/v1/patch     Generate file patches based on a plan
 * POST /api/v1/validate  Run build/tests to check project health
 * POST /api/v1/apply     Apply patches (requires approved=true)
 */

import { FastifyInstance } from 'fastify';
import { Retriever } from '../../core/retriever.js';
import { generatePlan, Plan } from '../../core/agent/planner.js';
import { generatePatch, FilePatch } from '../../core/agent/patch-generator.js';
import { validateProject } from '../../core/agent/validator.js';
import { applyPatches, previewPatches } from '../../core/agent/executor.js';
import { resolveAIConfig } from '../../utils/ai-config.js';
import { createApiError } from '../middleware/error-handler.js';

// ─── Request body shapes ──────────────────────────────────────────────────────

interface AIOptions {
  provider?: string;
  model?: string;
  base_url?: string;
}

interface PlanBody extends AIOptions {
  query: string;
  top_k?: number;
}

interface PatchBody extends AIOptions {
  plan: Plan;
  top_k?: number;
}

interface ApplyBody {
  patches: FilePatch[];
  approved: boolean;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerAgentRoutes(
  app: FastifyInstance,
  retriever: Retriever,
  projectRoot: string,
  isReady: () => boolean,
): void {

  // POST /api/v1/plan — retrieve context and produce a step-by-step plan
  app.post<{ Body: PlanBody }>('/api/v1/plan', async (request, reply) => {
    if (!isReady()) {
      throw createApiError('INDEX_NOT_READY', 'Index is not ready. Run "codemem init" first.', 503);
    }

    const { query, top_k = 8, provider, model, base_url } = request.body;
    if (!query || typeof query !== 'string') {
      throw createApiError('QUERY_REQUIRED', 'query is required and must be a string', 400);
    }

    const aiConfig = resolveAIConfig({ provider, model, baseUrl: base_url });
    if (!aiConfig) {
      throw createApiError('NO_AI_KEY', 'No AI API key configured (OPENAI_API_KEY or ANTHROPIC_API_KEY)', 400);
    }

    const queryResult = await retriever.query(query, { top_k });
    const context = queryResult.context.assembled_text;

    const plan = await generatePlan(query, context, aiConfig);
    return reply.send(plan);
  });

  // POST /api/v1/patch — generate complete file replacements based on a plan
  app.post<{ Body: PatchBody }>('/api/v1/patch', async (request, reply) => {
    if (!isReady()) {
      throw createApiError('INDEX_NOT_READY', 'Index is not ready. Run "codemem init" first.', 503);
    }

    const { plan, top_k = 8, provider, model, base_url } = request.body;
    if (!plan || typeof plan !== 'object') {
      throw createApiError('PLAN_REQUIRED', 'plan object is required', 400);
    }

    const aiConfig = resolveAIConfig({ provider, model, baseUrl: base_url });
    if (!aiConfig) {
      throw createApiError('NO_AI_KEY', 'No AI API key configured (OPENAI_API_KEY or ANTHROPIC_API_KEY)', 400);
    }

    const queryResult = await retriever.query(plan.query, { top_k });
    const context = queryResult.context.assembled_text;

    const patchSet = await generatePatch(plan, context, aiConfig, projectRoot);
    const preview = previewPatches(patchSet.patches, projectRoot);

    return reply.send({ ...patchSet, preview });
  });

  // POST /api/v1/validate — run build/tests, return pass/fail
  app.post('/api/v1/validate', async (_request, reply) => {
    const result = await validateProject(projectRoot);
    return reply.send(result);
  });

  // POST /api/v1/apply — write patches to disk (requires approved=true)
  app.post<{ Body: ApplyBody }>('/api/v1/apply', async (request, reply) => {
    const { patches, approved } = request.body;

    if (!Array.isArray(patches) || patches.length === 0) {
      throw createApiError('PATCHES_REQUIRED', 'patches must be a non-empty array', 400);
    }
    if (approved !== true) {
      throw createApiError(
        'APPROVAL_REQUIRED',
        'approved must be explicitly true — review the patches and confirm before applying',
        400,
      );
    }

    const result = await applyPatches(patches, projectRoot, true);
    return reply.send(result);
  });
}
