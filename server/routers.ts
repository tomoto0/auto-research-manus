import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { isWorkerExecutionMode } from "./_core/pipeline-execution";
import { nanoid } from "nanoid";
import * as db from "./db";
import { unifiedSearch } from "./literature";
import { executePipeline, approveStage, rejectStage, isAwaitingApproval, type EventEmitter } from "./pipeline-engine";
import { PIPELINE_STAGES, DEFAULT_RUN_CONFIG, CONFERENCE_TEMPLATES, type PipelineEvent, type RunConfig } from "../shared/pipeline";
import { uploadChunkProcedure, assembleChunksProcedure, registerFileProcedure } from "./upload-procedures";

// ─── In-memory event store for SSE/polling ───
const runEventBuffers = new Map<string, PipelineEvent[]>();
const runEventListeners = new Map<string, Set<(event: PipelineEvent) => void>>();
const ACTIVE_RUN_STATUSES = new Set(["running", "pending", "awaiting_approval"]);

function truncateText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  if (value.length <= maxChars) return value;
  const remaining = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n...[truncated ${remaining.toLocaleString()} chars]`;
}

function truncateRecordValues(record: unknown, maxEntries: number, maxValueChars: number): Record<string, unknown> | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const entries = Object.entries(record as Record<string, unknown>).slice(0, maxEntries);
  return Object.fromEntries(entries.map(([key, value]) => {
    if (typeof value === "string") return [key, truncateText(value, maxValueChars)];
    return [key, value];
  }));
}

function sanitizePipelineDetailPayload(payload: any) {
  const isActive = ACTIVE_RUN_STATUSES.has(payload?.status);
  const stageOutputLimit = isActive ? 20_000 : 80_000;
  const textLimit = isActive ? 160_000 : 400_000;
  const codeLimit = isActive ? 60_000 : 180_000;
  const metricsEntryLimit = isActive ? 140 : 260;

  return {
    ...payload,
    errorMessage: truncateText(payload?.errorMessage, 12_000),
    paperMarkdown: truncateText(payload?.paperMarkdown, textLimit),
    paperLatex: truncateText(payload?.paperLatex, textLimit),
    referencesBib: truncateText(payload?.referencesBib, isActive ? 80_000 : 160_000),
    experimentCode: truncateText(payload?.experimentCode, codeLimit),
    reviewReport: truncateText(payload?.reviewReport, isActive ? 80_000 : 180_000),
    stages: Array.isArray(payload?.stages) ? payload.stages.map((stage: any) => ({
      ...stage,
      output: truncateText(stage?.output, stageOutputLimit),
      errorMessage: truncateText(stage?.errorMessage, 12_000),
    })) : [],
    datasets: Array.isArray(payload?.datasets) ? payload.datasets.map((dataset: any) => ({
      ...dataset,
      preview: truncateText(dataset?.preview, 10_000),
    })) : [],
    experiments: Array.isArray(payload?.experiments) ? payload.experiments.map((exp: any) => ({
      ...exp,
      pythonCode: truncateText(exp?.pythonCode, codeLimit),
      stdout: truncateText(exp?.stdout, isActive ? 30_000 : 120_000),
      stderr: truncateText(exp?.stderr, 20_000),
      metrics: truncateRecordValues(exp?.metrics, metricsEntryLimit, 280),
      generatedCharts: Array.isArray(exp?.generatedCharts) ? exp.generatedCharts.slice(0, 24).map((chart: any) => ({
        ...chart,
        description: truncateText(chart?.description, 500),
      })) : [],
      generatedTables: Array.isArray(exp?.generatedTables) ? exp.generatedTables.slice(0, 16).map((table: any) => ({
        ...table,
        description: truncateText(table?.description, 500),
        data: truncateText(table?.data, isActive ? 10_000 : 30_000),
      })) : [],
    })) : [],
  };
}

function createEmitter(runId: string): EventEmitter {
  return (event: PipelineEvent) => {
    if (!runEventBuffers.has(runId)) runEventBuffers.set(runId, []);
    const buf = runEventBuffers.get(runId)!;
    buf.push(event);
    if (buf.length > 500) buf.splice(0, buf.length - 500);

    const listeners = runEventListeners.get(runId);
    if (listeners) {
      listeners.forEach(fn => {
        try { fn(event); } catch {}
      });
    }
  };
}

export function subscribeToRun(runId: string, listener: (event: PipelineEvent) => void): () => void {
  if (!runEventListeners.has(runId)) runEventListeners.set(runId, new Set());
  runEventListeners.get(runId)!.add(listener);
  return () => { runEventListeners.get(runId)?.delete(listener); };
}

export function getRunEvents(runId: string, since = 0): PipelineEvent[] {
  const buf = runEventBuffers.get(runId) || [];
  return buf.filter(e => e.timestamp > since);
}

// ─── Routers ───
const pipelineRouter = router({
  start: protectedProcedure
    .input(z.object({
      topic: z.string().min(3, "Topic must be at least 3 characters"),
      autoApprove: z.boolean().default(true),
      datasetFileIds: z.array(z.number()).default([]),
      config: z.object({
        targetConference: z.string().default("NeurIPS"),
        experimentMode: z.enum(["simulated", "sandbox"]).default("simulated"),
        maxRetries: z.number().min(0).max(5).default(2),
        timeoutMinutes: z.number().min(10).max(300).default(120),
        qualityThreshold: z.number().min(0).max(1).default(0.7),
        dataSources: z.object({
          arxiv: z.boolean().default(true),
          semanticScholar: z.boolean().default(true),
          springer: z.boolean().default(true),
          pubmed: z.boolean().default(true),
          crossref: z.boolean().default(true),
        }).default({ arxiv: true, semanticScholar: true, springer: true, pubmed: true, crossref: true }),
        analysisInputs: z.object({
          outcome: z.string().min(1).optional(),
          treatment: z.string().min(1).optional(),
          entity: z.string().min(1).optional(),
          time: z.string().min(1).optional(),
          controls: z.array(z.string().min(1)).optional(),
          subgroup: z.string().min(1).optional(),
          missingDataMode: z.enum(["complete_case", "mean_imputation"]).optional(),
          missingDataStrategy: z.string().min(1).optional(),
          variableNotes: z.string().min(1).optional(),
        }).optional(),
      }).default({ targetConference: "NeurIPS", experimentMode: "simulated" as const, maxRetries: 2, timeoutMinutes: 120, qualityThreshold: 0.7, dataSources: { arxiv: true, semanticScholar: true, springer: true, pubmed: true, crossref: true } }),
    }))
    .mutation(async ({ input, ctx }) => {
      const runId = `rc-${Date.now()}-${nanoid(8)}`;
      const config: RunConfig = {
        ...DEFAULT_RUN_CONFIG,
        autoApprove: input.autoApprove,
        ...input.config,
        datasetFileIds: input.datasetFileIds,
      };

      await db.createPipelineRun({
        runId,
        userId: ctx.user?.id || null,
        topic: input.topic,
        status: "pending",
        autoApprove: input.autoApprove ? 1 : 0,
        config: config as any,
      });

      // Assign dataset files to this run
      if (input.datasetFileIds.length > 0) {
        await db.assignDatasetFilesToRun(input.datasetFileIds, runId);
      }

      const emit = createEmitter(runId);
      if (isWorkerExecutionMode()) {
        emit({
          type: "log",
          runId,
          message: "Pipeline queued for worker execution",
          timestamp: Date.now(),
        });
        return { runId, status: "pending", executionMode: "worker" as const };
      }

      // Start pipeline in background
      executePipeline(runId, input.topic, config, emit).catch(err => {
        console.error(`[Pipeline] Run ${runId} crashed:`, err);
        db.updatePipelineRun(runId, { status: "failed", errorMessage: err?.message || String(err) });
        emit({ type: "run_fail", runId, message: err?.message || "Pipeline crashed", timestamp: Date.now() });
      });

      return { runId, status: "pending" };
    }),

  stop: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ input }) => {
      await db.updatePipelineRun(input.runId, { status: "stopped" });
      return { success: true };
    }),

  // ─── Manual Approval Endpoints ───
  approve: protectedProcedure
    .input(z.object({
      runId: z.string(),
      editedOutput: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      if (isWorkerExecutionMode()) {
        const run = await db.getPipelineRun(input.runId);
        if (!run || run.status !== "awaiting_approval") {
          return { success: false, message: "This run is not currently awaiting approval" };
        }
        const ok = await db.approveBlockedApprovalStage(input.runId, input.editedOutput);
        return { success: ok };
      }

      if (!isAwaitingApproval(input.runId)) {
        return { success: false, message: "This run is not currently awaiting approval" };
      }
      const ok = approveStage(input.runId, input.editedOutput);
      return { success: ok };
    }),

  reject: protectedProcedure
    .input(z.object({
      runId: z.string(),
      reason: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      if (isWorkerExecutionMode()) {
        const run = await db.getPipelineRun(input.runId);
        if (!run || run.status !== "awaiting_approval") {
          return { success: false, message: "This run is not currently awaiting approval" };
        }
        const ok = await db.rejectBlockedApprovalStage(input.runId, input.reason);
        return { success: ok };
      }

      if (!isAwaitingApproval(input.runId)) {
        return { success: false, message: "This run is not currently awaiting approval" };
      }
      const ok = rejectStage(input.runId, input.reason);
      return { success: ok };
    }),

  approvalStatus: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      if (isWorkerExecutionMode()) {
        const run = await db.getPipelineRun(input.runId);
        return { awaiting: run?.status === "awaiting_approval" };
      }
      return { awaiting: isAwaitingApproval(input.runId) };
    }),

  get: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      const run = await db.getPipelineRun(input.runId);
      if (!run) return null;
      const [stagesResult, artifactsResult, datasetsResult, experimentsResult] = await Promise.allSettled([
        db.getStageLogsForRun(input.runId),
        db.getArtifactsForRun(input.runId),
        db.getDatasetFilesForRun(input.runId),
        db.getExperimentResultsForRun(input.runId),
      ]);
      if (stagesResult.status === "rejected") console.error(`[pipeline.get] failed to load stages for ${input.runId}:`, stagesResult.reason);
      if (artifactsResult.status === "rejected") console.error(`[pipeline.get] failed to load artifacts for ${input.runId}:`, artifactsResult.reason);
      if (datasetsResult.status === "rejected") console.error(`[pipeline.get] failed to load datasets for ${input.runId}:`, datasetsResult.reason);
      if (experimentsResult.status === "rejected") console.error(`[pipeline.get] failed to load experiments for ${input.runId}:`, experimentsResult.reason);

      return sanitizePipelineDetailPayload({
        ...run,
        stages: stagesResult.status === "fulfilled" ? stagesResult.value : [],
        artifacts: artifactsResult.status === "fulfilled" ? artifactsResult.value : [],
        datasets: datasetsResult.status === "fulfilled" ? datasetsResult.value : [],
        experiments: experimentsResult.status === "fulfilled" ? experimentsResult.value : [],
      });
    }),

  list: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(20) }).default({ limit: 20 }))
    .query(async ({ ctx, input }) => {
      return db.listPipelineRuns(ctx.user?.id || undefined, input.limit);
    }),

  events: protectedProcedure
    .input(z.object({ runId: z.string(), since: z.number().default(0) }))
    .query(({ input }) => {
      return getRunEvents(input.runId, input.since);
    }),

  stages: publicProcedure.query(() => PIPELINE_STAGES),

  templates: publicProcedure.query(() => CONFERENCE_TEMPLATES),
});

const literatureRouter = router({
  search: protectedProcedure
    .input(z.object({
      query: z.string().min(2),
      maxPerSource: z.number().min(1).max(50).default(10),
      sources: z.object({
        arxiv: z.boolean().default(true),
        semanticScholar: z.boolean().default(true),
        springer: z.boolean().default(true),
        pubmed: z.boolean().default(true),
        crossref: z.boolean().default(true),
      }).default({ arxiv: true, semanticScholar: true, springer: true, pubmed: true, crossref: true }),
    }))
    .query(async ({ input }) => {
      return unifiedSearch(input.query, {
        maxPerSource: input.maxPerSource,
        semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY,
        springerApiKey: process.env.SPRINGER_API_KEY,
        sources: input.sources,
      });
    }),

  forRun: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      return db.getPapersForRun(input.runId);
    }),
});

const settingsRouter = router({
  get: protectedProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      return db.getUserSetting(ctx.user?.id || null, input.key);
    }),

  set: protectedProcedure
    .input(z.object({ key: z.string(), value: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await db.setUserSetting(ctx.user?.id || null, input.key, input.value);
      return { success: true };
    }),

  getAll: protectedProcedure.query(async ({ ctx }) => {
    const keys = ["targetConference", "experimentMode", "maxRetries", "timeoutMinutes", "qualityThreshold"];
    const settings: Record<string, string | null> = {};
    for (const key of keys) {
      settings[key] = await db.getUserSetting(ctx.user?.id || null, key);
    }
    return settings;
  }),
});

const artifactRouter = router({
  forRun: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      return db.getArtifactsForRun(input.runId);
    }),
});

const datasetRouter = router({
  /** List uploaded files for current user (unassigned to any run) */
  myFiles: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user?.id) return [];
    return db.getUnassignedDatasetFiles(ctx.user.id);
  }),

  /** List all files uploaded by current user */
  allMyFiles: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user?.id) return [];
    return db.getDatasetFilesByUser(ctx.user.id);
  }),

  /** Get dataset files for a specific run */
  forRun: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      return db.getDatasetFilesForRun(input.runId);
    }),

  /** Get experiment results for a run */
  experimentResults: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ input }) => {
      return db.getExperimentResultsForRun(input.runId);
    }),

  uploadChunk: uploadChunkProcedure,
  assembleChunks: assembleChunksProcedure,
  registerFile: registerFileProcedure,
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  pipeline: pipelineRouter,
  literature: literatureRouter,
  settings: settingsRouter,
  artifacts: artifactRouter,
  datasets: datasetRouter,
});

export type AppRouter = typeof appRouter;
