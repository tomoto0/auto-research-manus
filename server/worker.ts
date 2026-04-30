import "dotenv/config";
import { DEFAULT_RUN_CONFIG, type PipelineEvent, type RunConfig } from "../shared/pipeline";
import { executePipeline, type EventEmitter } from "./pipeline-engine";
import * as db from "./db";
import { cleanupStaleRuns } from "./startup-cleanup";
import { getPipelineExecutionMode } from "./_core/pipeline-execution";

const POLL_INTERVAL_MS = Math.max(500, Number(process.env.PIPELINE_WORKER_POLL_MS || 2000));
const IDLE_LOG_INTERVAL_MS = Math.max(5000, Number(process.env.PIPELINE_WORKER_IDLE_LOG_MS || 30000));

let stopRequested = false;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createWorkerEmitter(runId: string): EventEmitter {
  return (event: PipelineEvent) => {
    if (event.type === "run_complete") {
      console.log(`[Worker] Run ${runId} completed`);
      return;
    }
    if (event.type === "run_fail") {
      console.warn(`[Worker] Run ${runId} failed: ${event.message || "unknown error"}`);
      return;
    }
    if (event.type === "stage_start") {
      console.log(`[Worker] Run ${runId} stage ${event.stageNumber} started`);
      return;
    }
    if (event.type === "stage_fail") {
      console.warn(`[Worker] Run ${runId} stage ${event.stageNumber} failed: ${event.message || "unknown error"}`);
      return;
    }
    if (event.type === "stage_awaiting_approval") {
      console.log(`[Worker] Run ${runId} stage ${event.stageNumber} awaiting approval`);
    }
  };
}

function normaliseRunConfig(config: unknown, autoApproveFlag: number): RunConfig {
  const parsed = config && typeof config === "object" ? (config as Partial<RunConfig>) : {};
  return {
    ...DEFAULT_RUN_CONFIG,
    ...parsed,
    autoApprove: autoApproveFlag === 1,
    dataSources: {
      ...DEFAULT_RUN_CONFIG.dataSources,
      ...(parsed.dataSources || {}),
    },
  };
}

async function processNextRun(): Promise<boolean> {
  const claimed = await db.claimNextPendingPipelineRun();
  if (!claimed) return false;

  const config = normaliseRunConfig(claimed.config, claimed.autoApprove);
  const startStage = claimed.currentStage > 0 ? claimed.currentStage : 1;

  console.log(`[Worker] Claimed run ${claimed.runId} (startStage=${startStage})`);

  try {
    await executePipeline(
      claimed.runId,
      claimed.topic,
      config,
      createWorkerEmitter(claimed.runId),
      startStage,
    );
  } catch (error: any) {
    const message = error?.message || String(error);
    console.error(`[Worker] Run ${claimed.runId} crashed unexpectedly:`, error);
    await db.updatePipelineRun(claimed.runId, {
      status: "failed",
      errorMessage: message,
    });
  }

  return true;
}

async function startWorker(): Promise<void> {
  const executionMode = getPipelineExecutionMode();
  if (executionMode !== "worker") {
    console.warn("[Worker] PIPELINE_EXECUTION_MODE is not 'worker'. This process will still run, but API may execute pipelines inline.");
  }

  console.log(`[Worker] Starting pipeline worker (poll=${POLL_INTERVAL_MS}ms)`);

  // Pending runs are part of the queue in worker mode, so only recover stale running runs.
  try {
    const cleaned = await cleanupStaleRuns({
      includePending: false,
      reason: "Pipeline worker restarted while run was active",
    });
    if (cleaned > 0) console.log(`[Worker] Cleaned up ${cleaned} stale active run(s)`);
  } catch (error) {
    console.warn("[Worker] Startup cleanup failed:", error);
  }

  let lastIdleLogAt = 0;
  while (!stopRequested) {
    const processed = await processNextRun();
    if (processed) {
      continue;
    }

    const now = Date.now();
    if (now - lastIdleLogAt >= IDLE_LOG_INTERVAL_MS) {
      console.log("[Worker] No pending runs in queue");
      lastIdleLogAt = now;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.log("[Worker] Stop requested, exiting");
}

process.on("SIGINT", () => {
  stopRequested = true;
});

process.on("SIGTERM", () => {
  stopRequested = true;
});

startWorker().catch(error => {
  console.error("[Worker] Fatal startup error:", error);
  process.exitCode = 1;
});
