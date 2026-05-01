/**
 * Server startup cleanup: mark stale "running"/"pending" pipeline runs as failed
 * This handles the case where the server restarts while pipelines are in progress
 */
import { getDb } from "./db";
import { pipelineRuns, stageLogs, experimentResults } from "../drizzle/schema";
import { and, eq, or } from "drizzle-orm";

interface CleanupStaleRunsOptions {
  includePending?: boolean;
  reason?: string;
}

export async function cleanupStaleRuns(options?: CleanupStaleRunsOptions): Promise<number> {
  const db = await getDb();
  if (!db) {
    console.warn("[Cleanup] Database not available, skipping stale run cleanup");
    return 0;
  }

  try {
    const includePending = options?.includePending ?? true;
    const staleReason = options?.reason || "Pipeline process lost due to server restart";

    // Find stale runs that are still marked running (and optionally pending).
    const staleCondition = includePending
      ? or(eq(pipelineRuns.status, "running"), eq(pipelineRuns.status, "pending"))
      : eq(pipelineRuns.status, "running");

    const staleRuns = await db
      .select({ runId: pipelineRuns.runId })
      .from(pipelineRuns)
      .where(staleCondition);

    if (staleRuns.length === 0) {
      console.log("[Cleanup] No stale runs found");
      return 0;
    }

    console.log(`[Cleanup] Found ${staleRuns.length} stale run(s), marking as failed...`);

    for (const run of staleRuns) {
      // Mark the run as failed
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          errorMessage: staleReason,
        })
        .where(eq(pipelineRuns.runId, run.runId));

      // Mark only currently running/pending stage logs as failed. Completed
      // stages must remain intact so users can see the pipeline progressed past
      // earlier phases such as dataset parsing before the restart happened.
      await db
        .update(stageLogs)
        .set({
          status: "failed",
          errorMessage: "Stage interrupted by server restart",
          completedAt: new Date(),
        })
        .where(
          and(
            eq(stageLogs.runId, run.runId),
            or(eq(stageLogs.status, "running"), eq(stageLogs.status, "pending")),
          )
        );

      // Keep experiment records consistent with the failed run. Without this,
      // the UI can show an experiment as permanently “running” with logs ending
      // at dataset parsing, which looks like a DTA parser hang even when the
      // process was actually interrupted by a server restart.
      await db
        .update(experimentResults)
        .set({
          executionStatus: "error",
          stderr: staleReason,
          exitCode: -1,
        })
        .where(
          and(
            eq(experimentResults.runId, run.runId),
            eq(experimentResults.executionStatus, "running"),
          )
        );
    }

    console.log(`[Cleanup] Cleaned up ${staleRuns.length} stale run(s)`);
    return staleRuns.length;
  } catch (error) {
    console.error("[Cleanup] Failed to clean up stale runs:", error);
    return 0;
  }
}
