import mysql from 'mysql2/promise';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [runs] = await conn.execute(
  "select runId, topic, status, createdAt from pipeline_runs where topic not like 'Test topic%' order by createdAt desc limit 1",
);
const run = runs[0];
console.log(JSON.stringify({ run }, null, 2));
if (run) {
  const [rows] = await conn.execute(
    "select stageNumber, stageName, status, errorMessage, char_length(output) as outputLength, left(output, 4000) as outputPreview from stage_logs where runId = ? and stageNumber in (9,10,11) order by stageNumber",
    [run.runId],
  );
  console.log(JSON.stringify({ stages: rows }, null, 2));
}
await conn.end();
process.exit(0);
