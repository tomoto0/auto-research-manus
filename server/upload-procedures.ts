import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "./_core/trpc";
import {
  storagePut,
  storageGet,
  storageDownload,
  storageDownloadDatasetMultipartToFile,
  buildDatasetMultipartPartKey,
  buildDatasetMultipartPrefix,
  parseDatasetMultipartUploadId,
  estimateDatasetMultipartChunks,
} from "./storage";
import { insertDatasetFile } from "./db";

// ─── Helper: parse file preview from downloaded buffer ───

type FileType = "csv" | "excel" | "dta" | "json" | "tsv" | "other";

const MAX_PREVIEW_BYTES = 60 * 1024; // MySQL TEXT practical safety headroom
const MAX_PREVIEW_RETRY_BYTES = 16 * 1024;
const MAX_PREVIEW_ROWS = 5;
const MAX_PREVIEW_COLUMNS = 180;
const MAX_PREVIEW_CELL_CHARS = 160;
const MAX_COLUMN_NAMES_STORED = 1500;
const MAX_COLUMN_NAME_CHARS = 180;

function detectFileType(fileName: string): FileType {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (ext === "csv") return "csv";
  if (["xlsx", "xls"].includes(ext)) return "excel";
  if (ext === "dta") return "dta";
  if (ext === "json") return "json";
  if (ext === "tsv") return "tsv";
  return "other";
}

function sanitizeControlChars(input: string): string {
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function truncateUtf8ToBytes(input: string, maxBytes: number): string {
  if (maxBytes <= 0 || !input) return "";
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidate = input.slice(0, mid);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return input.slice(0, low);
}

export function preparePreviewForStorage(preview: string | null, maxBytes = MAX_PREVIEW_BYTES): string | null {
  if (!preview) return null;
  const normalised = sanitizeControlChars(preview).replace(/\r\n/g, "\n").trim();
  if (!normalised) return null;
  if (Buffer.byteLength(normalised, "utf8") <= maxBytes) {
    return normalised;
  }
  const suffix = "\n...[preview truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const headBudget = Math.max(0, maxBytes - suffixBytes);
  return `${truncateUtf8ToBytes(normalised, headBudget)}${suffix}`;
}

export function normaliseColumnNamesForStorage(columnNames: string[] | null): { columnNames: string[] | null; truncated: boolean } {
  if (!columnNames || columnNames.length === 0) return { columnNames: null, truncated: false };
  const cleaned = columnNames
    .map((name) => sanitizeControlChars(String(name ?? "")).trim())
    .filter(Boolean)
    .map((name) => name.length > MAX_COLUMN_NAME_CHARS ? `${name.slice(0, MAX_COLUMN_NAME_CHARS - 3)}...` : name);
  if (cleaned.length > MAX_COLUMN_NAMES_STORED) {
    return { columnNames: cleaned.slice(0, MAX_COLUMN_NAMES_STORED), truncated: true };
  }
  return { columnNames: cleaned, truncated: false };
}

function toPreviewCell(value: unknown): string {
  const asText = sanitizeControlChars(String(value ?? "")).replace(/\r?\n/g, " ").trim();
  if (asText.length <= MAX_PREVIEW_CELL_CHARS) return asText;
  return `${asText.slice(0, MAX_PREVIEW_CELL_CHARS - 3)}...`;
}

function buildTabularPreview(
  allColumns: string[],
  rows: Record<string, unknown>[],
): string | null {
  if (!allColumns || allColumns.length === 0) return null;
  const useColumns = allColumns.slice(0, MAX_PREVIEW_COLUMNS);
  const useRows = rows.slice(0, MAX_PREVIEW_ROWS);
  const lines: string[] = [];
  lines.push(useColumns.map(toPreviewCell).join(","));
  for (const row of useRows) {
    lines.push(useColumns.map((col) => toPreviewCell((row as any)?.[col])).join(","));
  }
  if (allColumns.length > useColumns.length) {
    lines.push(`...[${allColumns.length - useColumns.length} additional columns omitted]`);
  }
  if (rows.length > useRows.length) {
    lines.push(`...[${rows.length - useRows.length} additional preview rows omitted]`);
  }
  return preparePreviewForStorage(lines.join("\n"));
}

async function parsePreview(
  fileKey: string,
  fileType: FileType,
  fileName: string,
  sizeBytes: number,
  options?: { multipartUploadId?: string; multipartTotalChunks?: number },
): Promise<{ columnNames: string[] | null; rowCount: number | null; preview: string | null }> {
  let columnNames: string[] | null = null;
  let rowCount: number | null = null;
  let preview: string | null = null;
  const multipartUploadId = options?.multipartUploadId;
  const multipartTotalChunks = options?.multipartTotalChunks;
  const isMultipart = Boolean(multipartUploadId && multipartTotalChunks && multipartTotalChunks > 1);

  const decodePreviewText = async (previewBuf: Buffer): Promise<string> => {
    try {
      const iconv = await import("iconv-lite");
      const chardet = await import("chardet");
      const detected = chardet.default.detect(previewBuf);
      const encodingMap: Record<string, string> = {
        "utf8": "utf-8", "ascii": "utf-8", "shiftjis": "Shift_JIS",
        "eucjp": "EUC-JP", "iso2022jp": "ISO-2022-JP", "windows1252": "windows-1252",
      };
      const normalised = (detected || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const iconvEncoding = encodingMap[normalised] || detected || "utf-8";
      let text = iconv.default.decode(previewBuf, iconvEncoding);
      if (text.includes("\uFFFD") && iconvEncoding === "utf-8") {
        text = iconv.default.decode(previewBuf, "Shift_JIS");
      }
      return text;
    } catch {
      return previewBuf.toString("utf-8");
    }
  };

  const readFileHead = (filePath: string, maxBytes = 65536): Buffer => {
    const fd = fs.openSync(filePath, "r");
    try {
      const previewBuf = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, previewBuf, 0, maxBytes, 0);
      return previewBuf.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  };

  const DTA_PREVIEW_HEAD_BYTES = 5 * 1024 * 1024; // 5MB — enough for DTA header + 10 preview rows

  if (isMultipart) {
    const tmpPath = path.join(os.tmpdir(), `preview-multipart-${Date.now()}-${fileName}`);
    try {
      if (fileType === "dta") {
        // For DTA preview, only download the first chunk (~8MB) instead of the entire file
        const firstPartKey = buildDatasetMultipartPartKey(multipartUploadId!, 0);
        const resp = await storageDownload(firstPartKey, { timeoutMs: 120000 });
        if (resp.body) {
          const { Readable } = await import("stream");
          const { pipeline: streamPipeline } = await import("stream/promises");
          const tmpStream = fs.createWriteStream(tmpPath);
          const readable = Readable.fromWeb(resp.body as any);
          await streamPipeline(readable, tmpStream);
        } else {
          const buf = Buffer.from(await resp.arrayBuffer());
          fs.writeFileSync(tmpPath, buf);
        }
      } else {
        await storageDownloadDatasetMultipartToFile({
          uploadId: multipartUploadId!,
          totalChunks: multipartTotalChunks!,
          destinationPath: tmpPath,
          timeoutMsPerPart: 120000,
        });
      }
    } catch (dlErr: any) {
      console.warn("[Upload] Failed to download multipart file for preview:", dlErr.message);
      try { fs.unlinkSync(tmpPath); } catch {}
      return { columnNames, rowCount, preview };
    }

    try {
      if (fileType === "csv" || fileType === "tsv") {
        const previewBuf = readFileHead(tmpPath, 65536);
        let text = await decodePreviewText(previewBuf);
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const sep = fileType === "tsv" ? "\t" : ",";
        const lines = text.split("\n").filter(l => l.trim());
        if (lines.length > 0) {
          columnNames = lines[0].split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
          const avgLineLen = previewBuf.length / Math.max(lines.length, 1);
          rowCount = Math.max(0, Math.round(sizeBytes / avgLineLen) - 1);
          preview = lines.slice(0, 6).join("\n");
        }
      } else if (fileType === "json") {
        const head = readFileHead(tmpPath, 65536).toString("utf-8");
        try {
          const parsed = JSON.parse(head);
          if (Array.isArray(parsed) && parsed.length > 0) {
            columnNames = Object.keys(parsed[0]);
            rowCount = parsed.length;
            preview = JSON.stringify(parsed.slice(0, 3), null, 2);
          }
        } catch {
          const match = head.match(/\[\s*\{/);
          if (match) {
            const objMatches = head.match(/\{[^{}]+\}/g);
            if (objMatches && objMatches.length > 0) {
              try {
                const firstObj = JSON.parse(objMatches[0]);
                columnNames = Object.keys(firstObj);
                preview = objMatches.slice(0, 3).join(",\n");
              } catch {}
            }
          }
        }
      } else if (fileType === "dta" || fileType === "excel") {
        // For DTA, only read first 5MB (header + 10 rows); for Excel, read full file
        let fileBuffer: Buffer | null = fileType === "dta"
          ? readFileHead(tmpPath, DTA_PREVIEW_HEAD_BYTES)
          : fs.readFileSync(tmpPath);
        if (fileType === "excel") {
          try {
            const XLSX = await import("xlsx");
            const workbook = XLSX.read(fileBuffer, { type: "buffer" });
            const sheetName = workbook.SheetNames[0];
            if (sheetName) {
              const sheet = workbook.Sheets[sheetName];
              const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
              if (jsonData.length > 0) {
                columnNames = jsonData[0].map((c: any) => String(c ?? "").trim());
                rowCount = jsonData.length - 1;
                preview = jsonData.slice(0, 6).map(r => r.join(",")).join("\n");
              }
            }
          } catch (xlsxErr: any) {
            console.warn("[Upload] Excel parse for preview failed:", xlsxErr.message);
          }
        } else {
          try {
            const { parseDtaFile } = await import("./dta-parser");
            const dtaResult = parseDtaFile(fileBuffer!, { previewRows: 10 });
            if (dtaResult && dtaResult.columns) {
              columnNames = dtaResult.columns;
              rowCount = dtaResult.totalRows || dtaResult.data?.length || null;
              if (dtaResult.data && dtaResult.data.length > 0) {
                preview = buildTabularPreview(columnNames, dtaResult.data as Record<string, unknown>[]);
              }
            }
          } catch (dtaErr: any) {
            console.warn("[Upload] DTA parse for preview failed:", dtaErr.message);
          }
        }
        // Help GC reclaim the buffer
        fileBuffer = null;
        try { global.gc?.(); } catch {}
      }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    return { columnNames, rowCount, preview };
  }

  if (fileType === "csv" || fileType === "tsv") {
    const resp = await storageDownload(fileKey, {
      timeoutMs: 30000,
      rangeHeader: "bytes=0-65535",
    });
    const previewBuf = Buffer.from(await resp.arrayBuffer());
    let text = await decodePreviewText(previewBuf);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const sep = fileType === "tsv" ? "\t" : ",";
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length > 0) {
      columnNames = lines[0].split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
      const avgLineLen = previewBuf.length / Math.max(lines.length, 1);
      rowCount = Math.max(0, Math.round(sizeBytes / avgLineLen) - 1);
      preview = lines.slice(0, 6).join("\n");
    }
  } else if (fileType === "json") {
    const resp = await storageDownload(fileKey, {
      timeoutMs: 30000,
      rangeHeader: "bytes=0-65535",
    });
    const partial = await resp.text();
    try {
      const parsed = JSON.parse(partial);
      if (Array.isArray(parsed) && parsed.length > 0) {
        columnNames = Object.keys(parsed[0]);
        rowCount = parsed.length;
        preview = JSON.stringify(parsed.slice(0, 3), null, 2);
      }
    } catch {
      const match = partial.match(/\[\s*\{/);
      if (match) {
        const objMatches = partial.match(/\{[^{}]+\}/g);
        if (objMatches && objMatches.length > 0) {
          try {
            const firstObj = JSON.parse(objMatches[0]);
            columnNames = Object.keys(firstObj);
            preview = objMatches.slice(0, 3).join(",\n");
          } catch {}
        }
      }
    }
  } else if (fileType === "dta" || fileType === "excel") {
    const tmpPath = path.join(os.tmpdir(), `preview-${Date.now()}-${fileName}`);
    try {
      const resp = await storageDownload(fileKey, { timeoutMs: 180000 });
      if (resp.body) {
        const { Readable } = await import("stream");
        const { pipeline: streamPipeline } = await import("stream/promises");
        const tmpStream = fs.createWriteStream(tmpPath);
        const readable = Readable.fromWeb(resp.body as any);
        await streamPipeline(readable, tmpStream);
      } else {
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(tmpPath, buf);
      }
    } catch (dlErr: any) {
      console.warn("[Upload] Failed to download for preview:", dlErr.message);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    // For DTA, only read first 5MB (header + 10 rows); for Excel, read full file
    let fileBuffer: Buffer | null = fs.existsSync(tmpPath)
      ? (fileType === "dta" ? readFileHead(tmpPath, DTA_PREVIEW_HEAD_BYTES) : fs.readFileSync(tmpPath))
      : null;
    const cleanupTmp = () => { try { fs.unlinkSync(tmpPath); } catch {} };

    if (fileBuffer) {
      if (fileType === "excel") {
        try {
          const XLSX = await import("xlsx");
          const workbook = XLSX.read(fileBuffer, { type: "buffer" });
          const sheetName = workbook.SheetNames[0];
          if (sheetName) {
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
            if (jsonData.length > 0) {
              columnNames = jsonData[0].map((c: any) => String(c ?? "").trim());
              rowCount = jsonData.length - 1;
              preview = jsonData.slice(0, 6).map(r => r.join(",")).join("\n");
            }
          }
        } catch (xlsxErr: any) {
          console.warn("[Upload] Excel parse for preview failed:", xlsxErr.message);
        }
      } else if (fileType === "dta") {
        try {
          const { parseDtaFile } = await import("./dta-parser");
          const dtaResult = parseDtaFile(fileBuffer, { previewRows: 10 });
          if (dtaResult && dtaResult.columns) {
            columnNames = dtaResult.columns;
            rowCount = dtaResult.totalRows || dtaResult.data?.length || null;
            if (dtaResult.data && dtaResult.data.length > 0) {
              preview = buildTabularPreview(columnNames, dtaResult.data as Record<string, unknown>[]);
            }
          }
        } catch (dtaErr: any) {
          console.warn("[Upload] DTA parse for preview failed:", dtaErr.message);
        }
      }
      // Help GC reclaim the buffer
      fileBuffer = null;
      try { global.gc?.(); } catch {}
    }
    cleanupTmp();
  }

  return { columnNames, rowCount, preview };
}

// ─── tRPC Procedures ───

export const uploadChunkProcedure = protectedProcedure
  .input(z.object({
    fileKey: z.string().min(1),
    fileMime: z.string().default("application/octet-stream"),
    chunkBase64: z.string(),
  }))
  .mutation(async ({ input }) => {
    const chunkBuffer = Buffer.from(input.chunkBase64, "base64");
    // Release the ~10.7MB base64 string immediately after decoding
    (input as any).chunkBase64 = null;
    const MAX_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB safety limit
    if (chunkBuffer.length > MAX_CHUNK_SIZE) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Chunk too large (max 10MB per chunk)" });
    }

    try {
      const { url } = await storagePut(input.fileKey, chunkBuffer, input.fileMime);
      return { success: true as const, url, fileKey: input.fileKey, sizeBytes: chunkBuffer.length };
    } catch (err: any) {
      console.error("[Upload] S3 chunk proxy error:", err);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err?.message || "Chunk upload failed" });
    }
  });

export const assembleChunksProcedure = protectedProcedure
  .input(z.object({
    uploadId: z.string().min(1),
    fileName: z.string().min(1),
    fileMime: z.string().default("application/octet-stream"),
    totalChunks: z.number().int().min(1),
    totalSize: z.number().int().min(0),
  }))
  .mutation(async ({ input }) => {
    const { uploadId, fileName, fileMime, totalChunks, totalSize } = input;
    try {
      console.log(`[Upload] Validating multipart upload ${uploadId} for ${fileName} (${(totalSize / 1024 / 1024).toFixed(1)}MB)`);

      for (let i = 0; i < totalChunks; i++) {
        const partKey = buildDatasetMultipartPartKey(uploadId, i);
        try {
          await storageDownload(partKey, { timeoutMs: 120000, rangeHeader: "bytes=0-0" });
        } catch (partErr: any) {
          console.error(`[Upload] Failed to download part ${i}:`, partErr.message);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to download part ${i}: ${partErr.message}` });
        }
        console.log(`[Upload] Verified part ${i + 1}/${totalChunks}`);
      }

      const firstPartKey = buildDatasetMultipartPartKey(uploadId, 0);
      const { url: firstPartUrl } = await storageGet(firstPartKey);
      const multipartPrefix = buildDatasetMultipartPrefix(uploadId);

      return {
        success: true as const,
        multipart: true as const,
        fileUrl: firstPartUrl,
        fileKey: multipartPrefix,
        sizeBytes: totalSize,
        totalChunks,
        fileMime,
      };
    } catch (err: any) {
      if (err instanceof TRPCError) throw err;
      console.error("[Upload] Assemble error:", err);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err?.message || "Assembly failed" });
    }
  });

export const registerFileProcedure = protectedProcedure
  .input(z.object({
    fileName: z.string().min(1),
    fileMime: z.string().default("application/octet-stream"),
    fileKey: z.string().min(1),
    fileUrl: z.string().min(1),
    sizeBytes: z.number().int().min(0).default(0),
    multipartTotalChunks: z.number().int().min(1).optional(),
  }))
  .mutation(async ({ input, ctx }) => {
    const { fileName, fileMime, fileKey, fileUrl, sizeBytes, multipartTotalChunks } = input;
    const fileType = detectFileType(fileName);
    const multipartUploadId = parseDatasetMultipartUploadId(fileKey);
    const inferredChunkCount = estimateDatasetMultipartChunks(sizeBytes);
    const resolvedMultipartChunks = multipartUploadId
      ? (multipartTotalChunks ?? inferredChunkCount)
      : undefined;

    console.log(`[Upload] Registering S3 file: ${fileName} (${fileType}, ${(sizeBytes / 1024 / 1024).toFixed(1)}MB)`);
    if (multipartUploadId) {
      console.log(`[Upload] Multipart dataset detected: uploadId=${multipartUploadId}, chunks=${resolvedMultipartChunks}`);
    }

    let columnNames: string[] | null = null;
    let rowCount: number | null = null;
    let preview: string | null = null;
    const warnings: string[] = [];

    try {
      const parsed = await parsePreview(fileKey, fileType, fileName, sizeBytes, {
        multipartUploadId: multipartUploadId ?? undefined,
        multipartTotalChunks: resolvedMultipartChunks,
      });
      columnNames = parsed.columnNames;
      rowCount = parsed.rowCount;
      preview = parsed.preview;
    } catch (parseErr: any) {
      console.warn("[Upload] Preview parsing failed (non-fatal):", parseErr.message);
    }

    const normalisedColumns = normaliseColumnNamesForStorage(columnNames);
    columnNames = normalisedColumns.columnNames;
    if (normalisedColumns.truncated) {
      warnings.push(`Column metadata exceeded safe limits and was truncated to first ${MAX_COLUMN_NAMES_STORED} columns`);
    }
    const preparedPreview = preparePreviewForStorage(preview, MAX_PREVIEW_BYTES);
    if (preview && preparedPreview !== preview) {
      warnings.push("Preview text exceeded storage limits and was truncated");
    }
    preview = preparedPreview;

    // Validate parsed data
    if ((!columnNames || columnNames.length === 0) && (rowCount === 0 || rowCount === null)) {
      throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: "File appears to be empty or unparseable: no columns or rows detected" });
    }
    if (rowCount === 0) {
      throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: "File contains column headers but no data rows" });
    }
    if (rowCount === 1) {
      warnings.push("Dataset contains only a single row — statistical analysis may be limited");
    }
    if (columnNames && columnNames.length > 0) {
      const uniqueNames = new Set(columnNames);
      if (uniqueNames.size < columnNames.length) {
        warnings.push(`Duplicate column names detected (${columnNames.length - uniqueNames.size} duplicates)`);
      }
      const controlCharCols = columnNames.filter(c => /[\x00-\x1f\x7f]/.test(c));
      if (controlCharCols.length > 0) {
        warnings.push(`${controlCharCols.length} column name(s) contain control characters`);
      }
    }
    if (warnings.length > 0) {
      console.warn(`[Upload] Validation warnings for ${fileName}:`, warnings);
    }

    const baseFileRecord = {
      userId: ctx.user?.id ?? null,
      originalName: fileName,
      fileKey,
      fileUrl,
      mimeType: fileMime,
      sizeBytes,
      fileType,
      rowCount,
    };

    let storedColumnNames = columnNames;
    let storedPreview = preview;
    let record: Awaited<ReturnType<typeof insertDatasetFile>>;
    try {
      record = await insertDatasetFile({
        ...baseFileRecord,
        columnNames: storedColumnNames as any,
        preview: storedPreview,
      });
    } catch (insertErr: any) {
      console.error("[Upload] Initial metadata insert failed:", insertErr?.message || insertErr);
      warnings.push("Metadata payload exceeded DB limits; retrying with reduced preview payload");

      storedPreview = preparePreviewForStorage(storedPreview, MAX_PREVIEW_RETRY_BYTES);
      if (storedColumnNames && storedColumnNames.length > 800) {
        storedColumnNames = storedColumnNames.slice(0, 800);
      }

      try {
        record = await insertDatasetFile({
          ...baseFileRecord,
          columnNames: storedColumnNames as any,
          preview: storedPreview,
        });
      } catch (reducedErr: any) {
        console.error("[Upload] Reduced metadata insert failed:", reducedErr?.message || reducedErr);
        warnings.push("Stored file without preview/column metadata due to database storage constraints");
        try {
          storedColumnNames = null;
          storedPreview = null;
          record = await insertDatasetFile({
            ...baseFileRecord,
            columnNames: null as any,
            preview: null,
          });
        } catch (finalErr: any) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: finalErr?.message || insertErr?.message || "Failed to register file metadata",
          });
        }
      }
    }

    console.log(`[Upload] Registered: ${fileName} (id=${record.id}, ${storedColumnNames?.length || 0} cols, ${rowCount ?? "?"} rows)`);

    return {
      success: true as const,
      ...(warnings.length > 0 ? { warnings } : {}),
      file: {
        id: record.id,
        originalName: fileName,
        fileUrl,
        fileType,
        sizeBytes,
        columnNames: storedColumnNames,
        rowCount,
        preview: storedPreview,
      },
    };
  });
