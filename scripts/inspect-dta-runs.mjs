import { drizzle } from 'drizzle-orm/mysql2';
import { desc, eq, or, like } from 'drizzle-orm';
import { datasetFiles, pipelineRuns, stageLogs, experimentResults, artifacts } from '../drizzle/schema.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
const db = drizzle(process.env.DATABASE_URL);
const datasets = await db.select().from(datasetFiles).where(eq(datasetFiles.fileType, 'dta')).orderBy(desc(datasetFiles.createdAt)).limit(10);
console.log('datasets', datasets.map(d => ({ id: d.id, runId: d.runId, name: d.originalName, key: d.fileKey, rowCount: d.rowCount, cols: Array.isArray(d.columnNames) ? d.columnNames.length : null, createdAt: d.createdAt })));
const runs = await db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.createdAt)).limit(10);
console.log('runs', runs.map(r => ({ runId: r.runId, topic: r.topic, status: r.status, currentStage: r.currentStage, stagesDone: r.stagesDone, stagesFailed: r.stagesFailed, errorMessage: r.errorMessage, createdAt: r.createdAt, updatedAt: r.updatedAt })));
for (const r of runs.slice(0, 5)) {
  const logs = await db.select().from(stageLogs).where(eq(stageLogs.runId, r.runId)).orderBy(desc(stageLogs.createdAt)).limit(15);
  console.log('\nlogs for', r.runId, logs.map(l => ({ stageNumber: l.stageNumber, status: l.status, message: l.message, createdAt: l.createdAt })));
  const exps = await db.select().from(experimentResults).where(eq(experimentResults.runId, r.runId)).orderBy(desc(experimentResults.createdAt)).limit(3);
  console.log('experiments', exps.map(e => ({ status: e.executionStatus, exitCode: e.exitCode, time: e.executionTimeMs, stderr: e.stderr?.slice(0, 300), charts: Array.isArray(e.generatedCharts) ? e.generatedCharts.length : null, tables: Array.isArray(e.generatedTables) ? e.generatedTables.length : null, metricsKeys: e.metrics ? Object.keys(e.metrics).slice(0, 10) : [] })));
  const arts = await db.select().from(artifacts).where(eq(artifacts.runId, r.runId)).orderBy(desc(artifacts.createdAt)).limit(20);
  console.log('artifacts', arts.map(a => ({ type: a.artifactType, name: a.fileName, size: a.sizeBytes, key: a.fileKey })));
}
