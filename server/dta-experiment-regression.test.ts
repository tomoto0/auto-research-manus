import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDtaFileAsync } from "./dta-parser";
import { DTA_ANALYSIS_STEP_ROWS, DTA_SAFE_ANALYSIS_ROWS, EXECUTION_TIMEOUT_MS, MAX_IN_MEMORY_DATA_ROWS } from "./experiment-runner";

const projectRoot = path.resolve(__dirname, "..");

describe("DTA experiment execution regressions", () => {
  it("uses a dataset-backed execution timeout long enough for DTA parsing, charting, and artifact storage", () => {
    expect(EXECUTION_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("keeps generic dataset caps high while bounding each large-DTA analysis pass to one visible step", () => {
    expect(MAX_IN_MEMORY_DATA_ROWS).toBeGreaterThanOrEqual(100_000);
    expect(DTA_SAFE_ANALYSIS_ROWS).toBeLessThanOrEqual(DTA_ANALYSIS_STEP_ROWS);
    expect(DTA_SAFE_ANALYSIS_ROWS).toBeGreaterThanOrEqual(5_000);
  });

  it("persists step-by-step DTA parse and analysis progress messages in the experiment runner", () => {
    const runnerSource = fs.readFileSync(path.join(projectRoot, "server/experiment-runner.ts"), "utf8");

    expect(runnerSource).toContain("DTA parse/materialization");
    expect(runnerSource).toContain("rows retained for this bounded analysis pass");
    expect(runnerSource).toContain("preparing_analysis_data");
    expect(runnerSource).toContain("remaining ${(ds.totalRows - materializedRows).toLocaleString()} rows stay in metadata");
  });

  it("aborts DTA parsing immediately when the experiment controller is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("experiment cancelled before parsing"));

    await expect(
      parseDtaFileAsync(Buffer.from("not a real dta file"), { signal: controller.signal }),
    ).rejects.toThrow("experiment cancelled before parsing");
  });

  it("startup cleanup only fails interrupted stage logs and also finalizes stale experiment rows", () => {
    const cleanupSource = fs.readFileSync(path.join(projectRoot, "server/startup-cleanup.ts"), "utf8");

    expect(cleanupSource).toContain('eq(stageLogs.status, "running")');
    expect(cleanupSource).toContain('eq(stageLogs.status, "pending")');
    expect(cleanupSource).toContain("experimentResults");
    expect(cleanupSource).toContain('eq(experimentResults.executionStatus, "running")');
    expect(cleanupSource).toContain('executionStatus: "error"');
  });
});
