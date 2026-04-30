export type PipelineExecutionMode = "inline" | "worker";

const DEFAULT_MODE: PipelineExecutionMode = "inline";

export function getPipelineExecutionMode(): PipelineExecutionMode {
  const raw = (process.env.PIPELINE_EXECUTION_MODE || "").toLowerCase().trim();
  if (raw === "worker") return "worker";
  return DEFAULT_MODE;
}

export function isWorkerExecutionMode(): boolean {
  return getPipelineExecutionMode() === "worker";
}
