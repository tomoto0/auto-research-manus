/**
 * Server startup cleanup: mark stale "running"/"pending" pipeline runs as failed
 * This handles the case where the server restarts while pipelines are in progress
 */
import { getDb } from "./db";
import { pipelineRuns, stageLogs } from "../drizzle/schema";
import { eq, or } from "drizzle-orm";

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

      // Mark any running stage logs as failed too
      await db
        .update(stageLogs)
        .set({
          status: "failed",
          errorMessage: "Stage interrupted by server restart",
          completedAt: new Date(),
        })
        .where(
          eq(stageLogs.runId, run.runId)
        );
    }

    console.log(`[Cleanup] Cleaned up ${staleRuns.length} stale run(s)`);
    return staleRuns.length;
  } catch (error) {
    console.error("[Cleanup] Failed to clean up stale runs:", error);
    return 0;
  }
}
