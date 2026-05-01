import mysql from 'mysql2/promise';
import { executePythonExperiment } from '../server/experiment-runner.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [rows] = await conn.execute(
  "select originalName, fileUrl, fileKey, sizeBytes, fileType, rowCount from dataset_files where fileType = 'dta' and originalName = 'integrated_panel_data.dta' order by createdAt desc limit 1",
);
await conn.end();
const dataset = rows[0];
if (!dataset) throw new Error('integrated_panel_data.dta not found');
const runId = `validation-dta-${Date.now()}`;
const analysisCode = JSON.stringify({
  version: 2,
  planType: 'deterministic_dataset_analysis',
  methods: [
    'descriptive_statistics',
    'group_comparison',
    'time_trend',
    'robust_ols',
    'panel_fixed_effects'
  ],
  topic: 'The gendered mental health cost of home schooling: Evidence from COVID-19 in the UK',
  datasetSummary: [{ name: dataset.originalName, rows: dataset.rowCount, fileType: dataset.fileType }],
  note: 'Validation run after DTA timeout and cleanup fix.'
}, null, 2);
const result = await executePythonExperiment(runId, 11, analysisCode, [dataset], null, { heartbeatMs: 60_000 });
console.log(JSON.stringify({
  runId,
  success: result.success,
  exitCode: result.exitCode,
  executionTimeMs: result.executionTimeMs,
  chartCount: result.charts.length,
  tableCount: result.tables.length,
  metricCount: Object.keys(result.metrics).length,
  charts: result.charts.map((chart) => ({ name: chart.name, url: chart.url, mimeType: chart.mimeType, format: chart.format })),
  tables: result.tables.map((table) => ({ name: table.name, url: table.url, dataBytes: table.data.length })),
  stdoutTail: result.stdout.slice(-2000),
  stderr: result.stderr,
}, null, 2));
process.exit(result.success ? 0 : 1);
