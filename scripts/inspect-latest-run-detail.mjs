import { drizzle } from 'drizzle-orm/mysql2';
import { desc, eq } from 'drizzle-orm';
import { pipelineRuns, stageLogs, datasetFiles, experimentResults } from '../drizzle/schema.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
const db = drizzle(process.env.DATABASE_URL);
const [run] = await db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.createdAt)).limit(1);
console.log('run', run);
if (run) {
  const logs = await db.select().from(stageLogs).where(eq(stageLogs.runId, run.runId)).orderBy(stageLogs.stageNumber);
  for (const l of logs) {
    console.log('\nSTAGE', l.stageNumber, l.stageName, l.status, l.errorMessage || '');
    const output = typeof l.output === 'string' ? l.output : JSON.stringify(l.output);
    console.log((output || '').slice(0, 2000));
  }
  const datasets = await db.select().from(datasetFiles).where(eq(datasetFiles.runId, run.runId));
  console.log('\ndatasets full', datasets);
  const exps = await db.select().from(experimentResults).where(eq(experimentResults.runId, run.runId));
  console.log('\nexperiments full', exps);
}
