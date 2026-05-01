import { drizzle } from 'drizzle-orm/mysql2';
import { desc, eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { datasetFiles } from '../drizzle/schema.ts';
import { storageDownloadDatasetMultipartToFile, parseDatasetMultipartUploadId, estimateDatasetMultipartChunks, storageDownload } from '../server/storage.ts';
import { parseDtaFileAsync } from '../server/dta-parser.ts';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('DATABASE_URL is not available');
const db = drizzle(dbUrl);
const rows = await db.select().from(datasetFiles).where(eq(datasetFiles.fileType, 'dta')).orderBy(desc(datasetFiles.createdAt)).limit(3);
console.log('DTA dataset rows:', rows.map(r => ({ id: r.id, name: r.originalName, key: r.fileKey, sizeBytes: r.sizeBytes, rowCount: r.rowCount, cols: Array.isArray(r.columnNames) ? r.columnNames.length : null })));
const ds = rows[0];
if (!ds) process.exit(0);
const tmp = path.join(os.tmpdir(), `repro-${Date.now()}-${ds.originalName}`);
const uploadId = parseDatasetMultipartUploadId(ds.fileKey);
console.log('download target:', { tmp, uploadId });
const t0 = Date.now();
if (uploadId) {
  const chunks = estimateDatasetMultipartChunks(ds.sizeBytes ?? 0);
  console.log('downloading multipart chunks', chunks);
  await storageDownloadDatasetMultipartToFile({ uploadId, totalChunks: chunks, destinationPath: tmp, timeoutMsPerPart: 120000 });
} else {
  const resp = await storageDownload(ds.fileKey, { timeoutMs: 180000 });
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(tmp, buf);
}
console.log('downloaded bytes', fs.statSync(tmp).size, 'ms', Date.now() - t0);
let last = 0;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error('diagnostic parse timeout')), 120000);
const parseStart = Date.now();
const result = await parseDtaFileAsync(await fs.promises.readFile(tmp), {
  signal: controller.signal,
  yieldEveryRows: 1000,
  onProgress: ({ rowsParsed, totalRows }) => {
    const now = Date.now();
    if (now - last > 1000 || rowsParsed >= totalRows) {
      last = now;
      console.log('progress', rowsParsed, '/', totalRows, 'rssMB', Math.round(process.memoryUsage().rss / 1024 / 1024));
    }
  },
});
clearTimeout(timeout);
console.log('parsed result', { rows: result.data.length, totalRows: result.totalRows, cols: result.columns.length, firstCols: result.columns.slice(0, 10), ms: Date.now() - parseStart });
fs.unlinkSync(tmp);
