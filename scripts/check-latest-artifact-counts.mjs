import { drizzle } from 'drizzle-orm/mysql2';
import { and, desc, eq, ne, notLike, sql } from 'drizzle-orm';
import { pipelineRuns, stageLogs, datasetFiles, experimentResults, artifacts } from '../drizzle/schema.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
const db = drizzle(process.env.DATABASE_URL);
const [run] = await db.select({
  runId: pipelineRuns.runId,
  status: pipelineRuns.status,
  topic: pipelineRuns.topic,
  errorMessage: pipelineRuns.errorMessage,
  createdAt: pipelineRuns.createdAt,
}).from(pipelineRuns)
  .where(notLike(pipelineRuns.topic, 'Test topic%'))
  .orderBy(desc(pipelineRuns.createdAt))
  .limit(1);
console.log(JSON.stringify({ latestNonTestRun: run }, null, 2));
if (run) {
  const stageSummary = await db.select({
    stageNumber: stageLogs.stageNumber,
    stageName: stageLogs.stageName,
    status: stageLogs.status,
    errorMessage: stageLogs.errorMessage,
  }).from(stageLogs).where(eq(stageLogs.runId, run.runId)).orderBy(stageLogs.stageNumber);
  console.log(JSON.stringify({ stageSummary }, null, 2));

  const datasetSummary = await db.select({
    originalName: datasetFiles.originalName,
    fileType: datasetFiles.fileType,
    rowCount: datasetFiles.rowCount,
    sizeBytes: datasetFiles.sizeBytes,
  }).from(datasetFiles).where(eq(datasetFiles.runId, run.runId));
  console.log(JSON.stringify({ datasetSummary }, null, 2));

  const experimentSummary = await db.select({
    id: experimentResults.id,
    stageNumber: experimentResults.stageNumber,
    executionStatus: experimentResults.executionStatus,
    exitCode: experimentResults.exitCode,
    executionTimeMs: experimentResults.executionTimeMs,
    chartCount: sql`coalesce(json_length(${experimentResults.generatedCharts}), 0)`,
    tableCount: sql`coalesce(json_length(${experimentResults.generatedTables}), 0)`,
    metricsSize: sql`coalesce(json_length(${experimentResults.metrics}), 0)`,
    stderr: experimentResults.stderr,
  }).from(experimentResults).where(eq(experimentResults.runId, run.runId));
  console.log(JSON.stringify({ experimentSummary }, null, 2));

  const artifactSummary = await db.select({
    artifactType: artifacts.artifactType,
    count: sql`count(*)`,
  }).from(artifacts).where(eq(artifacts.runId, run.runId)).groupBy(artifacts.artifactType);
  console.log(JSON.stringify({ artifactSummary }, null, 2));
}
