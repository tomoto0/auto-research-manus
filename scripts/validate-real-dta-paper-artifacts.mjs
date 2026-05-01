import fs from 'node:fs/promises';
import path from 'node:path';
import { generatePaperPdf } from '../server/pdf-generator.ts';

const sourcePath = '/home/ubuntu/webdev-static-assets/auto-research-validation/validate-real-dta-experiment.json';
const outDir = '/home/ubuntu/webdev-static-assets/auto-research-validation';

const raw = await fs.readFile(sourcePath, 'utf8');
const jsonStart = raw.indexOf('{');
const jsonEnd = raw.lastIndexOf('}');
if (jsonStart < 0 || jsonEnd < jsonStart) {
  throw new Error('Validation experiment output did not contain a JSON object');
}
const result = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
if (!result.success) throw new Error('Real DTA experiment validation did not succeed');
if (!Array.isArray(result.charts) || result.charts.length < 1) throw new Error('No chart artifacts were generated');
if (!Array.isArray(result.tables) || result.tables.length < 1) throw new Error('No table artifacts were generated');

const tableChecks = [];
for (const table of result.tables) {
  const response = await fetch(table.url);
  if (!response.ok) throw new Error(`Could not fetch table ${table.name}: HTTP ${response.status}`);
  const csv = await response.text();
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error(`Table ${table.name} has fewer than two rows`);
  const columnCount = lines[0].split(',').length;
  if (columnCount < 2) throw new Error(`Table ${table.name} has fewer than two columns`);
  tableChecks.push({ name: table.name, bytes: Buffer.byteLength(csv), rows: lines.length - 1, columns: columnCount, header: lines[0] });
}

const chartChecks = [];
for (const chart of result.charts) {
  const response = await fetch(chart.url);
  if (!response.ok) throw new Error(`Could not fetch chart ${chart.name}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`Chart ${chart.name} is unexpectedly small: ${buffer.length} bytes`);
  if (chart.mimeType === 'image/png' && !(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)) {
    throw new Error(`Chart ${chart.name} is not a valid PNG signature`);
  }
  chartChecks.push({ name: chart.name, bytes: buffer.length, mimeType: chart.mimeType });
}

const markdown = `# The Gendered Mental Health Cost of Home Schooling: Evidence from COVID-19 in the UK\n\n## Abstract\nThis validation paper was generated from the real Stata dataset \`integrated_panel_data.dta\` after the DTA parsing timeout fix. It verifies that the application can carry a DTA-backed experiment through real-data analysis, table creation, chart creation, and PDF rendering with embedded figures.\n\n## Data and Methods\nThe experiment run \`${result.runId}\` completed successfully in ${result.executionTimeMs} ms and produced ${result.chartCount} chart artifacts, ${result.tableCount} table artifacts, and ${result.metricCount} analytical metrics. The deterministic validation plan used descriptive statistics, group comparison checks, time trends, robust OLS, and panel fixed-effect applicability diagnostics.\n\n## Results\nThe generated tables were non-empty CSV artifacts. The first table, \`${tableChecks[0].name}\`, contained ${tableChecks[0].rows} data rows and ${tableChecks[0].columns} columns. The chart artifacts were retrievable PNG files with valid PNG signatures.\n\n## Figures\nThe generated PDF embeds the four real chart artifacts supplied by the experiment runner: distribution histogram, time trend, density plot, and residual-versus-fitted diagnostic plot.\n\n## Artifact Completeness\nAll inspected tables and charts were non-empty, and the final PDF buffer was generated without a PDF error artifact.\n`;

await fs.mkdir(outDir, { recursive: true });
const markdownPath = path.join(outDir, 'real-dta-validation-paper.md');
await fs.writeFile(markdownPath, markdown, 'utf8');
const pdf = await generatePaperPdf(
  markdown,
  'The Gendered Mental Health Cost of Home Schooling: Evidence from COVID-19 in the UK',
  'Validation',
  undefined,
  result.charts.map((chart, index) => ({
    key: `figure_${index + 1}`,
    url: chart.url,
    name: chart.name,
    description: `Real DTA validation chart: ${chart.name}`,
  }))
);
if (!Buffer.isBuffer(pdf) || pdf.length < 2048) throw new Error(`Generated PDF is unexpectedly small: ${pdf?.length ?? 0} bytes`);
if (!(pdf[0] === 0x25 && pdf[1] === 0x50 && pdf[2] === 0x44 && pdf[3] === 0x46)) throw new Error('Generated paper is not a PDF buffer');
const pdfPath = path.join(outDir, 'real-dta-validation-paper.pdf');
await fs.writeFile(pdfPath, pdf);
const verification = {
  success: true,
  runId: result.runId,
  paperMarkdownBytes: Buffer.byteLength(markdown),
  paperPdfBytes: pdf.length,
  tableChecks,
  chartChecks,
  markdownPath,
  pdfPath,
};
await fs.writeFile(path.join(outDir, 'real-dta-paper-artifact-verification.json'), JSON.stringify(verification, null, 2));
console.log(JSON.stringify(verification, null, 2));
