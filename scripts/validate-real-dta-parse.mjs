import fs from 'fs';
import os from 'os';
import path from 'path';
import mysql from 'mysql2/promise';
import { parseDatasetMultipartUploadId, estimateDatasetMultipartChunks, storageDownload, storageDownloadDatasetMultipartToFile } from '../server/storage.ts';
import { parseDtaFileAsync } from '../server/dta-parser.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [rows] = await conn.execute(
  "select id, runId, originalName, fileKey, sizeBytes, rowCount from dataset_files where fileType = 'dta' and originalName = 'integrated_panel_data.dta' order by createdAt desc limit 1",
);
await conn.end();
const dataset = rows[0];
if (!dataset) throw new Error('integrated_panel_data.dta not found in dataset_files');
console.log(JSON.stringify({ dataset: { id: dataset.id, runId: dataset.runId, originalName: dataset.originalName, sizeBytes: dataset.sizeBytes, rowCount: dataset.rowCount, fileKey: dataset.fileKey } }, null, 2));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dta-validate-'));
const tempPath = path.join(tempDir, dataset.originalName);
const uploadId = parseDatasetMultipartUploadId(dataset.fileKey);
if (uploadId) {
  const chunks = estimateDatasetMultipartChunks(Number(dataset.sizeBytes));
  await storageDownloadDatasetMultipartToFile({ uploadId, totalChunks: chunks, destinationPath: tempPath, timeoutMsPerPart: 180000 });
} else {
  const resp = await storageDownload(dataset.fileKey, { timeoutMs: 180000 });
  const arr = new Uint8Array(await resp.arrayBuffer());
  fs.writeFileSync(tempPath, Buffer.from(arr));
}
const buffer = fs.readFileSync(tempPath);
console.log(JSON.stringify({ downloadedBytes: buffer.length }, null, 2));
const started = Date.now();
let progressEvents = 0;
const parsed = await parseDtaFileAsync(buffer, {
  maxRows: 100000,
  yieldEveryRows: 2000,
  onProgress: (event) => {
    progressEvents += 1;
    if (progressEvents <= 5 || event.processedRows === event.totalRows) {
      console.log(JSON.stringify({ progress: event }));
    }
  },
});
console.log(JSON.stringify({
  parseMs: Date.now() - started,
  rowCount: parsed.totalRows,
  parsedRows: parsed.data.length,
  columnCount: parsed.columns.length,
  sampleColumns: parsed.columns.slice(0, 12),
  progressEvents,
  previewRows: parsed.data.slice(0, 2),
}, null, 2));
fs.rmSync(tempDir, { recursive: true, force: true });
process.exit(0);
