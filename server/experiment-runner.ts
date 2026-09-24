/**
 * Server-side data analysis and chart generation engine.
 * Uses chartjs-node-canvas for chart rendering (no Chromium/Puppeteer dependency).
 * LLM generates Chart.js configuration and analysis logic,
 * which is executed in a Node.js environment.
 *
 * Key features:
 * - Auto-detect file encoding (UTF-8, Shift-JIS, EUC-JP, CP932, Latin-1)
 * - Detect placeholder/dummy LLM output and fall back to real data analysis
 * - Generate meaningful statistics, charts, and tables from actual data
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { nanoid } from "nanoid";
import {
  storagePut,
  parseDatasetMultipartUploadId,
  estimateDatasetMultipartChunks,
  storageDownloadDatasetMultipartToFile,
} from "./storage";
import { insertExperimentResult, updateExperimentResult, updateStageLogWhileRunning } from "./db";
import { parse as csvParseStream } from "csv-parse";
import * as XLSX from "xlsx";
import { parseDtaFileAsync } from "./dta-parser";
import * as iconv from "iconv-lite";
import chardet from "chardet";
import { invokeLLM } from "./_core/llm";
import type { AnalysisInputs } from "../shared/pipeline";
import { renderChartSvg } from "./chart-renderer";
import {
  OrderedReservoir,
  collectColumns,
  dedupeHeaders,
  detectDelimiter,
  normaliseRecords,
  parseJsonRecords,
  sheetRowsToRecords,
  type Delimiter,
} from "./tabular-utils";

export const EXECUTION_TIMEOUT_MS = 10 * 60_000; // 10 minutes max for dataset-backed experiments
const MAX_OUTPUT_LENGTH = 50_000;
export const MAX_IN_MEMORY_DATA_ROWS = 100_000;
export const DTA_ANALYSIS_STEP_ROWS = 10_000;
export const DTA_SAFE_ANALYSIS_ROWS = 10_000;
const DTA_STEPWISE_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const CSV_ENCODING_SAMPLE_BYTES = 128 * 1024;

interface DatasetParseOptions {
  signal?: AbortSignal;
  onDtaProgress?: (progress: { rowsParsed: number; totalRows: number; stepRows?: number; stepIndex?: number; stepCount?: number }) => void | Promise<void>;
}

type StreamingNumericSummary = {
  n: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
};

type FullDataProfile = {
  scannedRows: number;
  numeric: Record<string, StreamingNumericSummary>;
  categorical: Record<string, Record<string, number>>;
};

type ParsedDataFile = {
  data: Record<string, any>[];
  columns: string[];
  totalRows: number;
  encoding?: string;
  materializedRows?: number;
  stepRows?: number;
  stepCount?: number;
  chunked?: boolean;
  fullDataProfile?: FullDataProfile;
};

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatMemoryUsageSnapshot(): string {
  const usage = process.memoryUsage();
  return `rss=${formatMiB(usage.rss)}, heapUsed=${formatMiB(usage.heapUsed)}, heapTotal=${formatMiB(usage.heapTotal)}`;
}

function computeStepCount(totalRows: number, stepRows = DTA_ANALYSIS_STEP_ROWS): number {
  if (!Number.isFinite(totalRows) || totalRows <= 0) return 1;
  return Math.max(1, Math.ceil(totalRows / Math.max(1, stepRows)));
}

function createFullDataProfile(): FullDataProfile {
  return { scannedRows: 0, numeric: {}, categorical: {} };
}

function updateFullDataProfile(profile: FullDataProfile, row: Record<string, any>): void {
  profile.scannedRows += 1;
  for (const [column, raw] of Object.entries(row)) {
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) {
      const summary = profile.numeric[column] || { n: 0, sum: 0, sumSq: 0, min: value, max: value };
      summary.n += 1;
      summary.sum += value;
      summary.sumSq += value * value;
      summary.min = Math.min(summary.min, value);
      summary.max = Math.max(summary.max, value);
      profile.numeric[column] = summary;
      continue;
    }
    const text = String(raw).trim();
    if (!text) continue;
    const counts = profile.categorical[column] || {};
    if (Object.keys(counts).length < 200 || counts[text] !== undefined) {
      counts[text] = (counts[text] || 0) + 1;
      profile.categorical[column] = counts;
    }
  }
}

function streamingMean(summary: StreamingNumericSummary): number {
  return summary.n > 0 ? summary.sum / summary.n : 0;
}

function streamingStdDev(summary: StreamingNumericSummary): number {
  if (summary.n <= 1) return 0;
  const variance = (summary.sumSq - (summary.sum * summary.sum) / summary.n) / Math.max(1, summary.n - 1);
  return Math.sqrt(Math.max(0, variance));
}

export interface DatasetInfo {
  originalName: string;
  fileUrl: string;
  fileKey?: string;
  sizeBytes?: number;
  fileType: string;
  columnNames?: string[];
  rowCount?: number;
}

export interface ExperimentOutput {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  charts: {
    name: string;
    url: string;
    description: string;
    fileKey?: string;
    mimeType?: string;
    format?: "png" | "svg";
    /** Publication caption generated alongside the figure. */
    caption?: string;
    /** Where the figure belongs in the paper (descriptive / main / diagnostic). */
    section?: string;
  }[];
  tables: {
    name: string;
    url: string;
    data: string;
    description: string;
    /** Structured copy of the table so it can be typeset without re-parsing CSV. */
    headers?: string[];
    rows?: (string | number)[][];
    notes?: string;
    section?: string;
  }[];
  metrics: Record<string, number | string>;
}

export interface ExperimentProgressUpdate {
  phase: string;
  message: string;
  heartbeat: boolean;
  elapsedMs: number;
  chartCount: number;
  tableCount: number;
  metricCount: number;
  stdout: string;
}

interface ExperimentExecutionOptions {
  heartbeatMs?: number;
  onProgress?: (update: ExperimentProgressUpdate) => void | Promise<void>;
}

interface DeterministicAnalysisPlan {
  version?: number;
  planType?: string;
  methods?: string[];
  blockedMethods?: string[];
  datasets?: Array<{
    name?: string;
    columns?: string[];
    rows?: number;
    fileType?: string;
  }>;
  datasetSummary?: Array<{
    name?: string;
    rows?: number;
    fileType?: string;
  }>;
  note?: string;
  topic?: string;
  analysisInputs?: AnalysisInputs;
}

interface MethodFeasibilityContractInput {
  executableNow?: string[];
  requiresMissingData?: string[];
  futureWorkOnly?: string[];
  blockedReasons?: Record<string, string>;
}

function normaliseMethodId(raw: string): string {
  const norm = (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliases: Record<string, string> = {
    descriptive: "descriptive_statistics",
    descriptive_stats: "descriptive_statistics",
    summary_statistics: "descriptive_statistics",
    correlation_analysis: "correlation",
    regression: "linear_regression",
    ols: "linear_regression",
    robust_regression: "robust_ols",
    robust_ols: "robust_ols",
    heteroskedasticity_robust_ols: "robust_ols",
    anova: "group_comparison",
    t_test: "group_comparison",
    time_series_trend: "time_trend",
    text_analysis: "text_feature_analysis",
    nlp: "text_feature_analysis",
    data_visualization: "data_visualisation",
    visualization: "data_visualisation",
    visualisation: "data_visualisation",
    fixed_effects: "panel_fixed_effects",
    twfe: "panel_fixed_effects",
    panel_fixed_effects: "panel_fixed_effects",
    difference_in_differences: "diff_in_diff",
    diff_in_diff: "diff_in_diff",
    did: "diff_in_diff",
    event_study: "event_study",
    synthetic_control: "synthetic_control",
    synthetic_controls: "synthetic_control",
    iv: "iv_2sls",
    instrumental_variable: "iv_2sls",
    two_stage_least_squares: "iv_2sls",
    iv_2sls: "iv_2sls",
    regression_discontinuity: "regression_discontinuity",
    rdd: "regression_discontinuity",
    propensity_score: "propensity_score",
    propensity_score_matching: "propensity_score",
    quantile_regression: "quantile_regression",
    gnn: "graph_modelling",
    computer_vision: "vision_analysis",
    panel_model: "panel_econometrics",
  };
  return aliases[norm] || norm;
}

function buildExecutableMethodSet(
  methodContract?: MethodFeasibilityContractInput | null
): Set<string> | null {
  if (!methodContract) {
    return null;
  }
  const set = new Set<string>();
  for (const methodId of methodContract.executableNow || []) {
    const normalized = normaliseMethodId(methodId);
    if (normalized) set.add(normalized);
  }
  return set;
}

function buildMethodSetFromList(methods?: string[] | null): Set<string> | null {
  if (!methods || methods.length === 0) return null;
  const set = new Set<string>();
  for (const methodId of methods) {
    const normalized = normaliseMethodId(methodId);
    if (normalized) set.add(normalized);
  }
  const conventionalOnly = ["descriptive_statistics", "correlation", "group_comparison", "time_trend", "robust_ols", "linear_regression"];
  const causalMethods = ["panel_fixed_effects", "diff_in_diff", "event_study", "propensity_score", "iv_2sls", "regression_discontinuity", "synthetic_control"];
  const hasConventional = conventionalOnly.some(method => set.has(method));
  const hasCausal = causalMethods.some(method => set.has(method));
  if (hasConventional && !hasCausal) {
    // Evaluate feasible causal estimators as well. Infeasible estimators naturally return no output,
    // but this avoids stopping at a shallow descriptive/correlation-only report.
    for (const method of ["panel_fixed_effects", "diff_in_diff", "event_study", "propensity_score", "data_visualisation"]) {
      set.add(method);
    }
  }
  return set;
}

function parseDeterministicAnalysisPlan(analysisCode: string): DeterministicAnalysisPlan | null {
  try {
    const parsed = JSON.parse(analysisCode);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as DeterministicAnalysisPlan;
    }
  } catch {}
  return null;
}

function methodAllowed(executableMethods: Set<string> | null, methodId: string): boolean {
  if (!executableMethods) return true;
  return executableMethods.has(normaliseMethodId(methodId));
}

/* ------------------------------------------------------------------ */
/*  Encoding detection and file reading                                */
/* ------------------------------------------------------------------ */

/**
 * Detect the encoding of a file buffer and decode it to a UTF-8 string.
 * Tries chardet first, then falls back to a series of common Japanese encodings.
 */
function decodeFileBuffer(buffer: Buffer): { text: string; encoding: string } {
  // 1. Try chardet auto-detection
  const detected = chardet.detect(buffer);
  if (detected) {
    const normalised = detected.toLowerCase().replace(/[^a-z0-9]/g, "");
    // Map chardet names to iconv-lite names
    const encodingMap: Record<string, string> = {
      "utf8": "utf-8",
      "ascii": "utf-8",
      "shiftjis": "Shift_JIS",
      "eucjp": "EUC-JP",
      "iso2022jp": "ISO-2022-JP",
      "windows1252": "windows-1252",
      "iso88591": "latin1",
      "big5": "Big5",
      "gb2312": "GB2312",
      "gb18030": "GB18030",
      "euckr": "EUC-KR",
    };
    const iconvEncoding = encodingMap[normalised] || detected;
    try {
      const text = iconv.decode(buffer, iconvEncoding);
      // Verify the decoded text doesn't contain replacement characters
      if (!text.includes("\uFFFD") || normalised === "utf8") {
        return { text, encoding: iconvEncoding };
      }
    } catch {
      // Fall through to manual detection
    }
  }

  // 2. Try UTF-8 first (most common)
  const utf8Text = buffer.toString("utf-8");
  // Check for BOM
  const hasBom = buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
  if (hasBom) {
    return { text: utf8Text.slice(1), encoding: "utf-8-bom" };
  }
  // Check if UTF-8 decoded cleanly (no replacement characters in first 1000 chars)
  const sample = utf8Text.slice(0, 1000);
  if (!sample.includes("\uFFFD")) {
    // Additional check: if it looks like valid text (has printable chars)
    const printableRatio = sample.replace(/[\x00-\x1f\x7f]/g, "").length / sample.length;
    if (printableRatio > 0.8) {
      return { text: utf8Text, encoding: "utf-8" };
    }
  }

  // 3. Try Japanese encodings in order of likelihood
  const japaneseEncodings = ["Shift_JIS", "CP932", "EUC-JP", "ISO-2022-JP"];
  for (const enc of japaneseEncodings) {
    try {
      const decoded = iconv.decode(buffer, enc);
      // Check quality: should have recognisable characters and no replacement chars
      const decodedSample = decoded.slice(0, 1000);
      if (!decodedSample.includes("\uFFFD")) {
        // Check for Japanese characters (hiragana, katakana, kanji)
        const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(decodedSample);
        if (hasJapanese) {
          return { text: decoded, encoding: enc };
        }
      }
    } catch {
      continue;
    }
  }

  // 4. Try Latin-1 as last resort (never fails)
  try {
    const latin1Text = iconv.decode(buffer, "latin1");
    return { text: latin1Text, encoding: "latin1" };
  } catch {
    // Absolute fallback
    return { text: utf8Text, encoding: "utf-8" };
  }
}

/* ------------------------------------------------------------------ */
/*  Data file parsing                                                  */
/* ------------------------------------------------------------------ */

async function downloadFile(url: string, destPath: string, fileKey?: string, sizeBytes?: number): Promise<void> {
  const multipartUploadId = fileKey ? parseDatasetMultipartUploadId(fileKey) : null;
  if (multipartUploadId) {
    const totalChunks = estimateDatasetMultipartChunks(sizeBytes ?? 0);
    if (totalChunks > 1) {
      console.log(`[Download] Multipart dataset detected (uploadId=${multipartUploadId}, chunks=${totalChunks})`);
      await storageDownloadDatasetMultipartToFile({
        uploadId: multipartUploadId,
        totalChunks,
        destinationPath: destPath,
        timeoutMsPerPart: 120000,
      });
      return;
    }
  }

  // Try primary URL first
  let resp = await fetch(url);
  
  // If primary URL fails and we have a fileKey, try storageGet for a fresh URL
  if (!resp.ok && fileKey) {
    console.log(`[Download] Primary URL failed (${resp.status}), trying storageGet for key: ${fileKey}`);
    try {
      const { storageGet } = await import("./storage");
      const { url: freshUrl } = await storageGet(fileKey);
      resp = await fetch(freshUrl);
    } catch (storageErr: any) {
      console.warn(`[Download] storageGet fallback failed: ${storageErr.message}`);
    }
  }
  
  if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`);
  
  // Stream to disk instead of buffering entire file in memory
  if (resp.body) {
    const { Writable } = await import("stream");
    const { pipeline } = await import("stream/promises");
    const fileStream = fs.createWriteStream(destPath);
    // @ts-ignore - Node.js ReadableStream to Node stream
    const nodeReadable = await import("stream");
    const readable = nodeReadable.Readable.fromWeb(resp.body as any);
    await pipeline(readable, fileStream);
  } else {
    // Fallback for environments without streaming
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
  }
}

function hasGarbledColumns(columns: string[]): boolean {
  return columns.some(col => col.includes("\uFFFD") || /^[\x00-\x1f]+$/.test(col));
}

function detectDelimitedFileEncoding(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const sample = Buffer.alloc(CSV_ENCODING_SAMPLE_BYTES);
    const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
    const { encoding } = decodeFileBuffer(sample.subarray(0, bytesRead));
    if (!encoding) return "utf-8";
    return encoding === "utf-8-bom" ? "utf-8" : encoding;
  } finally {
    fs.closeSync(fd);
  }
}

async function parseDelimitedFileWithEncoding(
  filePath: string,
  delimiter: Delimiter,
  encoding: string,
): Promise<{ records: Record<string, any>[]; columns: string[]; totalRows: number; fullDataProfile?: FullDataProfile }> {
  return new Promise((resolve, reject) => {
    // Keep a bounded, order-preserving random sample in memory for very large files while
    // streaming summary statistics over every row.
    const reservoir = new OrderedReservoir<Record<string, any>>(MAX_IN_MEMORY_DATA_ROWS);
    const profile = createFullDataProfile();
    let headerColumns: string[] = [];
    const readStream = fs.createReadStream(filePath);
    const decoder = iconv.decodeStream(encoding);
    const parser = csvParseStream({
      columns: (header: string[]) => {
        headerColumns = dedupeHeaders(header);
        return headerColumns;
      },
      skip_empty_lines: true,
      skip_records_with_empty_values: true,
      delimiter,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
      cast: true,
      bom: true,
    });

    const cleanup = () => {
      readStream.off("error", onError);
      decoder.off("error", onError);
      parser.off("error", onError);
      parser.off("data", onData);
      parser.off("end", onEnd);
    };

    const onError = (err: unknown) => {
      cleanup();
      readStream.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onData = (record: unknown) => {
      const row = record as Record<string, any>;
      reservoir.add(row);
      updateFullDataProfile(profile, row);
    };

    const onEnd = () => {
      cleanup();
      readStream.destroy();
      const records = reservoir.values();
      const columns = headerColumns.length > 0 ? headerColumns : collectColumns(records);
      const sampled = reservoir.total > records.length;
      resolve({ records, columns, totalRows: reservoir.total, fullDataProfile: sampled ? profile : undefined });
    };

    readStream.on("error", onError);
    decoder.on("error", onError);
    parser.on("error", onError);
    parser.on("data", onData);
    parser.on("end", onEnd);

    readStream.pipe(decoder).pipe(parser);
  });
}

function detectDelimitedFileDelimiter(filePath: string, encoding: string, fallback: Delimiter): Delimiter {
  const fd = fs.openSync(filePath, "r");
  try {
    const sample = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
    let text: string;
    try {
      text = iconv.decode(sample.subarray(0, bytesRead), encoding);
    } catch {
      text = sample.subarray(0, bytesRead).toString("utf-8");
    }
    // Drop a possibly truncated final line before counting fields.
    const lastBreak = text.lastIndexOf("\n");
    return detectDelimiter(lastBreak > 0 ? text.slice(0, lastBreak) : text, fallback);
  } finally {
    fs.closeSync(fd);
  }
}

/** Keeps at most MAX_IN_MEMORY_DATA_ROWS rows (order-preserving sample) and profiles all rows. */
function boundRecords(records: Record<string, any>[]): { data: Record<string, any>[]; fullDataProfile?: FullDataProfile } {
  if (records.length <= MAX_IN_MEMORY_DATA_ROWS) return { data: records };
  const reservoir = new OrderedReservoir<Record<string, any>>(MAX_IN_MEMORY_DATA_ROWS);
  const profile = createFullDataProfile();
  for (const record of records) {
    reservoir.add(record);
    updateFullDataProfile(profile, record);
  }
  return { data: reservoir.values(), fullDataProfile: profile };
}

async function parseDelimitedFile(
  filePath: string,
  fileType: "csv" | "tsv",
  rowCountHint?: number,
): Promise<ParsedDataFile> {
  const detectedEncoding = detectDelimitedFileEncoding(filePath);
  const delimiter = detectDelimitedFileDelimiter(filePath, detectedEncoding, fileType === "tsv" ? "\t" : ",");
  const encodingsToTry = Array.from(new Set([
    detectedEncoding,
    ...(detectedEncoding.toLowerCase().startsWith("utf") ? ["Shift_JIS", "CP932", "EUC-JP"] : []),
    "utf-8",
    "Shift_JIS",
    "CP932",
    "EUC-JP",
    "latin1",
  ]));

  let firstError: Error | null = null;

  for (const enc of encodingsToTry) {
    try {
      const { records, columns, totalRows: scannedRows, fullDataProfile } = await parseDelimitedFileWithEncoding(filePath, delimiter, enc);
      if (records.length === 0 && columns.length === 0) continue;
      if (hasGarbledColumns(columns) && enc.toLowerCase().startsWith("utf")) continue;
      return {
        data: records,
        columns,
        // The streamed row count is exact; the upload-time hint is only an estimate.
        totalRows: scannedRows || Math.max(rowCountHint ?? 0, records.length),
        encoding: `${enc === detectedEncoding ? enc : `${enc} (retry)`}, delimiter ${delimiter === "\t" ? "tab" : `"${delimiter}"`}`,
        materializedRows: records.length,
        fullDataProfile,
      };
    } catch (err: any) {
      if (!firstError) {
        firstError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  if (firstError) throw firstError;
  throw new Error(`Failed to parse ${fileType.toUpperCase()} file`);
}

/**
 * Parse a data file into a JSON-serializable array of objects.
 * Supports CSV, TSV, Excel (.xlsx/.xls), Stata (.dta), and JSON.
 * Automatically detects file encoding for CSV/TSV files.
 */
function validateParsedData(
  result: Pick<ParsedDataFile, "data" | "columns" | "totalRows">,
  fileType: string,
): void {
  if (result.columns.length === 0) {
    throw new Error(`Parsed ${fileType} file has no columns — file may be empty or malformed`);
  }
  if (result.totalRows === 0) {
    throw new Error(`Parsed ${fileType} file has columns but zero data rows`);
  }
  // Log all-null columns as warnings (don't throw — analysis can still proceed)
  const sampleSize = Math.min(result.data.length, 50);
  for (const col of result.columns) {
    let allNull = true;
    for (let i = 0; i < sampleSize; i++) {
      const v = result.data[i]?.[col];
      if (v !== null && v !== undefined && v !== "" && v !== "NA" && v !== "NaN" && v !== ".") {
        allNull = false;
        break;
      }
    }
    if (allNull) {
      console.warn(`[DataValidation] Column "${col}" appears to be all-null in sample (${sampleSize} rows)`);
    }
  }
}

async function parseDataFile(
  filePath: string,
  fileType: string,
  rowCountHint?: number,
  options?: DatasetParseOptions,
): Promise<ParsedDataFile> {
  const hintedRows = rowCountHint && rowCountHint > 0 ? rowCountHint : undefined;

  if (fileType === "csv" || fileType === "tsv") {
    return parseDelimitedFile(filePath, fileType, hintedRows);
  }

  if (fileType === "dta") {
    const fileStats = await fs.promises.stat(filePath);
    const estimatedRows = hintedRows ?? 0;
    const requiresStepwiseDta = estimatedRows > DTA_ANALYSIS_STEP_ROWS || fileStats.size > DTA_STEPWISE_FILE_SIZE_BYTES;
    const previewRows = requiresStepwiseDta ? DTA_SAFE_ANALYSIS_ROWS : undefined;
    const scanAllRows = requiresStepwiseDta;
    let lastReportedStep = 0;
    await options?.onDtaProgress?.({
      rowsParsed: 0,
      totalRows: estimatedRows,
      stepRows: DTA_ANALYSIS_STEP_ROWS,
      stepIndex: 0,
      stepCount: computeStepCount(Math.max(estimatedRows, DTA_ANALYSIS_STEP_ROWS)),
    });
    const fullDataProfile = createFullDataProfile();
    let rawBuf: Buffer | null = await fs.promises.readFile(filePath);
    const result = await parseDtaFileAsync(rawBuf, {
      previewRows,
      scanAllRows,
      signal: options?.signal,
      yieldEveryRows: Math.min(1000, DTA_ANALYSIS_STEP_ROWS),
      onRow: (row) => updateFullDataProfile(fullDataProfile, row),
      onProgress: async ({ rowsParsed, totalRows }) => {
        const effectiveTotalRows = Math.max(totalRows, estimatedRows, rowsParsed);
        const stepCount = computeStepCount(effectiveTotalRows);
        const stepIndex = Math.min(stepCount, Math.max(1, Math.ceil(rowsParsed / DTA_ANALYSIS_STEP_ROWS)));
        const isStepBoundary = stepIndex > lastReportedStep;
        const isFinal = rowsParsed >= effectiveTotalRows;
        if (!isStepBoundary && !isFinal) return;
        lastReportedStep = Math.max(lastReportedStep, stepIndex);
        await options?.onDtaProgress?.({
          rowsParsed,
          totalRows: effectiveTotalRows,
          stepRows: DTA_ANALYSIS_STEP_ROWS,
          stepIndex,
          stepCount,
        });
      },
    });
    // Release the large buffer immediately so GC can reclaim it before downstream analysis.
    rawBuf = null;
    try { global.gc?.(); } catch {}
    const totalRows = Math.max(
      result.totalRows > 0 ? result.totalRows : result.data.length,
      hintedRows ?? 0
    );
    return {
      data: result.data,
      columns: result.columns,
      totalRows,
      materializedRows: result.data.length,
      stepRows: DTA_ANALYSIS_STEP_ROWS,
      stepCount: computeStepCount(totalRows),
      chunked: requiresStepwiseDta,
      fullDataProfile,
    };
  }

  if (fileType === "excel") {
    // XLSX.readFile is unavailable in the ESM build (no fs binding), so read the bytes ourselves.
    const workbook = XLSX.read(await fs.promises.readFile(filePath), { type: "buffer", cellDates: true });
    // Use the sheet holding the most data (the first sheet is often a cover or notes page).
    let best: { name: string; records: Record<string, any>[]; columns: string[]; cells: number } | null = null;
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false, raw: true }) as unknown[][];
      const { records, columns } = sheetRowsToRecords(rows);
      const cells = records.length * columns.length;
      if (!best || cells > best.cells) best = { name: sheetName, records, columns, cells };
    }
    const records = best?.records || [];
    const bounded = boundRecords(records);
    return {
      data: bounded.data,
      columns: best?.columns || [],
      totalRows: records.length,
      encoding: best ? `sheet "${best.name}" of ${workbook.SheetNames.length}` : undefined,
      materializedRows: bounded.data.length,
      fullDataProfile: bounded.fullDataProfile,
    };
  }

  if (fileType === "json") {
    const raw = fs.readFileSync(filePath, "utf-8");
    const records = parseJsonRecords(raw);
    const columns = collectColumns(records);
    const bounded = boundRecords(records);
    return {
      data: bounded.data,
      columns,
      totalRows: records.length,
      materializedRows: bounded.data.length,
      fullDataProfile: bounded.fullDataProfile,
    };
  }

  throw new Error(`Unsupported file type: ${fileType}`);
}

/** Test hook: parse + normalise a local data file exactly as the experiment runner does. */
export async function __testParseDataFile(filePath: string, fileType: string): Promise<ParsedDataFile> {
  return parseAndValidateDataFile(filePath, fileType);
}

/** Wrapper that parses and validates a data file */
async function parseAndValidateDataFile(
  filePath: string,
  fileType: string,
  rowCountHint?: number,
  options?: DatasetParseOptions,
): Promise<ParsedDataFile> {
  const result = await parseDataFile(filePath, fileType, rowCountHint, options);
  // Unify missing codes and numbers stored as text ("1,234", "12%", full-width digits)
  // so that every downstream estimator sees clean numeric columns.
  const converted = normaliseRecords(result.data, result.columns);
  if (converted.length > 0) {
    console.log(`[DataParse] Converted ${converted.length} text column(s) to numeric: ${converted.slice(0, 10).join(", ")}`);
  }
  validateParsedData(result, fileType);
  return result;
}

/* ------------------------------------------------------------------ */
/*  Placeholder / dummy output detection                               */
/* ------------------------------------------------------------------ */

/**
 * Detect whether the LLM-generated analysis output is a placeholder/dummy.
 * Returns true if the output contains placeholder indicators.
 */
function isPlaceholderOutput(parsed: {
  charts?: any[];
  tables?: any[];
  metrics?: Record<string, any>;
}): boolean {
  const placeholderPatterns = [
    /placeholder/i,
    /unknown\s*(column|variable|category)/i,
    /dummy/i,
    /example\s*(data|chart|table)/i,
    /hypothetical/i,
    /simulated\s*(data|result)/i,
    /n\/a/i,
    /category\s*[a-z]/i,  // "Category A", "Category B"
    /group\s*[xyz]/i,     // "Group X", "Group Y"
    /value\s*\d/i,        // "Value 1", "Value 2"
  ];

  // Check chart names and descriptions
  for (const chart of (parsed.charts || [])) {
    const text = `${chart.name || ""} ${chart.description || ""}`;
    if (placeholderPatterns.some(p => p.test(text))) return true;

    // Check chart data labels
    const labels = chart.config?.data?.labels || [];
    const labelStr = labels.join(" ");
    if (placeholderPatterns.some(p => p.test(labelStr))) return true;
  }

  // Check table names, descriptions, and content
  for (const table of (parsed.tables || [])) {
    const text = `${table.name || ""} ${table.description || ""}`;
    if (placeholderPatterns.some(p => p.test(text))) return true;

    // Check for N/A values in rows
    const rows = table.rows || [];
    const naCount = rows.flat().filter((v: any) => v === "N/A" || v === "n/a" || v === null).length;
    const totalCells = rows.flat().length;
    if (totalCells > 0 && naCount / totalCells > 0.3) return true;
  }

  // Check metrics for null/N/A values
  const metricValues = Object.values(parsed.metrics || {});
  const nullMetrics = metricValues.filter(v => v === null || v === "null" || v === "N/A" || v === "n/a").length;
  if (metricValues.length > 0 && nullMetrics / metricValues.length > 0.3) return true;

  return false;
}

/* ------------------------------------------------------------------ */
/*  Chart rendering via chartjs-node-canvas (no Chromium needed)        */
/* ------------------------------------------------------------------ */

/**
 * Convert SVG buffer to PNG buffer using sharp.
 * Returns the original buffer if sharp is unavailable.
 */
const SAFE_CHART_FONT_FAMILY = "Helvetica, Arial, sans-serif";

function sanitizeSvgForRasterization(svgBuffer: Buffer): Buffer {
  const svgText = svgBuffer.toString("utf-8");
  const sanitized = svgText
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ");
  return Buffer.from(sanitized, "utf-8");
}

function applySafeChartFontConfig(config: any): any {
  config.options = config.options || {};
  config.options.font = {
    ...(config.options.font || {}),
    family: SAFE_CHART_FONT_FAMILY,
  };
  config.options.plugins = config.options.plugins || {};
  if (config.options.plugins.title) {
    config.options.plugins.title.font = {
      ...(config.options.plugins.title.font || {}),
      family: SAFE_CHART_FONT_FAMILY,
    };
  }
  if (config.options.plugins.legend?.labels) {
    config.options.plugins.legend.labels.font = {
      ...(config.options.plugins.legend.labels.font || {}),
      family: SAFE_CHART_FONT_FAMILY,
    };
  }
  if (config.options.scales) {
    for (const axis of Object.values(config.options.scales) as any[]) {
      if (!axis || typeof axis !== "object") continue;
      if (axis.title) {
        axis.title.font = {
          ...(axis.title.font || {}),
          family: SAFE_CHART_FONT_FAMILY,
        };
      }
      axis.ticks = axis.ticks || {};
      axis.ticks.font = {
        ...(axis.ticks.font || {}),
        family: SAFE_CHART_FONT_FAMILY,
      };
    }
  }
  return config;
}

/** Supersampling factor for chart rasterisation (2x keeps figures crisp in the PDF). */
export const CHART_RASTER_SCALE = 2;

async function svgToPng(svgBuffer: Buffer, width: number, height: number): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    const pngBuffer = await sharp(sanitizeSvgForRasterization(svgBuffer), { density: 72 * CHART_RASTER_SCALE })
      .resize(Math.round(width * CHART_RASTER_SCALE), Math.round(height * CHART_RASTER_SCALE), { fit: "fill" })
      .flatten({ background: "#ffffff" })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return pngBuffer;
  } catch (err: any) {
    console.warn(`[Chart] sharp SVG→PNG conversion failed: ${err.message}`);
    return svgBuffer; // Return SVG as-is if sharp fails
  }
}

/**
 * Render a Chart.js configuration to a PNG buffer.
 * Strategy:
 *   1. Try chartjs-node-canvas (requires native canvas module)
 *   2. Fall back to SVG generation + sharp SVG→PNG conversion
 *   3. Last resort: return SVG buffer directly
 */
async function renderChartToPng(
  chartConfigJs: string,
  width = 900,
  height = 560
): Promise<Buffer> {
  const preferCanvasRenderer = process.env.CHART_RENDERER === "canvas";

  // Strategy 1: Generate SVG with the layout-aware renderer and rasterise via sharp
  const svgBuffer = generateSvgFallbackChart(chartConfigJs, width, height);
  const pngBuffer = await svgToPng(svgBuffer, width, height);

  // Check if we got a real PNG
  if (pngBuffer[0] === 0x89 && pngBuffer[1] === 0x50) {
    console.log(`[Chart] SVG→PNG conversion successful: ${pngBuffer.length} bytes`);
    return pngBuffer;
  }

  // Strategy 2: Opt-in canvas renderer when explicitly requested
  if (preferCanvasRenderer) {
    try {
      const { ChartJSNodeCanvas } = await import("chartjs-node-canvas");
      const chartJSNodeCanvas = new ChartJSNodeCanvas({
        width,
        height,
        backgroundColour: "white",
      });

      let config: any;
      try {
        config = JSON.parse(chartConfigJs);
      } catch {
        config = new Function(`return (${chartConfigJs})`)();
      }

      config = transliterateChartConfigSync(config);
      config = applySafeChartFontConfig(config);

      config.options = config.options || {};
      config.options.animation = false;
      config.options.responsive = false;
      config.options.devicePixelRatio = 3;

      const canvasPngBuffer = await chartJSNodeCanvas.renderToBuffer(config);
      console.log(`[Chart] chartjs-node-canvas produced ${canvasPngBuffer.length} bytes PNG`);
      return Buffer.from(canvasPngBuffer);
    } catch (err: any) {
      console.warn(`[Chart] chartjs-node-canvas failed after SVG fallback: ${err.message}`);
    }
  }

  // Strategy 3: Return SVG as-is (will be saved with .svg extension)
  console.warn(`[Chart] PNG strategies failed, returning raw SVG`);
  return svgBuffer;
}

/**
 * Render a Chart.js-style configuration to SVG with the layout-aware renderer.
 * Labels are transliterated to ASCII first so librsvg never draws replacement boxes.
 */
export function generateSvgFallbackChart(
  chartConfigJs: string,
  width: number,
  height: number
): Buffer {
  let config: any;
  try {
    config = JSON.parse(chartConfigJs);
  } catch {
    try {
      config = new Function(`return (${chartConfigJs})`)();
    } catch {
      config = { type: "bar", data: { labels: [], datasets: [] } };
    }
  }

  // Transliterate non-ASCII labels to prevent replacement-box garbling
  config = transliterateChartConfigSync(config);
  const svg = renderChartSvg(config, width, height, {
    labelTransform: (value: string) => ensureAsciiLabelSync(value, "Label"),
  });
  return Buffer.from(svg, "utf-8");
}

/* ------------------------------------------------------------------ */
/*  LLM-based translation for non-ASCII labels                          */
/* ------------------------------------------------------------------ */

/** Cache for LLM-translated labels to avoid redundant API calls */
const translationCache = new Map<string, string>();

function ensureAsciiLabelSync(str: string, fallbackPrefix = "Variable"): string {
  if (!str) return str;
  const transliterated = transliterateLabelSync(str);
  const ascii = transliterated.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  if (ascii) return ascii;
  const originalAscii = String(str).replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  if (originalAscii) return originalAscii;
  return `${fallbackPrefix} ${String(str).length}`;
}

function collectNonAsciiStringsDeep(value: unknown, acc: Set<string>): void {
  if (typeof value === "string") {
    if (/[^\x00-\x7F]/.test(value)) acc.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNonAsciiStringsDeep(item, acc);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectNonAsciiStringsDeep(nested, acc);
    }
  }
}

function mapStringsDeep(value: unknown, transform: (input: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map(item => mapStringsDeep(item, transform));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = mapStringsDeep(nested, transform);
    }
    return out;
  }
  return value;
}

function buildAsciiColumnRenameMap(
  columns: string[],
  translations?: Map<string, string>,
): Map<string, string> {
  const colMap = new Map<string, string>();
  const used = new Set<string>();
  for (const col of columns) {
    const preferred = translations?.get(col) || col;
    const baseName = ensureAsciiLabelSync(preferred || col).slice(0, 80) || `Variable ${col.length}`;
    let finalName = baseName;
    let suffix = 2;
    while (used.has(finalName)) {
      finalName = `${baseName}_${suffix}`;
      suffix += 1;
    }
    used.add(finalName);
    colMap.set(col, finalName);
  }
  return colMap;
}

/** Rewrites variable-role column references after columns were renamed. */
export function remapAnalysisInputs(inputs: AnalysisInputs | undefined, renameLookup: Map<string, string>): AnalysisInputs | undefined {
  if (!inputs || renameLookup.size === 0) return inputs;
  const map = (value?: string) => {
    if (!value) return value;
    const trimmed = value.trim();
    return renameLookup.get(trimmed) ?? renameLookup.get(value) ?? value;
  };
  return {
    ...inputs,
    outcome: map(inputs.outcome),
    treatment: map(inputs.treatment),
    entity: map(inputs.entity),
    time: map(inputs.time),
    subgroup: map(inputs.subgroup),
    controls: inputs.controls?.map(control => map(control) || control),
  };
}

function applyColumnRenameMap(
  dataset: { columns: string[]; data: Record<string, any>[] },
  colMap: Map<string, string>,
): void {
  dataset.columns = dataset.columns.map(col => colMap.get(col) || col);
  for (const row of dataset.data) {
    for (const [oldCol, newCol] of Array.from(colMap.entries())) {
      if (oldCol !== newCol && oldCol in row) {
        row[newCol] = row[oldCol];
        delete row[oldCol];
      }
    }
  }
}

/**
 * Translate a batch of non-ASCII strings to English using LLM.
 * Results are cached to avoid redundant API calls.
 * Falls back to dictionary-based transliteration if LLM fails.
 */
async function translateLabelsToEnglish(labels: string[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const toTranslate: string[] = [];

  for (const label of labels) {
    if (!label || !/[^\x00-\x7F]/.test(label)) {
      results.set(label, label); // Already ASCII
    } else if (translationCache.has(label)) {
      results.set(label, translationCache.get(label)!);
    } else {
      toTranslate.push(label);
    }
  }

  if (toTranslate.length === 0) return results;

  try {
    const batchStr = toTranslate.map((l, i) => `${i + 1}. ${l}`).join("\n");
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a translator. Translate the following labels/terms to concise English. These are data column names, chart labels, or category names from a Japanese dataset. Output ONLY a JSON object mapping each original string to its English translation. Keep translations short and suitable for chart labels (max 40 characters). Example: {"男性": "Male", "年齢": "Age", "雇用形態別の経済的不安": "Economic Insecurity by Employment Type"}`
        },
        {
          role: "user",
          content: `Translate these labels to English:\n${batchStr}\n\nOutput ONLY a valid JSON object. No markdown code blocks.`
        }
      ],
      maxTokens: 4096,
    });

    const content = response.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      let cleaned = content.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
      try {
        const translations = JSON.parse(cleaned);
        for (const original of toTranslate) {
          const translated = translations[original];
          if (translated && typeof translated === "string" && translated.trim().length > 0) {
            const finalLabel = translated.trim().slice(0, 60);
            translationCache.set(original, finalLabel);
            results.set(original, finalLabel);
          } else {
            // Fallback to dictionary-based
            const fallback = transliterateLabelSync(original);
            translationCache.set(original, fallback);
            results.set(original, fallback);
          }
        }
      } catch {
        // JSON parse failed, use dictionary fallback
        for (const original of toTranslate) {
          const fallback = transliterateLabelSync(original);
          translationCache.set(original, fallback);
          results.set(original, fallback);
        }
      }
    }
  } catch (err: any) {
    console.warn(`[Chart] LLM translation failed: ${err.message}, using dictionary fallback`);
    for (const original of toTranslate) {
      const fallback = transliterateLabelSync(original);
      translationCache.set(original, fallback);
      results.set(original, fallback);
    }
  }

  return results;
}

/**
 * Synchronous dictionary-based transliteration (fallback when LLM is unavailable).
 * Covers common Japanese academic/survey terms.
 */
export function transliterateLabelSync(str: string): string {
  if (!str) return str;
  if (!/[^\x00-\x7F]/.test(str)) return str;
  const jpMap: Record<string, string> = {
    "男性": "Male", "女性": "Female", "合計": "Total", "平均": "Mean",
    "年齢": "Age", "性別": "Gender", "身長": "Height", "体重": "Weight",
    "収入": "Income", "学歴": "Education", "職業": "Occupation",
    "既婚": "Married", "未婚": "Single", "離婚": "Divorced",
    "はい": "Yes", "いいえ": "No", "その他": "Other",
    "都道府県": "Prefecture", "市区町村": "Municipality",
    "北海道": "Hokkaido", "東京": "Tokyo", "大阪": "Osaka",
    "健康": "Health", "不健康": "Unhealthy", "普通": "Normal",
    "良い": "Good", "悪い": "Bad", "非常に良い": "Very Good",
    "非常に悪い": "Very Bad", "どちらでもない": "Neutral",
    "賛成": "Agree", "反対": "Disagree", "強く賛成": "Strongly Agree",
    "強く反対": "Strongly Disagree", "やや賛成": "Somewhat Agree",
    "やや反対": "Somewhat Disagree",
    "正社員": "Full-time", "パート": "Part-time", "アルバイト": "Part-time",
    "自営業": "Self-employed", "無職": "Unemployed", "学生": "Student",
    "回答": "Response", "質問": "Question", "項目": "Item",
    "度数": "Frequency", "割合": "Proportion", "標準偏差": "Std Dev",
    "中央値": "Median", "最大値": "Max", "最小値": "Min",
    "相関": "Correlation", "有意": "Significant",
    "第1波": "Wave 1", "第2波": "Wave 2", "第3波": "Wave 3",
    "第4波": "Wave 4", "第5波": "Wave 5",
    "波": "Wave", "年": "Year", "月": "Month", "日": "Day",
    "満足": "Satisfaction", "不満": "Dissatisfaction", "幸福": "Happiness",
    "経済": "Economy", "雇用": "Employment", "失業": "Unemployment",
    "世帯": "Household", "家族": "Family", "子供": "Children",
    "結婚": "Marriage", "配偶者": "Spouse", "親": "Parent",
    "父": "Father", "母": "Mother", "兄弟": "Siblings",
    "大学": "University", "高校": "High School", "中学": "Middle School",
    "小学": "Elementary", "卒業": "Graduate", "在学": "Enrolled",
    "正規": "Regular", "非正規": "Non-regular", "派遣": "Temporary",
    "契約": "Contract", "常勤": "Full-time", "非常勤": "Part-time",
    "不安": "Insecurity", "安定": "Stability", "形態": "Type",
    "別": "by", "的": "-type", "の": " ",
  };
  if (jpMap[str]) return jpMap[str];
  let result = str;
  // Sort by length descending to match longer phrases first
  const sortedEntries = Object.entries(jpMap).sort((a, b) => b[0].length - a[0].length);
  for (const [jp, en] of sortedEntries) {
    result = result.replace(new RegExp(jp, "g"), en);
  }
  // Clean up multiple spaces
  result = result.replace(/\s+/g, " ").trim();
  if (/[^\x00-\x7F]/.test(result)) {
    const asciiParts = result.match(/[\x20-\x7E]+/g);
    if (asciiParts && asciiParts.join("").trim().length > 0) {
      return asciiParts.join(" ").trim();
    }
    return `Variable ${str.length}`;
  }
  return result;
}

// Keep the old name as an alias for backward compatibility in tests
const transliterateLabel = transliterateLabelSync;

/**
 * Transliterate all labels in a Chart.js config to ASCII-safe text.
 */
/**
 * Synchronous transliteration of chart config (dictionary-based only).
 * Used as immediate fallback in SVG generation.
 */
function transliterateChartConfigSync(config: any): any {
  if (!config) return config;
  const clone = JSON.parse(JSON.stringify(config));
  return mapStringsDeep(clone, (value) => (
    /[^\x00-\x7F]/.test(value) ? ensureAsciiLabelSync(value, "Label") : value
  ));
}

/**
 * Async transliteration of chart config using LLM translation.
 * Collects all non-ASCII strings, translates them in one batch, then applies.
 */
async function transliterateChartConfigAsync(config: any): Promise<any> {
  if (!config) return config;
  const clone = JSON.parse(JSON.stringify(config));
  const nonAsciiSet = new Set<string>();
  collectNonAsciiStringsDeep(clone, nonAsciiSet);
  const nonAsciiStrings = Array.from(nonAsciiSet);

  // If no non-ASCII strings, return as-is
  if (nonAsciiStrings.length === 0) return clone;

  // Translate all non-ASCII strings in one batch
  const translations = await translateLabelsToEnglish(nonAsciiStrings);
  return mapStringsDeep(clone, (value) => {
    if (!/[^\x00-\x7F]/.test(value)) return value;
    return ensureAsciiLabelSync(translations.get(value) || value, "Label");
  });
}

function escapeXml(str: string): string {
  const readable = ensureAsciiLabelSync(String(str ?? ""), "Label").trim();
  return readable.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function csvCell(value: string | number): string {
  const raw = String(value ?? "");
  const normalized = /[^\x00-\x7F]/.test(raw) ? ensureAsciiLabelSync(raw, "Value") : raw;
  if (/[",\n\r]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/*  Analysis script builder (for LLM prompt)                           */
/* ------------------------------------------------------------------ */

export function buildAnalysisScript(
  dataFiles: { localPath: string; originalName: string; fileType: string }[],
  analysisCode: string,
  outputDir: string
): string {
  return analysisCode;
}

/* ------------------------------------------------------------------ */
/*  Main execution entry point                                         */
/* ------------------------------------------------------------------ */

export async function executePythonExperiment(
  runId: string,
  stageNumber: number,
  analysisCode: string,
  datasets: DatasetInfo[],
  methodContract?: MethodFeasibilityContractInput | null,
  options?: ExperimentExecutionOptions,
): Promise<ExperimentOutput> {
  const startTime = Date.now();
  const deterministicPlan = parseDeterministicAnalysisPlan(analysisCode);
  const analysisTopic = typeof deterministicPlan?.topic === "string" ? deterministicPlan.topic : "";
  let analysisInputs = deterministicPlan?.analysisInputs;
  const planMethods = Array.isArray(deterministicPlan?.methods) ? deterministicPlan.methods : [];
  const workDir = path.join(os.tmpdir(), `experiment-${runId}-${nanoid(6)}`);
  const dataDir = path.join(workDir, "data");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // Create DB record
  const dbResult = await insertExperimentResult({
    runId,
    stageNumber,
    executionStatus: "running",
    pythonCode: analysisCode,
  });

  const logs: string[] = [];
  const charts: ExperimentOutput["charts"] = [];
  const tables: ExperimentOutput["tables"] = [];
  const metrics: Record<string, number | string> = {};
  const executableMethods = buildMethodSetFromList(planMethods) ?? buildExecutableMethodSet(methodContract);
  const heartbeatMs = Math.max(5_000, options?.heartbeatMs ?? 15_000);
  const executionController = new AbortController();
  const executionTimeout = setTimeout(() => {
    executionController.abort(new Error(`Experiment execution timed out after ${Math.round(EXECUTION_TIMEOUT_MS / 1000)}s`));
  }, EXECUTION_TIMEOUT_MS);
  let currentPhase = "initialising";
  let lastPersistedAt = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight = false;

  const buildRunningStdout = (): string => {
    const joined = logs.join("\n");
    if (joined.length <= MAX_OUTPUT_LENGTH) return joined;
    const trimmedChars = joined.length - MAX_OUTPUT_LENGTH;
    return `...[truncated ${trimmedChars.toLocaleString()} chars]\n${joined.slice(-MAX_OUTPUT_LENGTH)}`;
  };

  // Persist progress snapshots to stage_logs only while the stage row is
  // still marked running. Once the pipeline engine seals the row as done or
  // failed, any in-flight heartbeat update becomes a no-op at the DB layer.
  const persistRunningState = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastPersistedAt < 4_000) return;
    lastPersistedAt = now;
    const stdout = buildRunningStdout();
    await updateStageLogWhileRunning(runId, stageNumber, {
      output: stdout.substring(0, 60_000),
      durationMs: now - startTime,
    });
  };

  const publishProgress = async (
    message: string,
    optionsOverride?: {
      phase?: string;
      heartbeat?: boolean;
      persist?: boolean;
      includeInLogs?: boolean;
    },
  ) => {
    if (executionController.signal.aborted) {
      const reason = executionController.signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : "Experiment execution aborted");
    }
    if (optionsOverride?.phase) currentPhase = optionsOverride.phase;
    if (optionsOverride?.includeInLogs !== false) {
      logs.push(message);
    }
    if (options?.onProgress) {
      await options.onProgress({
        phase: currentPhase,
        message,
        heartbeat: optionsOverride?.heartbeat ?? false,
        elapsedMs: Date.now() - startTime,
        chartCount: charts.length,
        tableCount: tables.length,
        metricCount: Object.keys(metrics).length,
        stdout: buildRunningStdout(),
      });
    }
    if (optionsOverride?.persist) {
      await persistRunningState(true);
    } else {
      await persistRunningState(false);
    }
    if (executionController.signal.aborted) {
      const reason = executionController.signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : "Experiment execution aborted");
    }
  };

  const startHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      const heartbeatMessage = `[HEARTBEAT] Stage 11 still running: ${currentPhase} (${elapsedSeconds}s elapsed, ${charts.length} charts, ${tables.length} tables, ${Object.keys(metrics).length} metrics)`;
      void publishProgress(heartbeatMessage, {
        heartbeat: true,
        persist: false,
      }).finally(() => {
        heartbeatInFlight = false;
      });
    }, heartbeatMs);
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const clearExecutionTimeout = () => {
    clearTimeout(executionTimeout);
  };

  const throwIfAborted = () => {
    if (!executionController.signal.aborted) return;
    const reason = executionController.signal.reason;
    if (reason instanceof Error) throw reason;
    throw new Error(typeof reason === "string" ? reason : "Experiment execution aborted");
  };

  try {
    startHeartbeat();
    throwIfAborted();
    // 1. Download and parse all dataset files
    await publishProgress("[INFO] Downloading and parsing datasets...", {
      phase: "downloading_datasets",
      persist: true,
    });
    const allData: Array<ParsedDataFile & { name: string }> = [];

    for (const ds of datasets) {
      throwIfAborted();
      const localPath = path.join(dataDir, ds.originalName);
      await publishProgress(`[INFO] Downloading dataset: ${ds.originalName}`, {
        phase: "downloading_datasets",
        persist: true,
      });
      await downloadFile(ds.fileUrl, localPath, ds.fileKey, ds.sizeBytes);
      await publishProgress(`[INFO] Downloaded: ${ds.originalName}`, {
        phase: "parsing_datasets",
        persist: true,
      });

      try {
        await publishProgress(`[INFO] Parsing dataset: ${ds.originalName}`, {
          phase: "parsing_datasets",
          persist: true,
        });
        await publishProgress(`[INFO] Parse context ${ds.originalName}: ${formatMemoryUsageSnapshot()}`, {
          phase: "parsing_datasets",
        });
        let lastDtaProgressLogAt = 0;
        const parsed = await parseAndValidateDataFile(localPath, ds.fileType, ds.rowCount, {
          signal: executionController.signal,
          onDtaProgress: async ({ rowsParsed, totalRows, stepIndex, stepCount, stepRows }) => {
            if (ds.fileType !== "dta") return;
            const now = Date.now();
            const denominator = Math.max(totalRows, rowsParsed, DTA_SAFE_ANALYSIS_ROWS);
            const isInitial = rowsParsed === 0;
            const isFinal = rowsParsed >= denominator;
            const stepLabel = stepIndex && stepCount
              ? `step ${Math.max(1, stepIndex)}/${stepCount}, `
              : "";
            if (!isInitial && !isFinal && now - lastDtaProgressLogAt < 1_000) return;
            lastDtaProgressLogAt = now;
            await publishProgress(
              `[INFO] DTA parse/materialization ${ds.originalName}: ${stepLabel}${rowsParsed.toLocaleString()}/${denominator.toLocaleString()} rows scanned; ${(Math.min(rowsParsed, DTA_SAFE_ANALYSIS_ROWS)).toLocaleString()}/${DTA_SAFE_ANALYSIS_ROWS.toLocaleString()} rows retained for this bounded analysis pass${stepRows ? `, ${stepRows.toLocaleString()} rows per step` : ""} (${formatMemoryUsageSnapshot()})`,
              {
                phase: "parsing_datasets",
                persist: true,
              },
            );
          },
        });
        // Remove the local file immediately after parsing to free disk space
        // and avoid keeping both on-disk and in-memory copies
        try { fs.unlinkSync(localPath); } catch {}
        try { global.gc?.(); } catch {}
        allData.push({ name: ds.originalName, ...parsed });
        const sampleNote = parsed.data.length < parsed.totalRows
          ? `; retained a bounded ${parsed.data.length.toLocaleString()}-row representative sample in memory and accumulated streaming statistics across ${parsed.fullDataProfile?.scannedRows?.toLocaleString?.() || parsed.totalRows.toLocaleString()} rows`
          : "";
        const chunkNote = parsed.chunked
          ? `; processed as ${parsed.stepCount ?? computeStepCount(parsed.totalRows)} bounded steps of up to ${(parsed.stepRows ?? DTA_ANALYSIS_STEP_ROWS).toLocaleString()} rows`
          : parsed.stepCount && parsed.stepCount > 1
            ? `; scanned in ${parsed.stepCount} visible steps`
            : "";
        await publishProgress(
          `[INFO] Parsed ${ds.originalName}: ${parsed.totalRows.toLocaleString()} rows, ${parsed.columns.length} columns (encoding: ${parsed.encoding || "native"}${sampleNote}${chunkNote}, ${formatMemoryUsageSnapshot()})`,
          {
            phase: "parsing_datasets",
            persist: true,
          },
        );
        // Log first 20 column names for debugging
        const colPreview = parsed.columns.slice(0, 20).join(", ");
        await publishProgress(`[INFO] Columns: ${colPreview}${parsed.columns.length > 20 ? ` ... (${parsed.columns.length} total)` : ""}`);
        // Log sample data (first 3 rows, first 5 columns)
        if (parsed.data.length > 0) {
          const sampleCols = parsed.columns.slice(0, 5);
          const sampleRows = parsed.data.slice(0, 3).map(row =>
            sampleCols.map(c => String(row[c] ?? "null").slice(0, 30)).join(" | ")
          );
          await publishProgress(`[INFO] Sample data (first 3 rows, first 5 cols):\n  ${sampleCols.join(" | ")}\n  ${sampleRows.join("\n  ")}`);
        }
        metrics[`${ds.originalName}_rows`] = parsed.totalRows;
        metrics[`${ds.originalName}_columns`] = parsed.columns.length;
      } catch (parseErr: any) {
        await publishProgress(`[WARN] Failed to parse ${ds.originalName}: ${parseErr.message}`, {
          phase: "parsing_datasets",
          persist: true,
        });
        // Clean up local file on parse failure too
        try { fs.unlinkSync(localPath); } catch {}
      }
    }

    if (allData.length === 0) {
      throw new Error("No datasets could be parsed successfully");
    }

    const stepwiseDatasets = allData.filter(ds => ds.chunked || ds.data.length > DTA_ANALYSIS_STEP_ROWS);
    if (stepwiseDatasets.length > 0) {
      await publishProgress("[INFO] Preparing large datasets for step-by-step analysis passes...", {
        phase: "preparing_analysis_data",
        persist: true,
      });
      for (const ds of stepwiseDatasets) {
        const materializedRows = ds.data.length;
        const visibleStepCount = computeStepCount(Math.max(materializedRows, ds.totalRows));
        for (let startRow = 0; startRow < Math.max(materializedRows, ds.totalRows); startRow += DTA_ANALYSIS_STEP_ROWS) {
          throwIfAborted();
          const endRow = Math.min(ds.totalRows, startRow + DTA_ANALYSIS_STEP_ROWS);
          const stepIndex = Math.floor(startRow / DTA_ANALYSIS_STEP_ROWS) + 1;
          await publishProgress(
            `[INFO] Analysis preparation ${ds.name}: step ${stepIndex}/${visibleStepCount}, source rows ${startRow + 1}-${endRow} of ${ds.totalRows.toLocaleString()} summarized via streaming profile; ${materializedRows.toLocaleString()} representative rows retained for model diagnostics`,
            {
              phase: "preparing_analysis_data",
              persist: true,
            },
          );
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (materializedRows < ds.totalRows) {
          await publishProgress(
            `[INFO] Analysis preparation ${ds.name}: completed bounded pass with ${materializedRows.toLocaleString()} representative rows retained for diagnostics; all ${ds.totalRows.toLocaleString()} rows contributed to the streaming profile, including ${(ds.totalRows - materializedRows).toLocaleString()} rows summarized without loading one oversized in-memory payload`,
            {
              phase: "preparing_analysis_data",
              persist: true,
            },
          );
        }
      }
    }

    // 1b. Pre-translate column names to English for chart/table/metric labels
    await publishProgress("[INFO] Translating column names to English...", {
      phase: "translating_columns",
      persist: true,
    });
    try {
      const allColNames: string[] = [];
      for (const ds of allData) {
        for (const col of ds.columns) {
          if (/[^\x00-\x7F]/.test(col) && !allColNames.includes(col)) {
            allColNames.push(col);
          }
        }
      }
      if (allColNames.length > 0) {
        const colTranslations = await translateLabelsToEnglish(allColNames);
        const renameLookup = new Map<string, string>();
        for (const ds of allData) {
          const renameMap = buildAsciiColumnRenameMap(ds.columns, colTranslations);
          renameMap.forEach((renamed, original) => renameLookup.set(original, renamed));
          applyColumnRenameMap(ds, renameMap);
        }
        // Variable roles are specified with the original (possibly Japanese) names.
        analysisInputs = remapAnalysisInputs(analysisInputs, renameLookup);
        await publishProgress(`[INFO] Translated ${allColNames.length} column names to English`, {
          phase: "translating_columns",
          persist: true,
        });
      } else {
        await publishProgress("[INFO] All column names are already ASCII, no translation needed", {
          phase: "translating_columns",
          persist: true,
        });
      }
    } catch (translateErr: any) {
      await publishProgress(`[WARN] Column name translation failed: ${translateErr.message}; applying deterministic ASCII fallback`, {
        phase: "translating_columns",
        persist: true,
      });
      const renameLookup = new Map<string, string>();
      for (const ds of allData) {
        const renameMap = buildAsciiColumnRenameMap(ds.columns);
        renameMap.forEach((renamed, original) => renameLookup.set(original, renamed));
        applyColumnRenameMap(ds, renameMap);
      }
      analysisInputs = remapAnalysisInputs(analysisInputs, renameLookup);
    }

    // 2. ALWAYS generate charts/tables/metrics from REAL DATA
    // LLM-generated analysis code is NOT trusted for data values (hallucination risk).
    // We always use generateDefaultCharts/Tables/Metrics which compute from actual data.
    await publishProgress("[INFO] Generating analysis from actual data (bypassing LLM data values to prevent hallucination)...", {
      phase: "building_analysis_outputs",
      persist: true,
    });
    if (planMethods.length > 0) {
      metrics.execution_requested_methods = planMethods.join(", ");
      await publishProgress(`[INFO] Requested execution methods: ${planMethods.join(", ")}`);
    }
    if (analysisInputs && Object.keys(analysisInputs).length > 0) {
      await publishProgress(`[INFO] Using user-specified analysis inputs: ${JSON.stringify(analysisInputs)}`);
    }
    await publishProgress("[INFO] Computing shared estimator bundle from real data...", {
      phase: "building_analysis_bundle",
      persist: true,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const analysisBundle = buildAnalysisComputationBundle(allData, analysisTopic, analysisInputs, executableMethods);
    await publishProgress("[INFO] Shared estimator bundle ready.", {
      phase: "building_analysis_bundle",
      persist: true,
    });
    await publishProgress("[INFO] Computing chart definitions from real data...", {
      phase: "computing_chart_definitions",
      persist: true,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const chartDefinitions = generateDefaultCharts(allData, executableMethods, analysisTopic, analysisInputs, analysisBundle);
    await publishProgress(`[INFO] Chart definitions ready: ${chartDefinitions.length}`, {
      phase: "computing_chart_definitions",
      persist: true,
    });
    await publishProgress("[INFO] Computing table definitions from real data...", {
      phase: "computing_table_definitions",
      persist: true,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const tableDefinitions = generateDefaultTables(allData, executableMethods, analysisTopic, analysisInputs, analysisBundle);
    await publishProgress(`[INFO] Table definitions ready: ${tableDefinitions.length}`, {
      phase: "computing_table_definitions",
      persist: true,
    });
    await publishProgress("[INFO] Computing analytical metrics from real data...", {
      phase: "computing_metrics",
      persist: true,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const metricsFromCode = generateDefaultMetrics(allData, executableMethods, analysisTopic, analysisInputs, analysisBundle);
    await publishProgress(`[INFO] Generated ${chartDefinitions.length} charts, ${tableDefinitions.length} tables, ${Object.keys(metricsFromCode).length} metrics from real data`, {
      phase: "computing_metrics",
      persist: true,
    });
    if (executableMethods !== null) {
      await publishProgress(`[INFO] Enforced method contract executable_now: ${Array.from(executableMethods).join(", ")}`);
      if (methodContract?.requiresMissingData?.length) {
        await publishProgress(`[INFO] Blocked by missing data: ${methodContract.requiresMissingData.join(", ")}`);
      }
      if (methodContract?.futureWorkOnly?.length) {
        await publishProgress(`[INFO] Future-work only methods: ${methodContract.futureWorkOnly.join(", ")}`);
      }
    }

    Object.assign(metrics, metricsFromCode);
    const routingDiagnostics = buildRoutingDiagnostics(
      allData,
      metrics,
      chartDefinitions.map(c => ({ name: c.name })),
      tableDefinitions.map(t => ({ name: t.name })),
      executableMethods,
      methodContract
    );
    metrics.execution_blocked_methods = routingDiagnostics.blockedMethods.join(", ");
    metrics.execution_unresolved_prerequisites = routingDiagnostics.unresolvedPrerequisites.join(" | ");
    metrics.execution_skipped_executable_methods = routingDiagnostics.skippedExecutableMethods.join(", ");
    metrics.execution_no_output_reasons = routingDiagnostics.noOutputReasons.join(" | ");
    metrics.analysis_methods_executed = routingDiagnostics.executedMethods.join(", ");
    if (routingDiagnostics.unresolvedPrerequisites.length > 0) {
      await publishProgress(`[INFO] Unresolved prerequisites: ${routingDiagnostics.unresolvedPrerequisites.join(" | ")}`);
    }
    if (routingDiagnostics.skippedExecutableMethods.length > 0) {
      await publishProgress(`[WARN] Executable methods with no outputs: ${routingDiagnostics.skippedExecutableMethods.join(", ")}`);
    }

    // 2b. Translate table headers, row values, and metric keys that contain non-ASCII
    await publishProgress("[INFO] Translating table/metric labels to English...", {
      phase: "translating_labels",
      persist: true,
    });
    try {
      // Collect all non-ASCII strings from tables (headers + cell values) and metric keys
      const nonAsciiSet = new Set<string>();
      for (const t of tableDefinitions) {
        for (const h of t.headers) {
          if (/[^\x00-\x7F]/.test(String(h))) nonAsciiSet.add(String(h));
        }
        for (const row of t.rows) {
          for (const cell of row) {
            if (typeof cell === "string" && /[^\x00-\x7F]/.test(cell)) nonAsciiSet.add(cell);
          }
        }
        if (/[^\x00-\x7F]/.test(t.description)) nonAsciiSet.add(t.description);
        if (t.notes && /[^\x00-\x7F]/.test(t.notes)) nonAsciiSet.add(t.notes);
      }
      for (const key of Object.keys(metrics)) {
        if (/[^\x00-\x7F]/.test(key)) nonAsciiSet.add(key);
      }
      for (const cd of chartDefinitions) {
        if (/[^\x00-\x7F]/.test(cd.description)) nonAsciiSet.add(cd.description);
        if (cd.caption && /[^\x00-\x7F]/.test(cd.caption)) nonAsciiSet.add(cd.caption);
      }

      if (nonAsciiSet.size > 0) {
        const labelTranslations = await translateLabelsToEnglish(Array.from(nonAsciiSet));
        const tr = (s: string) => labelTranslations.get(s) || transliterateLabelSync(s);

        // Apply to tables
        for (const t of tableDefinitions) {
          t.headers = t.headers.map(h => /[^\x00-\x7F]/.test(String(h)) ? tr(String(h)) : String(h));
          t.rows = t.rows.map(row => row.map(cell =>
            typeof cell === "string" && /[^\x00-\x7F]/.test(cell) ? tr(cell) : cell
          ));
          if (/[^\x00-\x7F]/.test(t.description)) t.description = tr(t.description);
          if (t.notes && /[^\x00-\x7F]/.test(t.notes)) t.notes = tr(t.notes);
        }

        // Apply to metric keys
        const newMetrics: Record<string, number | string> = {};
        for (const [key, val] of Object.entries(metrics)) {
          const newKey = /[^\x00-\x7F]/.test(key) ? tr(key) : key;
          newMetrics[newKey] = val;
        }
        // Replace metrics
        for (const key of Object.keys(metrics)) delete metrics[key];
        Object.assign(metrics, newMetrics);

        // Apply to chart descriptions
        for (const cd of chartDefinitions) {
          if (/[^\x00-\x7F]/.test(cd.description)) cd.description = tr(cd.description);
          if (cd.caption && /[^\x00-\x7F]/.test(cd.caption)) cd.caption = tr(cd.caption);
        }

        await publishProgress(`[INFO] Translated ${nonAsciiSet.size} non-ASCII labels in tables/metrics/charts`, {
          phase: "translating_labels",
          persist: true,
        });
      }
    } catch (trErr: any) {
      await publishProgress(`[WARN] Table/metric label translation failed: ${trErr.message}; applying deterministic ASCII fallback`, {
        phase: "translating_labels",
        persist: true,
      });
      const tr = (s: string) => ensureAsciiLabelSync(s);
      for (const t of tableDefinitions) {
        t.headers = t.headers.map(h => typeof h === "string" ? tr(h) : String(h));
        t.rows = t.rows.map(row => row.map(cell => typeof cell === "string" ? tr(cell) : cell));
        t.description = tr(t.description);
        if (t.notes) t.notes = tr(t.notes);
      }
      const fallbackMetrics: Record<string, number | string> = {};
      for (const [key, val] of Object.entries(metrics)) {
        fallbackMetrics[tr(key)] = val;
      }
      for (const key of Object.keys(metrics)) delete metrics[key];
      Object.assign(metrics, fallbackMetrics);
      for (const cd of chartDefinitions) {
        cd.description = tr(cd.description);
        if (cd.caption) cd.caption = tr(cd.caption);
      }
    }

    // 3. Render each chart via chartjs-node-canvas
    // Pre-translate all chart labels to English using LLM before rendering
    await publishProgress(`[INFO] Translating chart labels to English...`, {
      phase: "translating_chart_labels",
      persist: true,
    });
    for (let chartIndex = 0; chartIndex < chartDefinitions.length; chartIndex++) {
      const chartDef = chartDefinitions[chartIndex];
      try {
        await publishProgress(`[INFO] Preparing chart labels ${chartIndex + 1}/${chartDefinitions.length}: ${chartDef.name}`, {
          phase: "translating_chart_labels",
          persist: true,
        });
        let config: any;
        if (typeof chartDef.config === "string") {
          try { config = JSON.parse(chartDef.config); } catch { config = null; }
        } else {
          config = chartDef.config;
        }
        if (config) {
          const translated = await transliterateChartConfigAsync(config);
          chartDef.config = translated;
        }
      } catch (err: any) {
        await publishProgress(`[WARN] LLM translation failed for ${chartDef.name}: ${err.message}; applying deterministic ASCII fallback`, {
          phase: "translating_chart_labels",
        });
        if (chartDef.config) {
          chartDef.config = transliterateChartConfigSync(chartDef.config);
        }
      }
    }

    await publishProgress(`[INFO] Rendering ${chartDefinitions.length} charts (server-side, no Chromium)...`, {
      phase: "rendering_charts",
      persist: true,
    });
    for (let chartIndex = 0; chartIndex < chartDefinitions.length; chartIndex++) {
      const chartDef = chartDefinitions[chartIndex];
      try {
        await publishProgress(`[INFO] Rendering chart ${chartIndex + 1}/${chartDefinitions.length}: ${chartDef.name}`, {
          phase: "rendering_charts",
          persist: true,
        });
        const configStr = typeof chartDef.config === "string"
          ? chartDef.config
          : JSON.stringify(chartDef.config);

        const pngBuffer = await renderChartToPng(
          configStr,
          chartDef.width || 900,
          chartDef.height || 560
        );

        // Determine content type based on buffer content
        const isSvg = pngBuffer.length > 0 && pngBuffer[0] === 0x3C; // '<' character
        const contentType = isSvg ? "image/svg+xml" : "image/png";
        const ext = isSvg ? "svg" : "png";
        const format: "png" | "svg" = isSvg ? "svg" : "png";

        const chartKey = `experiments/${runId}/${chartDef.name}.${ext}`;
        const { url } = await storagePut(chartKey, pngBuffer, contentType);
        charts.push({
          name: chartDef.name,
          url,
          description: chartDef.description || chartDef.name,
          fileKey: chartKey,
          mimeType: contentType,
          format,
          caption: chartDef.caption,
          section: chartDef.section,
        });
        await publishProgress(`[CHART] Generated: ${chartDef.name} (${(pngBuffer.length / 1024).toFixed(1)} KiB, ${ext})`, {
          phase: "rendering_charts",
          persist: true,
        });
      } catch (chartErr: any) {
        await publishProgress(`[WARN] Failed to render chart ${chartDef.name}: ${chartErr.message}`, {
          phase: "rendering_charts",
        });
      }
    }

    // 4. Process tables
    await publishProgress(`[INFO] Processing ${tableDefinitions.length} tables...`, {
      phase: "processing_tables",
      persist: true,
    });
    for (let tableIndex = 0; tableIndex < tableDefinitions.length; tableIndex++) {
      const tableDef = tableDefinitions[tableIndex];
      try {
        await publishProgress(`[INFO] Processing table ${tableIndex + 1}/${tableDefinitions.length}: ${tableDef.name}`, {
          phase: "processing_tables",
          persist: true,
        });
        const headerRow = tableDef.headers.map(h => csvCell(h)).join(",");
        const dataRows = tableDef.rows.map((r: (string | number)[]) => r.map(cell => csvCell(cell)).join(",")).join("\n");
        const csvContent = `\ufeff${headerRow}\n${dataRows}`;

        const tableKey = `experiments/${runId}/${tableDef.name}.csv`;
        const { url } = await storagePut(tableKey, csvContent, "text/csv; charset=utf-8");
        tables.push({
          name: tableDef.name,
          url,
          description: tableDef.description || tableDef.name,
          data: `${headerRow}\n${dataRows.split("\n").slice(0, 20).join("\n")}`,
          headers: tableDef.headers.map(h => String(h)),
          rows: tableDef.rows.slice(0, 60),
          notes: tableDef.notes,
          section: tableDef.section,
        });
        await publishProgress(`[TABLE] Generated: ${tableDef.name} (${tableDef.rows.length} rows)`, {
          phase: "processing_tables",
          persist: true,
        });
      } catch (tableErr: any) {
        await publishProgress(`[WARN] Failed to process table ${tableDef.name}: ${tableErr.message}`, {
          phase: "processing_tables",
        });
      }
    }

    const executionTimeMs = Date.now() - startTime;
    const stdout = logs.join("\n");

    const output: ExperimentOutput = {
      success: true,
      stdout: stdout.slice(0, MAX_OUTPUT_LENGTH),
      stderr: "",
      exitCode: 0,
      executionTimeMs,
      charts,
      tables,
      metrics,
    };

    stopHeartbeat();
    clearExecutionTimeout();
    await updateExperimentResult(dbResult.id, {
      executionStatus: "success",
      stdout: output.stdout,
      stderr: "",
      exitCode: 0,
      executionTimeMs,
      generatedCharts: charts as any,
      generatedTables: tables as any,
      metrics: metrics as any,
    });

    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    return output;

  } catch (err: any) {
    stopHeartbeat();
    clearExecutionTimeout();
    const executionTimeMs = Date.now() - startTime;
    const stderr = err?.message || "Execution failed";
    logs.push(`[ERROR] ${stderr}`);

    const output: ExperimentOutput = {
      success: false,
      stdout: logs.join("\n").slice(0, MAX_OUTPUT_LENGTH),
      stderr,
      exitCode: -1,
      executionTimeMs,
      charts,
      tables,
      metrics,
    };

    await updateExperimentResult(dbResult.id, {
      executionStatus: "error",
      stdout: output.stdout,
      stderr,
      exitCode: -1,
      executionTimeMs,
      generatedCharts: charts as any,
      generatedTables: tables as any,
      metrics: metrics as any,
    });

    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    return output;
  }
}

/* ------------------------------------------------------------------ */
/*  Default chart/table/metrics generators                             */
/* ------------------------------------------------------------------ */

/**
 * Classify columns into numeric and categorical based on actual data values.
 * Samples multiple rows to avoid misclassification from a single row.
 */
/**
 * Detect whether a numeric column is actually an ID/code column (not meaningful for statistics).
 * ID columns have characteristics like: sequential integers, very high cardinality, or
 * column names suggesting identifiers.
 */
export function isIdOrCodeColumn(col: string, data: Record<string, any>[]): boolean {
  const lowerCol = col.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Name-based detection: common ID/code column patterns
  const idPatterns = [
    "id", "code", "prefecture", "prefcode", "prefecturecode", "regioncode",
    "zipcode", "postalcode", "fips", "iso", "index", "rowid", "recordid",
    "serialno", "caseid", "respondentid", "householdid", "personid",
    "都道府県", "コード", "番号", "識別",
  ];
  if (idPatterns.some(p => lowerCol.includes(p))) return true;
  const measurePatterns = [
    "score", "rating", "level", "grade", "scale", "age", "year",
    "income", "salary", "wage", "price", "cost", "count", "rate", "ratio",
    "percent", "proportion", "frequency", "duration", "time", "hours",
    "スコア", "得点", "評価", "年齢", "収入", "給与",
  ];
  const looksLikeMeasure = measurePatterns.some(p => lowerCol.includes(p));

  // Statistical detection: check if values are sequential integers with very high cardinality
  const sampleSize = Math.min(data.length, 200);
  const values = data.slice(0, sampleSize)
    .filter(r => !isMissingValue(r[col]))
    .map(r => Number(r[col]))
    .filter(v => !isNaN(v) && Number.isInteger(v));
  if (values.length < 10) return false;

  // If all values are integers and unique count is very high relative to sample, likely an ID
  const uniqueCount = new Set(values).size;
  if (uniqueCount / values.length > 0.9 && values.length > 20 && !looksLikeMeasure) return true;

  // If values are small integers (1-50) with few unique values, likely a code (e.g., prefecture 1-47)
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min >= 0 && max <= 100 && uniqueCount <= 50 && uniqueCount === (max - min + 1)) {
    // Looks like a sequential code (e.g., prefecture 1-47)
    // Only flag if the column name doesn't suggest a meaningful measure
    if (!looksLikeMeasure) return true;
  }

  return false;
}

function isMissingValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || value === "NA" || value === "NaN" || value === ".";
}

function isLowCardinalityNumericCategory(col: string, data: Record<string, any>[]): boolean {
  const lowerCol = col.toLowerCase().replace(/[^a-z0-9]/g, "");
  const categoryNamePatterns = [
    "sex", "gender", "male", "female", "group", "arm", "cohort", "category", "type", "class",
    "race", "ethnicity", "marital", "education", "treated", "treatment", "control", "post", "eligible",
    "binary", "dummy", "indicator", "status", "employment", "region", "wave", "panel",
  ];
  const continuousNamePatterns = [
    "score", "rating", "scale", "age", "year", "income", "salary", "wage", "price", "cost",
    "amount", "count", "rate", "ratio", "percent", "duration", "hours", "weight", "height",
  ];
  const nameLooksCategorical = categoryNamePatterns.some(pattern => lowerCol.includes(pattern));
  const nameLooksContinuous = continuousNamePatterns.some(pattern => lowerCol.includes(pattern));
  const values = data.slice(0, Math.min(data.length, 500))
    .filter(row => !isMissingValue(row[col]))
    .map(row => Number(row[col]))
    .filter(value => Number.isFinite(value));
  if (values.length < 20) return false;
  const uniqueValues = Array.from(new Set(values));
  const allInteger = uniqueValues.every(value => Number.isInteger(value));
  if (!allInteger) return false;
  const uniqueCount = uniqueValues.length;
  const uniqueShare = uniqueCount / values.length;
  if (uniqueCount <= 2) return true;
  if (nameLooksCategorical && uniqueCount <= 20 && uniqueShare <= 0.35) return true;
  if (!nameLooksContinuous && uniqueCount <= 10 && uniqueShare <= 0.15) return true;
  return false;
}

export function classifyColumns(
  data: Record<string, any>[],
  columns: string[]
): { numericCols: string[]; categoricalCols: string[]; idCols: string[]; nullCols: string[] } {
  const numericCols: string[] = [];
  const categoricalCols: string[] = [];
  const idCols: string[] = [];
  const nullCols: string[] = [];
  const sampleSize = Math.min(data.length, 50);

  for (const col of columns) {
    let numericCount = 0;
    let totalNonNull = 0;

    for (let i = 0; i < sampleSize; i++) {
      const val = data[i][col];
      if (isMissingValue(val)) continue;
      totalNonNull++;
      if (typeof val === "number" || (typeof val === "string" && !isNaN(Number(val)) && val.trim() !== "")) {
        numericCount++;
      }
    }

    if (totalNonNull === 0) {
      nullCols.push(col);
      continue;
    }

    // A column is numeric if >70% of non-null sampled values are numeric
    if (numericCount / totalNonNull > 0.7) {
      // Check if this is actually an ID/code column
      if (isIdOrCodeColumn(col, data)) {
        idCols.push(col);
      } else {
        numericCols.push(col);
        if (isLowCardinalityNumericCategory(col, data)) {
          categoricalCols.push(col);
        }
      }
    } else {
      categoricalCols.push(col);
    }
  }

  if (nullCols.length > 0) {
    console.warn(`[classifyColumns] All-null columns skipped: ${nullCols.join(", ")}`);
  }

  return { numericCols, categoricalCols, idCols, nullCols };
}

type ParsedDataset = {
  name: string;
  data: Record<string, any>[];
  columns: string[];
  totalRows: number;
  fullDataProfile?: FullDataProfile;
};

function metricKeyPart(input: string, maxLen = 24): string {
  const ascii = transliterateLabelSync(input || "var");
  const normalized = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen);
  return normalized || "var";
}

function parseNumericPairs(ds: ParsedDataset, xCol: string, yCol: string): [number, number][] {
  const pairs: [number, number][] = [];
  for (const row of ds.data) {
    // Number(null) and Number("") are 0, so missing cells must be skipped explicitly.
    if (isMissingValue(row[xCol]) || isMissingValue(row[yCol])) continue;
    const x = Number(row[xCol]);
    const y = Number(row[yCol]);
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  return pairs;
}

function getFiniteNumericValues(ds: ParsedDataset, col: string, limit = 2500): number[] {
  const values: number[] = [];
  for (const row of ds.data) {
    if (isMissingValue(row[col])) continue;
    const value = Number(row[col]);
    if (!isNaN(value) && isFinite(value)) values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function isPathologicalNumericColumn(ds: ParsedDataset, col: string): boolean {
  const values = getFiniteNumericValues(ds, col);
  if (values.length < 20) return false;
  const absValues = values.map(value => Math.abs(value));
  const maxAbs = Math.max(...absValues);
  if (!isFinite(maxAbs) || maxAbs === 0) return false;
  const extremeShare = absValues.filter(value => value >= 1e12).length / values.length;
  const maxValueCount = absValues.filter(value => value === maxAbs).length;
  const repeatedExtremeShare = maxValueCount / values.length;
  const zeroOrSentinelDominance = values.filter(value => value === 0 || Math.abs(value) >= 1e20).length / values.length;
  return maxAbs >= 1e20 || extremeShare >= 0.25 || repeatedExtremeShare >= 0.4 || zeroOrSentinelDominance >= 0.75;
}

function rankMeaningfulNumericColumns(
  ds: ParsedDataset,
  numericCols: string[],
  hints: EconometricDesignHints,
  topic?: string,
): string[] {
  const topicKeywords = extractTopicKeywords(topic);
  const scored = numericCols.map((col) => {
    let score = scoreTopicAlignment(col, topicKeywords);
    if (col === hints.primaryOutcomeCol) score += 20;
    if (col === hints.primaryRegressorCol) score += 12;
    if (col === hints.primaryTreatmentCol) score += 10;
    if (hints.outcomeCols.includes(col)) score += 8;
    if (/(mental|health|ghq|depress|anxiety|stress|wellbeing|happiness|wage|income|hours|employment|unemployment|earnings|salary|shock)/i.test(col)) score += 6;
    if (/(age|year|month|wave|time|post|flag|dummy|index|scorecard)/i.test(col)) score -= 5;
    if (isBinaryLikeColumn(ds, col) && !/(employment|unemployment|health|ghq|shock|treat|status)/i.test(col)) score -= 2;
    if (isPathologicalNumericColumn(ds, col)) score -= 25;
    return { col, score };
  });

  const usable = scored.filter(item => item.score > -20);
  const pool = usable.length > 0 ? usable : scored;
  return pool
    .sort((a, b) => b.score - a.score || a.col.localeCompare(b.col))
    .map(item => item.col);
}

function choosePreferredDescriptiveNumericColumn(
  ds: ParsedDataset,
  numericCols: string[],
  hints: EconometricDesignHints,
): string | undefined {
  const orderedCandidates = Array.from(new Set([
    hints.primaryOutcomeCol,
    ...hints.outcomeCols,
    hints.primaryRegressorCol,
    ...numericCols,
  ].filter((col): col is string => Boolean(col))));

  return orderedCandidates.find(col => !isBinaryLikeColumn(ds, col) && !isPathologicalNumericColumn(ds, col))
    || orderedCandidates.find(col => !isPathologicalNumericColumn(ds, col))
    || numericCols[0];
}

function chooseSecondaryDescriptiveNumericColumn(
  ds: ParsedDataset,
  numericCols: string[],
  hints: EconometricDesignHints,
  primaryCol?: string,
): string | undefined {
  const orderedCandidates = Array.from(new Set([
    hints.primaryRegressorCol,
    hints.primaryTreatmentCol,
    ...hints.outcomeCols,
    ...numericCols,
  ].filter((col): col is string => Boolean(col) && col !== primaryCol)));

  return orderedCandidates.find(col => !isBinaryLikeColumn(ds, col) && !isPathologicalNumericColumn(ds, col))
    || orderedCandidates.find(col => !isPathologicalNumericColumn(ds, col))
    || numericCols.find(col => col !== primaryCol);
}

/**
 * Approximate two-tailed p-value for Pearson correlation using t-distribution.
 * Uses Abramowitz & Stegun rational approximation for the normal CDF when df > 30,
 * and discrete thresholds for small samples.
 */
function approximateCorrelationPValue(r: number, n: number): number {
  if (n <= 3) return 1;
  const absR = Math.abs(r);
  if (absR >= 1) return 0;
  const df = n - 2;
  const t = absR * Math.sqrt(df / (1 - absR * absR + 1e-12));
  return approxTwoTailPValue(t, df);
}

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9)
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = coefficients[0];
  for (let i = 1; i < 9; i++) sum += coefficients[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

function incompleteBetaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 300;
  const epsilon = 3e-14;
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

/** Regularised incomplete beta function I_x(a, b). */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const logFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(logFront);
  if (x < (a + 1) / (a + b + 2)) {
    return front * incompleteBetaContinuedFraction(a, b, x) / a;
  }
  return 1 - (front * incompleteBetaContinuedFraction(b, a, 1 - x)) / b;
}

/** Exact two-tailed p-value of a Student-t statistic. */
export function studentTTwoTailPValue(t: number, df: number): number {
  if (!Number.isFinite(t)) return Number.isNaN(t) ? 1 : 0;
  if (!(df > 0)) return 1;
  const p = regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return Math.min(1, Math.max(0, p));
}

/** Upper-tail p-value of an F statistic with (d1, d2) degrees of freedom. */
export function fDistributionPValue(f: number, d1: number, d2: number): number {
  if (!(f > 0) || !(d1 > 0) || !(d2 > 0)) return 1;
  if (!Number.isFinite(f)) return 0;
  const p = regularizedIncompleteBeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
  return Math.min(1, Math.max(0, p));
}

const tCriticalCache = new Map<number, number>();

/** Two-sided critical value of Student's t (default 95% confidence). */
export function studentTCritical(df: number, alpha = 0.05): number {
  if (!(df > 0)) return 1.96;
  const key = Math.round(df * 1000) / 1000 + alpha * 1e6;
  const cached = tCriticalCache.get(key);
  if (cached !== undefined) return cached;
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (studentTTwoTailPValue(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  const value = (lo + hi) / 2;
  tCriticalCache.set(key, value);
  return value;
}

/**
 * Two-tailed p-value for a t-statistic with given degrees of freedom
 * (exact Student-t distribution via the regularised incomplete beta function).
 */
function approxTwoTailPValue(t: number, df: number): number {
  return studentTTwoTailPValue(t, df);
}

function regressionStatsFromPairs(pairs: [number, number][]): {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
} | null {
  if (pairs.length < 10) return null;
  const n = pairs.length;
  const meanX = pairs.reduce((a, p) => a + p[0], 0) / n;
  const meanY = pairs.reduce((a, p) => a + p[1], 0) / n;

  let cov = 0;
  let varX = 0;
  let ssTot = 0;
  for (const [x, y] of pairs) {
    cov += (x - meanX) * (y - meanY);
    varX += (x - meanX) ** 2;
    ssTot += (y - meanY) ** 2;
  }
  if (varX <= 0) return null;

  const slope = cov / varX;
  const intercept = meanY - slope * meanX;
  let ssRes = 0;
  for (const [x, y] of pairs) {
    const pred = intercept + slope * x;
    ssRes += (y - pred) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, intercept, r2, n };
}

function parseTimeValue(raw: any): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number" && isFinite(raw)) return raw;
  const asNum = Number(raw);
  if (!isNaN(asNum) && isFinite(asNum)) return asNum;

  if (typeof raw === "string") {
    const date = new Date(raw);
    if (!isNaN(date.getTime())) {
      return date.getTime() / 86400000; // days
    }
  }
  return null;
}

function parseBinaryValue(raw: any): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number" && isFinite(raw) && (raw === 0 || raw === 1)) return raw;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  if (["1", "true", "yes", "y", "treated", "treatment", "post", "after", "eligible", "male", "man", "m"].includes(text)) return 1;
  if (["0", "false", "no", "n", "control", "pre", "before", "ineligible", "female", "woman", "f"].includes(text)) return 0;
  return null;
}

function sampleDistinctValues(ds: ParsedDataset, col: string, limit = 200): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const row of ds.data) {
    const raw = row[col];
    if (raw === null || raw === undefined || raw === "") continue;
    const key = String(raw).trim();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      values.push(key);
      if (values.length >= limit) break;
    }
  }
  return values;
}

function isBinaryLikeColumn(ds: ParsedDataset, col: string): boolean {
  const values = sampleDistinctValues(ds, col, 12);
  if (values.length === 0 || values.length > 2) return false;
  return values.every(v => parseBinaryValue(v) !== null);
}

function normaliseColumnReference(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveDatasetColumn(ds: ParsedDataset, requested?: string): string | undefined {
  if (!requested || !requested.trim()) return undefined;
  const trimmed = requested.trim();
  const exact = ds.columns.find(column => column === trimmed);
  if (exact) return exact;
  const exactCaseInsensitive = ds.columns.find(column => column.toLowerCase() === trimmed.toLowerCase());
  if (exactCaseInsensitive) return exactCaseInsensitive;
  const normalizedRequested = normaliseColumnReference(trimmed);
  if (!normalizedRequested) return undefined;
  return ds.columns.find(column => normaliseColumnReference(column) === normalizedRequested);
}

function uniqueDefinedColumns(columns: Array<string | undefined>): string[] {
  return Array.from(new Set(columns.filter((column): column is string => Boolean(column))));
}

function mergeAnalysisInputsIntoDesignHints(
  ds: ParsedDataset,
  hints: EconometricDesignHints,
  analysisInputs?: AnalysisInputs,
): EconometricDesignHints {
  if (!analysisInputs) {
    return {
      ...hints,
      controlCols: [],
      specifiedInputMatches: [],
      specifiedInputMissing: [],
    };
  }

  const specifiedInputMatches: string[] = [];
  const specifiedInputMissing: string[] = [];
  const resolveAndTrack = (label: string, requested?: string): string | undefined => {
    if (!requested || !requested.trim()) return undefined;
    const resolved = resolveDatasetColumn(ds, requested);
    if (resolved) specifiedInputMatches.push(`${label}:${resolved}`);
    else specifiedInputMissing.push(`${label}:${requested.trim()}`);
    return resolved;
  };

  const resolvedOutcome = resolveAndTrack("outcome", analysisInputs.outcome);
  const resolvedTreatment = resolveAndTrack("treatment", analysisInputs.treatment);
  const resolvedEntity = resolveAndTrack("entity", analysisInputs.entity);
  const resolvedTime = resolveAndTrack("time", analysisInputs.time);
  const resolvedSubgroup = resolveAndTrack("subgroup", analysisInputs.subgroup);
  const resolvedControls = uniqueDefinedColumns(
    (analysisInputs.controls || []).map(control => resolveAndTrack("control", control))
  ).filter(column => column !== resolvedOutcome && column !== resolvedTreatment);

  const primaryOutcomeCol = resolvedOutcome || hints.primaryOutcomeCol;
  const primaryTreatmentCol = resolvedTreatment || hints.primaryTreatmentCol;
  const primaryRegressorCol = (
    primaryTreatmentCol && primaryTreatmentCol !== primaryOutcomeCol
      ? primaryTreatmentCol
      : hints.primaryRegressorCol && hints.primaryRegressorCol !== primaryOutcomeCol
        ? hints.primaryRegressorCol
        : resolvedControls.find(column => column !== primaryOutcomeCol)
  ) || hints.primaryRegressorCol;

  return {
    ...hints,
    outcomeCols: uniqueDefinedColumns([resolvedOutcome, ...hints.outcomeCols]),
    treatmentCols: uniqueDefinedColumns([resolvedTreatment, ...hints.treatmentCols]),
    entityCols: uniqueDefinedColumns([resolvedEntity, ...hints.entityCols]),
    timeCols: uniqueDefinedColumns([resolvedTime, ...hints.timeCols]),
    primaryOutcomeCol,
    primaryTreatmentCol,
    primaryEntityCol: resolvedEntity || hints.primaryEntityCol,
    primaryTimeCol: resolvedTime || hints.primaryTimeCol,
    primaryRegressorCol,
    controlCols: resolvedControls,
    subgroupCol: resolvedSubgroup,
    specifiedInputMatches,
    specifiedInputMissing,
  };
}

interface EconometricDesignHints {
  timeCols: string[];
  entityCols: string[];
  treatmentCols: string[];
  outcomeCols: string[];
  instrumentCols: string[];
  runningCols: string[];
  controlCols: string[];
  specifiedInputMatches: string[];
  specifiedInputMissing: string[];
  primaryTimeCol?: string;
  primaryEntityCol?: string;
  primaryTreatmentCol?: string;
  primaryOutcomeCol?: string;
  primaryRegressorCol?: string;
  primaryInstrumentCol?: string;
  primaryRunningCol?: string;
  subgroupCol?: string;
  /** True when controls were chosen automatically because none were specified. */
  controlsAutoSelected?: boolean;
}

type MissingDataMode = "complete_case" | "mean_imputation";

interface RegressionCoefficientEstimate {
  name: string;
  coefficient: number;
  se: number;
  tStat: number;
  pValue: number;
  ciLower: number;
  ciUpper: number;
}

interface RobustOlsResult {
  xCol: string;
  yCol: string;
  regressorCols: string[];
  controlCols: string[];
  omittedControlCols: string[];
  droppedCollinearCols: string[];
  intercept: number;
  slope: number;
  seIntercept: number;
  seSlope: number;
  tStat: number;
  pValue: number;
  r2: number;
  adjR2: number;
  n: number;
  ciLower: number;
  ciUpper: number;
  vcovType: "hc1" | "cluster";
  clusterCol?: string;
  clusterCount?: number;
  missingDataMode: MissingDataMode;
  imputedPredictorCells: number;
  coefficients: RegressionCoefficientEstimate[];
  fittedResiduals: Array<{ fitted: number; residual: number }>;
}

interface PanelFixedEffectsResult {
  entityCol: string;
  timeCol: string;
  xCol: string;
  yCol: string;
  regressorCols: string[];
  controlCols: string[];
  omittedControlCols: string[];
  droppedCollinearCols: string[];
  beta: number;
  se: number;
  tStat: number;
  pValue: number;
  n: number;
  entities: number;
  periods: number;
  r2Within: number;
  vcovType: "hc1" | "cluster";
  clusterCol?: string;
  clusterCount?: number;
  missingDataMode: MissingDataMode;
  imputedPredictorCells: number;
  coefficients: RegressionCoefficientEstimate[];
  fittedResiduals: Array<{ fitted: number; residual: number }>;
}

interface PanelFixedEffectsDiagnostics {
  status: "passed" | "blocked";
  reason: string;
  reasons: string[];
  entityCol?: string;
  timeCol?: string;
  xCol?: string;
  yCol?: string;
  completeCaseRows: number;
  completeCaseEntities: number;
  completeCasePeriods: number;
  repeatedEntityCount: number;
  informativeEntityCountX: number;
  informativeEntityCountY: number;
  informativeEntityCountBoth: number;
  minObsPerEntity: number;
  medianObsPerEntity: number;
  maxObsPerEntity: number;
  transformedRows: number;
}

interface PanelFixedEffectsAssessment {
  diagnostics: PanelFixedEffectsDiagnostics;
  prepared: PreparedPanelRegressionData | null;
  transformed: Array<{ x: number[]; ydd: number; clusterId: string }>;
  transformedPredictorNames: string[];
  transformedSsTot: number;
}

interface DiffInDiffPoint {
  label: string;
  timeValue: number;
  relIndex: number;
  treatedMean: number;
  controlMean: number;
  effect: number;
}

interface DiffInDiffResult {
  timeCol: string;
  entityCol?: string;
  treatmentCol: string;
  outcomeCol: string;
  treatmentStart: number;
  estimate: number;
  treatedPre: number;
  treatedPost: number;
  controlPre: number;
  controlPost: number;
  n: number;
  preTrendDelta: number;
  series: DiffInDiffPoint[];
}

interface SyntheticControlResult {
  entityCol: string;
  timeCol: string;
  outcomeCol: string;
  treatmentCol: string;
  treatedUnit: string;
  treatmentStart: number;
  donorCount: number;
  preRmse: number;
  postRmse: number;
  attPostMean: number;
  weights: Array<{ unit: string; weight: number }>;
  series: Array<{
    label: string;
    timeValue: number;
    relIndex: number;
    treated: number;
    synthetic: number;
    gap: number;
  }>;
}

interface SyntheticControlPlaceboResult {
  treatedUnit: string;
  treatmentStart: number;
  actualRatio: number;
  ratios: Array<{
    unit: string;
    ratio: number;
    preRmse: number;
    postRmse: number;
    isActual: boolean;
  }>;
  actualRank: number;
}

interface Iv2SlsResult {
  zCol: string;
  xCol: string;
  yCol: string;
  beta: number;
  se: number;
  tStat: number;
  pValue: number;
  ciLower: number;
  ciUpper: number;
  n: number;
  firstStageSlope: number;
  firstStageSe: number;
  firstStageF: number;
  firstStagePValue: number;
  reducedFormSlope: number;
  firstStagePoints: Array<{ x: number; y: number }>;
}

interface RddResult {
  runningCol: string;
  treatmentCol: string;
  outcomeCol: string;
  cutoff: number;
  bandwidth: number;
  estimate: number;
  se: number;
  tStat: number;
  pValue: number;
  nLocal: number;
  leftN: number;
  rightN: number;
  leftSlope: number;
  rightSlope: number;
  bins: Array<{ x: number; y: number; side: "left" | "right"; count: number }>;
  fitLine: Array<{ x: number; y: number; side: "left" | "right" }>;
}

interface PropensityBalanceEntry {
  covariate: string;
  smdBefore: number;
  smdAfter: number;
  meanTreated: number;
  meanControl: number;
  weightedTreated: number;
  weightedControl: number;
}

interface PropensityScoreResult {
  treatmentCol: string;
  outcomeCol: string;
  covariates: string[];
  ate: number;
  se: number;
  tStat: number;
  pValue: number;
  ciLower: number;
  ciUpper: number;
  n: number;
  meanScoreTreated: number;
  meanScoreControl: number;
  overlapMin: number;
  overlapMax: number;
  balance: PropensityBalanceEntry[];
  scoreRows: Array<{ score: number; treatment: number }>;
}

interface QuantileRegressionEstimate {
  tau: number;
  intercept: number;
  slope: number;
  interceptSe: number;
  slopeSe: number;
  tStat: number;
  pValue: number;
  ciLower: number;
  ciUpper: number;
  pseudoR1: number;
  coefficients: RegressionCoefficientEstimate[];
  bootstrapReplicates: number;
}

interface QuantileRegressionResult {
  xCol: string;
  yCol: string;
  regressorCols: string[];
  controlCols: string[];
  omittedControlCols: string[];
  droppedCollinearCols: string[];
  n: number;
  vcovType: "bootstrap";
  clusterCol?: string;
  clusterCount?: number;
  missingDataMode: MissingDataMode;
  imputedPredictorCells: number;
  estimates: QuantileRegressionEstimate[];
}

function detectTimeColumnsFromDataset(ds: ParsedDataset): string[] {
  const byName = ds.columns.filter(c =>
    /(year|month|date|time|wave|period|quarter|fiscal|round)/i.test(c) &&
    // Durations and counts are measures, not time indices.
    !/(duration|spent|minute|hour|second|commute|elapsed|times_|_times|overtime|lifetime|full[_ ]?time|part[_ ]?time)/i.test(c),
  );
  const byValue = ds.columns.filter(c => !byName.includes(c) && looksLikeTimeValues(ds, c));
  return [...byName, ...byValue];
}

/** Year-valued integers or date strings, recognised independently of the column name. */
function looksLikeTimeValues(ds: ParsedDataset, col: string): boolean {
  const sample = sampleDistinctValues(ds, col, 300);
  if (sample.length < 3) return false;
  const numeric = sample.map(Number).filter(Number.isFinite);
  if (numeric.length === sample.length) {
    return sample.length <= 150 && numeric.every(v => Number.isInteger(v) && v >= 1900 && v <= 2100);
  }
  const dateLike = sample.filter(v =>
    /^\d{4}[-/.年]\s*\d{1,2}(?:[-/.月]\s*\d{1,2}日?)?/.test(v) ||
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(v) ||
    /^\d{4}-\d{2}-\d{2}T/.test(v) ||
    /^\d{4}\s*[-_]?\s*(?:q|Q)[1-4]$/.test(v),
  ).length;
  return dateLike / sample.length >= 0.9;
}

function detectEntityColumns(ds: ParsedDataset, categoricalCols: string[], idCols: string[]): string[] {
  const scored = new Map<string, number>();
  for (const col of [...idCols, ...categoricalCols]) {
    const distinct = sampleDistinctValues(ds, col, 300).length;
    let score = 0;
    if (/(id|code|entity|respondent|household|firm|user|patient|school|region|prefecture|country|state|city)/i.test(col)) score += 4;
    if (distinct >= 5) score += 2;
    if (distinct >= 20) score += 1;
    scored.set(col, score);
  }
  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([col]) => col);
}

function detectTreatmentColumns(ds: ParsedDataset, numericCols: string[], categoricalCols: string[]): string[] {
  const scored = new Map<string, number>();
  for (const col of [...numericCols, ...categoricalCols, ...ds.columns]) {
    const normalized = col.toLowerCase();
    let score = 0;
    if (/(treat|treatment|intervention|policy|program|exposure|assignment|eligible|eligibility|shock|reform|law|mandate|subsidy|grant|random|lottery)/i.test(normalized)) score += 6;
    if (/(post|after|treated|did|difference)/i.test(normalized)) score += 2;
    // Binary coding strengthens a treatment-like name but is not enough on its own
    // (sex, marital status or survey flags are not interventions).
    if (isBinaryLikeColumn(ds, col)) score += score > 0 ? 3 : 1;
    // Variables that look like outcomes should not become treatments merely because they are binary.
    if (/(outcome|target|response|score|rate|risk|income|wage|earnings|salary|price|cost|value|performance|sales|mortality|health|mental|depress|anxiety|stress|wellbeing|happiness|satisfaction|employment|unemployment|hours|productivity|ghq|phq|gad|k6|k10|cesd|who5|sf12|sf36)/i.test(normalized)) score -= 5;
    if (/(id|code|index|year|month|wave|date|time)/i.test(normalized)) score -= 3;
    if (score >= 3) scored.set(col, Math.max(score, scored.get(col) || 0));
  }
  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([col]) => col);
}

function extractTopicKeywords(topic?: string): string[] {
  const stopWords = new Set([
    "about", "across", "after", "analysis", "and", "between", "effect", "effects", "evidence",
    "from", "into", "market", "markets", "method", "methods", "model", "models", "of",
    "on", "paper", "research", "study", "the", "their", "through", "using", "with",
  ]);
  const candidates = [topic || "", ensureAsciiLabelSync(topic || "", "").toLowerCase()];
  const keywords = new Set<string>();
  for (const text of candidates) {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(token => token.length >= 4 && !stopWords.has(token));
    for (const token of tokens) keywords.add(token);
  }
  return Array.from(keywords);
}

function scoreTopicAlignment(columnName: string, topicKeywords: string[]): number {
  if (topicKeywords.length === 0) return 0;
  const normalized = columnName.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  let score = 0;
  for (const keyword of topicKeywords) {
    // A topic word appearing verbatim in the column name is the strongest signal;
    // domain associations (e.g. "mental" -> ghq) are weaker hints.
    if (normalized.includes(keyword)) score += keyword.length >= 7 ? 5 : 3;
    if (keyword.startsWith("mental") && /(mental|depress|anxiety|stress|distress|wellbeing|well being|health|happiness|satisfaction|ghq|phq|gad|k6|k10|cesd|who5|sf12|sf36)/i.test(normalized)) score += 2;
    if (keyword.startsWith("health") && /(health|ghq|phq|gad|k6|k10|cesd|who5|sf12|sf36)/i.test(normalized)) score += 2;
    if (/(labou?r|employment|job|wage|income|earnings|salary|hours|unemployment)/i.test(keyword) && /(employment|job|wage|income|earnings|salary|hours|unemployment|labou?r)/i.test(normalized)) score += 2;
  }
  return score;
}

function detectOutcomeColumns(ds: ParsedDataset, numericCols: string[], topic?: string): string[] {
  const topicKeywords = extractTopicKeywords(topic);
  const scored = new Map<string, number>();
  for (const col of numericCols) {
    let score = 1;
    if (/(outcome|target|response|score|rate|risk|income|wage|price|cost|value|metric|performance|sales|earnings|mortality|health|mental|depress|anxiety|stress|wellbeing|happiness|satisfaction|employment|unemployment|hours|productivity|ghq|phq|gad|k6|k10|cesd|who5|sf12|sf36)/i.test(col)) score += 5;
    if (/(treat|treatment|intervention|policy|program|exposure|assignment|eligible|eligibility|shock|reform|law|mandate|subsidy|grant|random|lottery|post|after|treated|did)/i.test(col)) score -= 6;
    score += scoreTopicAlignment(col, topicKeywords);
    if (/(id|code|index)$/i.test(col)) score -= 2;
    if (/(^age$|_age$|^year$|^month$|^wave$|post|after|dummy|flag|indicator|treated?|control)/i.test(col)) score -= 2;
    if (/(age|gender|sex|male|female|married|education|region|prefecture|country|state|city)/i.test(col)) score -= 1;
    if (isBinaryLikeColumn(ds, col) && !/(outcome|target|response|employment|unemployment|health|disease|mortality)/i.test(col)) score -= 1;
    scored.set(col, score);
  }
  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([col]) => col);
}

function detectInstrumentColumns(ds: ParsedDataset): string[] {
  return ds.columns.filter(c => /(instrument|iv|encouragement|eligib|distance|shiftshare|shock|assignment)/i.test(c));
}

function detectRunningVariableColumns(ds: ParsedDataset, numericCols: string[]): string[] {
  return numericCols.filter(c => /(running|forcing|cutoff|threshold|score|distance|margin|rank)/i.test(c));
}

function inferEconometricDesignHints(
  ds: ParsedDataset,
  numericCols: string[],
  categoricalCols: string[],
  idCols: string[],
  topic?: string,
  analysisInputs?: AnalysisInputs,
): EconometricDesignHints {
  const timeCols = detectTimeColumnsFromDataset(ds);
  const entityCols = detectEntityColumns(ds, categoricalCols, idCols);
  const treatmentCols = detectTreatmentColumns(ds, numericCols, categoricalCols);
  const outcomeCols = detectOutcomeColumns(ds, numericCols, topic);
  const instrumentCols = detectInstrumentColumns(ds);
  const runningCols = detectRunningVariableColumns(ds, numericCols);
  const primaryInstrumentCol = instrumentCols[0];
  const primaryOutcomeCol = outcomeCols.find(col => !treatmentCols.includes(col) && col !== primaryInstrumentCol) || outcomeCols[0] || numericCols[0];
  const primaryTreatmentCol =
    treatmentCols.find(col => col !== primaryOutcomeCol && col !== primaryInstrumentCol) ||
    treatmentCols.find(col => col !== primaryOutcomeCol) ||
    treatmentCols[0];
  const primaryEntityCol = entityCols.find(col => columnRepeatsAcrossRows(ds, col));
  const primaryRegressorCol =
    (primaryTreatmentCol && primaryTreatmentCol !== primaryOutcomeCol ? primaryTreatmentCol : undefined) ||
    chooseFallbackRegressor(ds, numericCols, primaryOutcomeCol, new Set(uniqueDefinedColumns([primaryOutcomeCol, primaryEntityCol, ...timeCols, ...idCols])), topic);

  const merged = mergeAnalysisInputsIntoDesignHints(ds, {
    timeCols,
    entityCols,
    treatmentCols,
    outcomeCols,
    instrumentCols,
    runningCols,
    controlCols: [],
    specifiedInputMatches: [],
    specifiedInputMissing: [],
    primaryTimeCol: timeCols[0],
    primaryEntityCol,
    primaryTreatmentCol,
    primaryOutcomeCol,
    primaryRegressorCol,
    primaryInstrumentCol,
    primaryRunningCol: runningCols[0],
  }, analysisInputs);

  // Without user-specified controls, adjust for a small set of plausible covariates so the
  // headline model is a multivariable specification rather than a bivariate association.
  if (!analysisInputs?.controls || analysisInputs.controls.length === 0) {
    const autoControls = autoSelectControls(ds, numericCols, categoricalCols, idCols, merged, topic);
    if (autoControls.length > 0) {
      merged.controlCols = autoControls;
      merged.controlsAutoSelected = true;
    }
  }
  return merged;
}

/** True when a candidate unit identifier actually repeats (panel / clustered structure). */
function columnRepeatsAcrossRows(ds: ParsedDataset, col: string): boolean {
  const sample = ds.data.slice(0, 20000);
  const seen = new Set<string>();
  let nonMissing = 0;
  for (const row of sample) {
    const key = categoryKey(row[col]);
    if (key === null) continue;
    nonMissing++;
    seen.add(key);
  }
  return nonMissing > 0 && seen.size >= 8 && seen.size <= nonMissing * 0.8;
}

function chooseFallbackRegressor(
  ds: ParsedDataset,
  numericCols: string[],
  outcomeCol: string | undefined,
  exclude: Set<string>,
  topic?: string,
): string | undefined {
  if (!outcomeCol) return undefined;
  const keywords = extractTopicKeywords(topic);
  let best: { col: string; score: number } | undefined;
  for (const col of numericCols) {
    if (col === outcomeCol || exclude.has(col) || isPathologicalNumericColumn(ds, col)) continue;
    if (/(^id$|_id$|id_|code|index|^wave$|^year$|month|date)/i.test(col)) continue;
    const corr = pearsonFromPairs(parseNumericPairs(ds, col, outcomeCol));
    if (!corr) continue;
    // Near-duplicates of the outcome (transformations, components) are not explanatory variables.
    if (Math.abs(corr.r) > 0.95) continue;
    const score = Math.abs(corr.r) + 0.08 * scoreTopicAlignment(col, keywords);
    if (!best || score > best.score) best = { col, score };
  }
  return best?.col;
}

function autoSelectControls(
  ds: ParsedDataset,
  numericCols: string[],
  categoricalCols: string[],
  idCols: string[],
  hints: EconometricDesignHints,
  topic?: string,
): string[] {
  const outcome = hints.primaryOutcomeCol;
  const regressor = hints.primaryRegressorCol;
  if (!outcome || !regressor) return [];
  const blocked = new Set(uniqueDefinedColumns([
    outcome, regressor, hints.primaryEntityCol, hints.primaryTimeCol, hints.primaryInstrumentCol, hints.primaryRunningCol,
    ...hints.timeCols, ...idCols,
  ]));
  const rowCount = Math.max(1, ds.data.length);
  const missingShare = (col: string) => ds.data.reduce((sum, row) => sum + (isMissingValue(row[col]) ? 1 : 0), 0) / rowCount;
  const keywords = extractTopicKeywords(topic);
  const numericCandidates: Array<{ col: string; score: number }> = [];
  for (const col of numericCols) {
    if (blocked.has(col) || isPathologicalNumericColumn(ds, col)) continue;
    if (/(^id$|_id$|code|index)/i.test(col)) continue;
    if (missingShare(col) > 0.3) continue;
    const withRegressor = pearsonFromPairs(parseNumericPairs(ds, col, regressor));
    const withOutcome = pearsonFromPairs(parseNumericPairs(ds, col, outcome));
    if (!withOutcome) continue;
    if (withRegressor && Math.abs(withRegressor.r) > 0.9) continue;
    if (Math.abs(withOutcome.r) > 0.95) continue;
    let score = 1;
    if (/(age|sex|gender|female|male|educ|school|income|earn|wage|size|married|marital|child|household|experience|tenure|urban|rural|region)/i.test(col)) score += 2;
    score += 0.2 * scoreTopicAlignment(col, keywords);
    numericCandidates.push({ col, score });
  }
  const numericPick = numericCandidates.sort((a, b) => b.score - a.score).slice(0, 4).map(item => item.col);
  const categoricalPick: string[] = [];
  for (const col of categoricalCols) {
    if (blocked.has(col) || numericCols.includes(col) || categoricalPick.length >= 2) continue;
    if (averageTextLength(ds, col) > 40 || missingShare(col) > 0.3) continue;
    const levels = categoryCounts(ds, col).size;
    if (levels >= 2 && levels <= 8) categoricalPick.push(col);
  }
  return [...numericPick, ...categoricalPick];
}

function invert2x2(a: number, b: number, c: number, d: number): [number, number, number, number] | null {
  const det = a * d - b * c;
  if (!isFinite(det) || Math.abs(det) < 1e-10) return null;
  return [d / det, -b / det, -c / det, a / det];
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function variance(values: number[], sample = true): number {
  if (values.length <= (sample ? 1 : 0)) return 0;
  const avg = mean(values);
  const denom = sample ? Math.max(1, values.length - 1) : values.length;
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / denom;
}

function stdDev(values: number[], sample = true): number {
  return Math.sqrt(Math.max(variance(values, sample), 0));
}

function weightedMean(values: number[], weights: number[]): number {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!isFinite(totalWeight) || totalWeight <= 0) return mean(values);
  return values.reduce((sum, value, index) => sum + value * weights[index], 0) / totalWeight;
}

function weightedVariance(values: number[], weights: number[]): number {
  const avg = weightedMean(values, weights);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!isFinite(totalWeight) || totalWeight <= 0) return variance(values, false);
  return values.reduce((sum, value, index) => sum + weights[index] * (value - avg) ** 2, 0) / totalWeight;
}

function logisticSigmoid(value: number): number {
  if (value >= 0) {
    const expNeg = Math.exp(-value);
    return 1 / (1 + expNeg);
  }
  const expPos = Math.exp(value);
  return expPos / (1 + expPos);
}

function standardisedMeanDifference(
  treatedValues: number[],
  controlValues: number[],
  treatedWeights?: number[],
  controlWeights?: number[],
): number {
  if (treatedValues.length < 2 || controlValues.length < 2) return 0;
  const meanT = treatedWeights ? weightedMean(treatedValues, treatedWeights) : mean(treatedValues);
  const meanC = controlWeights ? weightedMean(controlValues, controlWeights) : mean(controlValues);
  const varT = treatedWeights ? weightedVariance(treatedValues, treatedWeights) : variance(treatedValues, false);
  const varC = controlWeights ? weightedVariance(controlValues, controlWeights) : variance(controlValues, false);
  const pooled = Math.sqrt(Math.max((varT + varC) / 2, 1e-12));
  return (meanT - meanC) / pooled;
}

function fitSimpleWeightedLine(
  rows: Array<{ x: number; y: number; weight: number }>
): {
  intercept: number;
  slope: number;
  interceptSe: number;
  slopeSe: number;
  fitted: Array<{ x: number; y: number; predicted: number; weight: number }>;
} | null {
  if (rows.length < 10) return null;
  let sw = 0;
  let swx = 0;
  let swxx = 0;
  let swy = 0;
  let swxy = 0;
  for (const row of rows) {
    const w = Math.max(row.weight, 1e-6);
    sw += w;
    swx += w * row.x;
    swxx += w * row.x * row.x;
    swy += w * row.y;
    swxy += w * row.x * row.y;
  }
  const inv = invert2x2(sw, swx, swx, swxx);
  if (!inv) return null;
  const [inv00, inv01, inv10, inv11] = inv;
  const intercept = inv00 * swy + inv01 * swxy;
  const slope = inv10 * swy + inv11 * swxy;

  let weightedResidualSum = 0;
  const fitted: Array<{ x: number; y: number; predicted: number; weight: number }> = [];
  for (const row of rows) {
    const predicted = intercept + slope * row.x;
    weightedResidualSum += row.weight * (row.y - predicted) ** 2;
    fitted.push({ x: row.x, y: row.y, predicted, weight: row.weight });
  }
  const sigma2 = weightedResidualSum / Math.max(1, rows.length - 2);
  const interceptSe = Math.sqrt(Math.max(sigma2 * inv00, 0));
  const slopeSe = Math.sqrt(Math.max(sigma2 * inv11, 0));

  return { intercept, slope, interceptSe, slopeSe, fitted };
}

function fitLogisticPropensityModel(
  rows: Array<{ treatment: number; covariates: number[] }>
): { coefficients: number[]; scores: number[] } | null {
  if (rows.length < 40 || rows[0]?.covariates.length === 0) return null;
  const k = rows[0].covariates.length;
  const means = Array(k).fill(0);
  const stds = Array(k).fill(1);
  for (let j = 0; j < k; j++) {
    const values = rows.map(row => row.covariates[j]);
    means[j] = mean(values);
    stds[j] = stdDev(values, false) || 1;
  }
  const standardized = rows.map(row => ({
    treatment: row.treatment,
    x: row.covariates.map((value, index) => (value - means[index]) / stds[index]),
  }));

  const coefficients = Array(k + 1).fill(0);
  const learningRate = 0.12;
  const penalty = 1e-3;
  for (let iter = 0; iter < 2500; iter++) {
    const gradient = Array(k + 1).fill(0);
    for (const row of standardized) {
      const linearPredictor = coefficients[0] + row.x.reduce((sum, value, index) => sum + value * coefficients[index + 1], 0);
      const score = logisticSigmoid(Math.max(-12, Math.min(12, linearPredictor)));
      const error = row.treatment - score;
      gradient[0] += error;
      for (let j = 0; j < k; j++) {
        gradient[j + 1] += error * row.x[j];
      }
    }
    coefficients[0] += learningRate * gradient[0] / standardized.length;
    for (let j = 0; j < k; j++) {
      coefficients[j + 1] += learningRate * (gradient[j + 1] / standardized.length - penalty * coefficients[j + 1]);
    }
  }

  const scores = standardized.map(row => {
    const linearPredictor = coefficients[0] + row.x.reduce((sum, value, index) => sum + value * coefficients[index + 1], 0);
    return Math.min(0.98, Math.max(0.02, logisticSigmoid(Math.max(-12, Math.min(12, linearPredictor)))));
  });
  const uniqueRoundedScores = new Set(scores.map(score => score.toFixed(3)));
  if (uniqueRoundedScores.size < 5) return null;
  return { coefficients, scores };
}

function computeEmpiricalQuantile(values: number[], tau: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * tau)));
  return sorted[position];
}

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sampleWithReplacement(length: number, drawCount: number, rng: () => number): number[] {
  return Array.from({ length: drawCount }, () => Math.floor(rng() * length));
}

function fitQuantileRegressionModel(
  observations: PreparedRegressionRow[],
  tau: number,
  iterations = 1600,
): { intercept: number; slopes: number[]; pseudoR1: number } | null {
  if (observations.length < 40 || observations[0]?.x.length === 0) return null;
  const predictorCount = observations[0].x.length;
  const xMeans = Array.from({ length: predictorCount }, (_, index) => mean(observations.map(obs => obs.x[index])));
  const xStds = Array.from({ length: predictorCount }, (_, index) => stdDev(observations.map(obs => obs.x[index]), false) || 1);
  const yMean = mean(observations.map(obs => obs.y));
  const yStd = stdDev(observations.map(obs => obs.y), false) || 1;
  const standardized = observations.map(obs => ({
    x: obs.x.map((value, index) => (value - xMeans[index]) / xStds[index]),
    y: (obs.y - yMean) / yStd,
  }));

  let coefficients = [computeEmpiricalQuantile(standardized.map(obs => obs.y), tau), ...Array(predictorCount).fill(0)];
  let step = 0.08;
  const epsilon = 0.05;
  const penalty = 5e-4;
  for (let iter = 0; iter < iterations; iter++) {
    const gradient = Array(coefficients.length).fill(0);
    for (const obs of standardized) {
      const linearPredictor = coefficients[0] + obs.x.reduce((sum, value, index) => sum + value * coefficients[index + 1], 0);
      const residual = obs.y - linearPredictor;
      const smoothIndicator =
        residual <= -epsilon ? 1 :
        residual >= epsilon ? 0 :
        0.5 * (1 - residual / epsilon);
      const psi = tau - smoothIndicator;
      gradient[0] -= psi;
      for (let j = 0; j < predictorCount; j++) {
        gradient[j + 1] -= psi * obs.x[j];
      }
    }
    coefficients[0] -= (step / standardized.length) * gradient[0];
    for (let j = 0; j < predictorCount; j++) {
      coefficients[j + 1] -= (step / standardized.length) * (gradient[j + 1] + penalty * coefficients[j + 1]);
    }
    step *= 0.999;
  }

  const slopesOriginal = coefficients.slice(1).map((value, index) => (yStd * value) / xStds[index]);
  const interceptOriginal = yMean + yStd * coefficients[0] - slopesOriginal.reduce((sum, slope, index) => sum + slope * xMeans[index], 0);

  const rho = (residual: number) => residual >= 0 ? tau * residual : (tau - 1) * residual;
  const objective = observations.reduce((sum, obs) => {
    const predicted = interceptOriginal + obs.x.reduce((acc, value, index) => acc + slopesOriginal[index] * value, 0);
    return sum + rho(obs.y - predicted);
  }, 0);
  const unconditionalQuantile = computeEmpiricalQuantile(observations.map(obs => obs.y), tau);
  const nullObjective = observations.reduce((sum, obs) => sum + rho(obs.y - unconditionalQuantile), 0);
  const pseudoR1 = nullObjective > 0 ? Math.max(0, 1 - objective / nullObjective) : 0;

  if (!isFinite(interceptOriginal) || !slopesOriginal.every(value => isFinite(value))) return null;
  return { intercept: interceptOriginal, slopes: slopesOriginal, pseudoR1 };
}

function computeBootstrapStandardErrors(
  observations: PreparedRegressionRow[],
  tau: number,
  coefficientCount: number,
): { standardErrors: number[]; replicates: number; clusterCount?: number } | null {
  if (observations.length < 40) return null;
  const clusterMap = new Map<string, PreparedRegressionRow[]>();
  for (const row of observations) {
    const key = row.clusterId || "";
    const bucket = clusterMap.get(key) || [];
    bucket.push(row);
    clusterMap.set(key, bucket);
  }
  const clusterKeys = Array.from(clusterMap.keys()).filter(Boolean);
  const useClusterBootstrap = clusterKeys.length >= Math.max(8, observations[0].x.length + 2);
  const targetReplicates = observations.length > 1500 ? 18 : observations.length > 600 ? 24 : 36;
  const minSuccessfulReplicates = Math.max(12, Math.floor(targetReplicates * 0.6));
  const rng = createDeterministicRng(
    Math.round(tau * 1000) * 97 + observations.length * 13 + coefficientCount * 31 + clusterKeys.length * 7
  );

  const bootstrapCoefficients: number[][] = [];
  for (let rep = 0; rep < targetReplicates; rep++) {
    let sampledRows: PreparedRegressionRow[] = [];
    if (useClusterBootstrap) {
      const sampledClusterIndexes = sampleWithReplacement(clusterKeys.length, clusterKeys.length, rng);
      sampledRows = sampledClusterIndexes.flatMap(index => {
        const clusterId = clusterKeys[index];
        return (clusterMap.get(clusterId) || []).map(row => ({ ...row }));
      });
    } else {
      const sampledIndexes = sampleWithReplacement(observations.length, observations.length, rng);
      sampledRows = sampledIndexes.map(index => ({ ...observations[index] }));
    }
    const fit = fitQuantileRegressionModel(sampledRows, tau, 900);
    if (!fit) continue;
    const coefficientVector = [fit.intercept, ...fit.slopes];
    if (coefficientVector.length !== coefficientCount || !coefficientVector.every(value => isFinite(value))) continue;
    bootstrapCoefficients.push(coefficientVector);
  }

  if (bootstrapCoefficients.length < minSuccessfulReplicates) return null;
  const standardErrors = Array.from({ length: coefficientCount }, (_, index) => {
    const values = bootstrapCoefficients.map(row => row[index]);
    return stdDev(values);
  });
  if (!standardErrors.every(value => isFinite(value) && value >= 0)) return null;
  return {
    standardErrors,
    replicates: bootstrapCoefficients.length,
    clusterCount: useClusterBootstrap ? clusterKeys.length : undefined,
  };
}

interface PreparedRegressionRow {
  y: number;
  x: number[];
  clusterId?: string;
}

interface PreparedRegressionData {
  yCol: string;
  primaryRegressorCol: string;
  regressorCols: string[];
  controlCols: string[];
  omittedControlCols: string[];
  missingDataMode: MissingDataMode;
  imputedPredictorCells: number;
  rowsDropped: number;
  clusterCol?: string;
  rows: PreparedRegressionRow[];
}

interface PreparedPanelRegressionRow {
  entity: string;
  time: number;
  y: number;
  x: number[];
  clusterId: string;
}

interface PreparedPanelRegressionData {
  entityCol: string;
  timeCol: string;
  yCol: string;
  primaryRegressorCol: string;
  regressorCols: string[];
  controlCols: string[];
  omittedControlCols: string[];
  missingDataMode: MissingDataMode;
  imputedPredictorCells: number;
  rowsDropped: number;
  rows: PreparedPanelRegressionRow[];
}

interface LinearModelFit {
  coefficients: number[];
  standardErrors: number[];
  tStats: number[];
  pValues: number[];
  ciLower: number[];
  ciUpper: number[];
  fitted: number[];
  residuals: number[];
  r2: number;
  adjR2: number;
  n: number;
  parameterCount: number;
  vcovType: "hc1" | "cluster";
  clusterCount?: number;
}

interface SelectedLinearModelFit {
  fit: LinearModelFit;
  regressorCols: string[];
  droppedCols: string[];
}

function resolveMissingDataMode(analysisInputs?: AnalysisInputs): MissingDataMode {
  if (analysisInputs?.missingDataMode === "mean_imputation") return "mean_imputation";
  if (analysisInputs?.missingDataMode === "complete_case") return "complete_case";
  const notes = `${analysisInputs?.missingDataStrategy || ""}`.toLowerCase();
  if (/(mean imputation|mean-imputation|impute|imputation)/i.test(notes)) return "mean_imputation";
  return "complete_case";
}

function coerceRegressionValue(raw: unknown): number | null {
  if (isMissingValue(raw)) return null;
  const asNumber = Number(raw);
  if (!isNaN(asNumber) && isFinite(asNumber)) return asNumber;
  return parseBinaryValue(raw);
}

function isRegressionCompatibleColumn(ds: ParsedDataset, col: string): boolean {
  const sample = ds.data
    .map(row => row[col])
    .filter(value => !isMissingValue(value))
    .slice(0, 200);
  if (sample.length < 10) return false;
  const coercible = sample.filter(value => coerceRegressionValue(value) !== null).length;
  return coercible / sample.length >= 0.8;
}

function uniqueColumns(columns: Array<string | undefined>): string[] {
  return Array.from(new Set(columns.filter((column): column is string => Boolean(column))));
}

const DUMMY_LEVEL_SEPARATOR = " = ";
const dummySpecsByDataset = new WeakMap<ParsedDataset, Map<string, { source: string; level: string }>>();

/**
 * Expands a categorical column into indicator columns (reference = most frequent level).
 * Returns the synthetic column names, or [] when the column is not a usable categorical.
 */
function expandCategoricalToDummies(ds: ParsedDataset, col: string, maxLevels = 12): string[] {
  const counts = Array.from(categoryCounts(ds, col).entries()).sort((a, b) => b[1] - a[1]);
  if (counts.length < 2 || counts.length > maxLevels) return [];
  const specs = dummySpecsByDataset.get(ds) || new Map<string, { source: string; level: string }>();
  dummySpecsByDataset.set(ds, specs);
  const names: string[] = [];
  for (const [level, count] of counts.slice(1)) {
    if (count < 5) continue;
    const name = `${col}${DUMMY_LEVEL_SEPARATOR}${level}`;
    specs.set(name, { source: col, level });
    names.push(name);
  }
  return names;
}

/** Numeric value of a (possibly synthetic dummy) regressor for one row. */
function regressorValue(ds: ParsedDataset, row: Record<string, any>, column: string): number | null {
  const spec = dummySpecsByDataset.get(ds)?.get(column);
  if (spec) {
    const key = categoryKey(row[spec.source]);
    if (key === null) return null;
    return key === spec.level ? 1 : 0;
  }
  return coerceRegressionValue(row[column]);
}

function resolveModelRegressorColumns(
  ds: ParsedDataset,
  hints: EconometricDesignHints,
): {
  primaryRegressorCol?: string;
  regressorCols: string[];
  controlCols: string[];
  omittedControlCols: string[];
} {
  const yCol = hints.primaryOutcomeCol;
  let primaryRegressorCol = hints.primaryRegressorCol && hints.primaryRegressorCol !== yCol
    ? hints.primaryRegressorCol
    : undefined;
  const extraContrasts: string[] = [];
  if (primaryRegressorCol && !isRegressionCompatibleColumn(ds, primaryRegressorCol)) {
    // Categorical key variable: use indicator contrasts against the most common level.
    const dummies = expandCategoricalToDummies(ds, primaryRegressorCol);
    primaryRegressorCol = dummies[0];
    extraContrasts.push(...dummies.slice(1));
  }
  const candidateControls = uniqueColumns(hints.controlCols)
    .filter(column => column !== yCol && column !== hints.primaryRegressorCol && column !== primaryRegressorCol);
  const controlCols: string[] = [...extraContrasts];
  const omittedControlCols: string[] = [];
  for (const column of candidateControls) {
    if (isRegressionCompatibleColumn(ds, column)) {
      controlCols.push(column);
      continue;
    }
    const dummies = averageTextLength(ds, column) <= 40 ? expandCategoricalToDummies(ds, column) : [];
    if (dummies.length > 0) controlCols.push(...dummies);
    else omittedControlCols.push(column);
  }
  return {
    primaryRegressorCol,
    regressorCols: uniqueColumns([primaryRegressorCol, ...controlCols]),
    controlCols,
    omittedControlCols,
  };
}

function buildPredictorMeans(ds: ParsedDataset, regressorCols: string[]): Map<string, number> {
  const means = new Map<string, number>();
  for (const column of regressorCols) {
    const values = ds.data
      .map(row => regressorValue(ds, row, column))
      .filter((value): value is number => value !== null);
    if (values.length > 0) {
      means.set(column, mean(values));
    }
  }
  return means;
}

function prepareRegressionData(
  ds: ParsedDataset,
  hints: EconometricDesignHints,
  missingDataMode: MissingDataMode,
): PreparedRegressionData | null {
  const yCol = hints.primaryOutcomeCol;
  const clusterCol = hints.primaryEntityCol;
  const { primaryRegressorCol, regressorCols, controlCols, omittedControlCols } = resolveModelRegressorColumns(ds, hints);
  if (!yCol || !primaryRegressorCol || regressorCols.length === 0) return null;

  const predictorMeans = buildPredictorMeans(ds, regressorCols);
  if (!predictorMeans.has(primaryRegressorCol)) return null;

  const rows: PreparedRegressionRow[] = [];
  let imputedPredictorCells = 0;
  let rowsDropped = 0;

  for (const row of ds.data) {
    const y = coerceRegressionValue(row[yCol]);
    if (y === null) {
      rowsDropped++;
      continue;
    }

    const predictors: number[] = [];
    let invalid = false;
    for (const column of regressorCols) {
      let value = regressorValue(ds, row, column);
      if (value === null) {
        if (missingDataMode === "mean_imputation" && predictorMeans.has(column)) {
          value = predictorMeans.get(column)!;
          imputedPredictorCells++;
        } else {
          invalid = true;
          break;
        }
      }
      predictors.push(value);
    }
    if (invalid) {
      rowsDropped++;
      continue;
    }

    const clusterId = clusterCol ? String(row[clusterCol] ?? "").trim() : undefined;
    if (clusterCol && !clusterId) {
      rowsDropped++;
      continue;
    }

    rows.push({ y, x: predictors, clusterId });
  }

  return {
    yCol,
    primaryRegressorCol,
    regressorCols,
    controlCols,
    omittedControlCols,
    missingDataMode,
    imputedPredictorCells,
    rowsDropped,
    clusterCol,
    rows,
  };
}

function preparePanelRegressionData(
  ds: ParsedDataset,
  hints: EconometricDesignHints,
  missingDataMode: MissingDataMode,
): PreparedPanelRegressionData | null {
  const entityCol = hints.primaryEntityCol;
  const timeCol = hints.primaryTimeCol;
  const yCol = hints.primaryOutcomeCol;
  const { primaryRegressorCol, regressorCols, controlCols, omittedControlCols } = resolveModelRegressorColumns(ds, hints);
  if (!entityCol || !timeCol || !yCol || !primaryRegressorCol || regressorCols.length === 0) return null;

  const predictorMeans = buildPredictorMeans(ds, regressorCols);
  if (!predictorMeans.has(primaryRegressorCol)) return null;

  const rows: PreparedPanelRegressionRow[] = [];
  let imputedPredictorCells = 0;
  let rowsDropped = 0;

  for (const row of ds.data) {
    const entity = String(row[entityCol] ?? "").trim();
    const time = parseTimeValue(row[timeCol]);
    const y = coerceRegressionValue(row[yCol]);
    if (!entity || time === null || y === null) {
      rowsDropped++;
      continue;
    }

    const predictors: number[] = [];
    let invalid = false;
    for (const column of regressorCols) {
      let value = regressorValue(ds, row, column);
      if (value === null) {
        if (missingDataMode === "mean_imputation" && predictorMeans.has(column)) {
          value = predictorMeans.get(column)!;
          imputedPredictorCells++;
        } else {
          invalid = true;
          break;
        }
      }
      predictors.push(value);
    }
    if (invalid) {
      rowsDropped++;
      continue;
    }

    rows.push({ entity, time, y, x: predictors, clusterId: entity });
  }

  return {
    entityCol,
    timeCol,
    yCol,
    primaryRegressorCol,
    regressorCols,
    controlCols,
    omittedControlCols,
    missingDataMode,
    imputedPredictorCells,
    rowsDropped,
    rows,
  };
}

function identityMatrix(size: number): number[][] {
  return Array.from({ length: size }, (_, rowIndex) =>
    Array.from({ length: size }, (_, colIndex) => (rowIndex === colIndex ? 1 : 0))
  );
}

function outerProduct(left: number[], right: number[]): number[][] {
  return left.map(lv => right.map(rv => lv * rv));
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
  return matrix.map(row => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

function multiplyMatrices(left: number[][], right: number[][]): number[][] {
  return left.map(row =>
    right[0].map((_, colIndex) =>
      row.reduce((sum, value, rowIndex) => sum + value * right[rowIndex][colIndex], 0)
    )
  );
}

function invertMatrix(matrix: number[][]): number[][] | null {
  const size = matrix.length;
  if (size === 0 || matrix.some(row => row.length !== size)) return null;

  const augmented = matrix.map((row, rowIndex) => [...row, ...identityMatrix(size)[rowIndex]]);
  for (let pivotIndex = 0; pivotIndex < size; pivotIndex++) {
    let bestRow = pivotIndex;
    for (let rowIndex = pivotIndex + 1; rowIndex < size; rowIndex++) {
      if (Math.abs(augmented[rowIndex][pivotIndex]) > Math.abs(augmented[bestRow][pivotIndex])) {
        bestRow = rowIndex;
      }
    }
    if (Math.abs(augmented[bestRow][pivotIndex]) < 1e-10) return null;
    if (bestRow !== pivotIndex) {
      const temp = augmented[pivotIndex];
      augmented[pivotIndex] = augmented[bestRow];
      augmented[bestRow] = temp;
    }

    const pivot = augmented[pivotIndex][pivotIndex];
    for (let colIndex = 0; colIndex < 2 * size; colIndex++) {
      augmented[pivotIndex][colIndex] /= pivot;
    }

    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      if (rowIndex === pivotIndex) continue;
      const factor = augmented[rowIndex][pivotIndex];
      if (Math.abs(factor) < 1e-12) continue;
      for (let colIndex = 0; colIndex < 2 * size; colIndex++) {
        augmented[rowIndex][colIndex] -= factor * augmented[pivotIndex][colIndex];
      }
    }
  }

  return augmented.map(row => row.slice(size));
}

function fitLinearModel(observations: PreparedRegressionRow[]): LinearModelFit | null {
  if (observations.length === 0) return null;
  const predictorCount = observations[0].x.length;
  const parameterCount = predictorCount + 1;
  const n = observations.length;
  if (n <= parameterCount + 1) return null;

  const designRows = observations.map(obs => [1, ...obs.x]);
  const xtx = Array.from({ length: parameterCount }, () => Array(parameterCount).fill(0));
  const xty = Array(parameterCount).fill(0);
  for (let rowIndex = 0; rowIndex < n; rowIndex++) {
    const xRow = designRows[rowIndex];
    const y = observations[rowIndex].y;
    for (let i = 0; i < parameterCount; i++) {
      xty[i] += xRow[i] * y;
      for (let j = 0; j < parameterCount; j++) {
        xtx[i][j] += xRow[i] * xRow[j];
      }
    }
  }

  const xtxInv = invertMatrix(xtx);
  if (!xtxInv) return null;
  const coefficients = multiplyMatrixVector(xtxInv, xty);
  const fitted = designRows.map(row => row.reduce((sum, value, index) => sum + value * coefficients[index], 0));
  const residuals = observations.map((obs, index) => obs.y - fitted[index]);
  const meanY = observations.reduce((sum, obs) => sum + obs.y, 0) / n;
  const ssRes = residuals.reduce((sum, residual) => sum + residual * residual, 0);
  const ssTot = observations.reduce((sum, obs) => sum + (obs.y - meanY) ** 2, 0);
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const adjR2 = n > parameterCount
    ? 1 - (1 - r2) * (n - 1) / Math.max(1, n - parameterCount)
    : r2;

  let meat = Array.from({ length: parameterCount }, () => Array(parameterCount).fill(0));
  let vcovType: "hc1" | "cluster" = "hc1";
  let clusterCount: number | undefined;
  const clusters = new Map<string, number[]>();
  observations.forEach((obs, index) => {
    if (obs.clusterId) {
      const bucket = clusters.get(obs.clusterId) || [];
      bucket.push(index);
      clusters.set(obs.clusterId, bucket);
    }
  });

  if (clusters.size >= Math.max(8, parameterCount + 1)) {
    vcovType = "cluster";
    clusterCount = clusters.size;
    for (const indices of Array.from(clusters.values())) {
      const score = Array(parameterCount).fill(0);
      for (const index of indices) {
        const xRow = designRows[index];
        const residual = residuals[index];
        for (let paramIndex = 0; paramIndex < parameterCount; paramIndex++) {
          score[paramIndex] += xRow[paramIndex] * residual;
        }
      }
      const clusterOuter = outerProduct(score, score);
      meat = meat.map((row, rowIndex) => row.map((value, colIndex) => value + clusterOuter[rowIndex][colIndex]));
    }
  } else {
    for (let index = 0; index < n; index++) {
      const xRow = designRows[index];
      const residual = residuals[index];
      const observationOuter = outerProduct(xRow, xRow).map(row => row.map(value => value * residual * residual));
      meat = meat.map((row, rowIndex) => row.map((value, colIndex) => value + observationOuter[rowIndex][colIndex]));
    }
  }

  const correction = vcovType === "cluster" && clusterCount
    ? (clusterCount / Math.max(1, clusterCount - 1)) * ((n - 1) / Math.max(1, n - parameterCount))
    : n / Math.max(1, n - parameterCount);
  const vcov = multiplyMatrices(multiplyMatrices(xtxInv, meat), xtxInv)
    .map(row => row.map(value => value * correction));
  const standardErrors = vcov.map((row, index) => Math.sqrt(Math.max(row[index], 0)));
  if (!standardErrors.every(se => isFinite(se) && se >= 0)) return null;

  const degreesOfFreedom = vcovType === "cluster" && clusterCount
    ? Math.max(1, clusterCount - 1)
    : Math.max(1, n - parameterCount);
  const tStats = coefficients.map((coefficient, index) => standardErrors[index] > 0 ? coefficient / standardErrors[index] : 0);
  const pValues = tStats.map(tStat => approxTwoTailPValue(tStat, degreesOfFreedom));
  const criticalValue = studentTCritical(degreesOfFreedom);
  const ciLower = coefficients.map((coefficient, index) => coefficient - criticalValue * standardErrors[index]);
  const ciUpper = coefficients.map((coefficient, index) => coefficient + criticalValue * standardErrors[index]);

  return {
    coefficients,
    standardErrors,
    tStats,
    pValues,
    ciLower,
    ciUpper,
    fitted,
    residuals,
    r2,
    adjR2,
    n,
    parameterCount,
    vcovType,
    clusterCount,
  };
}

function fitLinearModelWithSelection(
  rows: PreparedRegressionRow[],
  regressorCols: string[],
): SelectedLinearModelFit | null {
  const activeIndices = regressorCols.map((_, index) => index);
  const droppedCols: string[] = [];

  while (activeIndices.length > 0) {
    const subsetRows = rows.map(row => ({
      y: row.y,
      x: activeIndices.map(index => row.x[index]),
      clusterId: row.clusterId,
    }));
    const fit = fitLinearModel(subsetRows);
    if (fit) {
      return {
        fit,
        regressorCols: activeIndices.map(index => regressorCols[index]),
        droppedCols,
      };
    }
    if (activeIndices.length === 1) break;
    const droppedIndex = activeIndices.pop()!;
    droppedCols.unshift(regressorCols[droppedIndex]);
  }

  return null;
}

function inferRddCutoff(
  rows: Array<{ running: number; treatment: number }>
): { cutoff: number; direction: "right" | "left"; misclassificationRate: number } | null {
  if (rows.length < 40) return null;
  const sorted = [...rows].sort((a, b) => a.running - b.running);
  const candidates: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1].running;
    const right = sorted[i].running;
    if (!isFinite(left) || !isFinite(right) || left === right) continue;
    candidates.push((left + right) / 2);
  }
  if (candidates.length === 0) return null;

  let best: { cutoff: number; direction: "right" | "left"; errors: number } | null = null;
  for (const cutoff of candidates.slice(0, 400)) {
    for (const direction of ["right", "left"] as const) {
      let errors = 0;
      for (const row of rows) {
        const predicted = direction === "right" ? (row.running >= cutoff ? 1 : 0) : (row.running <= cutoff ? 1 : 0);
        if (predicted !== row.treatment) errors++;
      }
      if (!best || errors < best.errors) {
        best = { cutoff, direction, errors };
      }
    }
  }
  if (!best) return null;
  return {
    cutoff: best.cutoff,
    direction: best.direction,
    misclassificationRate: best.errors / rows.length,
  };
}

function countNumericCompleteCaseRows(ds: ParsedDataset, columns: Array<string | undefined>): number {
  const required = columns.filter((column): column is string => Boolean(column));
  if (required.length === 0) return 0;
  let count = 0;
  for (const row of ds.data) {
    const valid = required.every(column => {
      const value = Number(row[column]);
      return !isNaN(value) && isFinite(value);
    });
    if (valid) count++;
  }
  return count;
}

function countDiffInDiffCompleteCaseRows(ds: ParsedDataset, hints: EconometricDesignHints): number {
  const timeCol = hints.primaryTimeCol;
  const treatmentCol = hints.primaryTreatmentCol;
  const outcomeCol = hints.primaryOutcomeCol;
  if (!timeCol || !treatmentCol || !outcomeCol) return 0;
  return ds.data
    .map(row => ({
      timeValue: parseTimeValue(row[timeCol]),
      treatment: parseBinaryValue(row[treatmentCol]),
      outcome: Number(row[outcomeCol]),
    }))
    .filter(row => row.timeValue !== null && row.treatment !== null && !isNaN(row.outcome))
    .length;
}

function assessPanelFixedEffects(
  ds: ParsedDataset,
  hints: EconometricDesignHints,
  missingDataMode: MissingDataMode,
): PanelFixedEffectsAssessment {
  const entityCol = hints.primaryEntityCol;
  const timeCol = hints.primaryTimeCol;
  const yCol = hints.primaryOutcomeCol;
  const xCol = hints.primaryRegressorCol;
  const reasons: string[] = [];

  if (!entityCol) reasons.push("entity column not specified or detected");
  if (!timeCol) reasons.push("time column not specified or detected");
  if (!yCol) reasons.push("outcome column not specified or detected");
  if (!xCol) reasons.push("regressor column not specified or detected");
  if (xCol && yCol && xCol === yCol) reasons.push("outcome and regressor resolve to the same column");

  if (reasons.length > 0) {
    return {
      diagnostics: {
        status: "blocked",
        reason: reasons.join("; "),
        reasons,
        entityCol,
        timeCol,
        xCol,
        yCol,
        completeCaseRows: 0,
        completeCaseEntities: 0,
        completeCasePeriods: 0,
        repeatedEntityCount: 0,
        informativeEntityCountX: 0,
        informativeEntityCountY: 0,
        informativeEntityCountBoth: 0,
        minObsPerEntity: 0,
        medianObsPerEntity: 0,
        maxObsPerEntity: 0,
        transformedRows: 0,
      },
      prepared: null,
      transformed: [],
      transformedPredictorNames: [],
      transformedSsTot: 0,
    };
  }

  const prepared = preparePanelRegressionData(ds, hints, missingDataMode);
  if (!prepared) {
    reasons.push("panel regression data could not be prepared");
    return {
      diagnostics: {
        status: "blocked",
        reason: reasons.join("; "),
        reasons,
        entityCol,
        timeCol,
        xCol,
        yCol,
        completeCaseRows: 0,
        completeCaseEntities: 0,
        completeCasePeriods: 0,
        repeatedEntityCount: 0,
        informativeEntityCountX: 0,
        informativeEntityCountY: 0,
        informativeEntityCountBoth: 0,
        minObsPerEntity: 0,
        medianObsPerEntity: 0,
        maxObsPerEntity: 0,
        transformedRows: 0,
      },
      prepared: null,
      transformed: [],
      transformedPredictorNames: [],
      transformedSsTot: 0,
    };
  }

  const rows = prepared.rows;

  const obsPerEntity = new Map<string, number>();
  const xByEntity = new Map<string, number[]>();
  const yByEntity = new Map<string, number[]>();
  const timeValues = new Set<number>();
  for (const row of rows) {
    obsPerEntity.set(row.entity, (obsPerEntity.get(row.entity) || 0) + 1);
    timeValues.add(row.time);
    const entityX = xByEntity.get(row.entity) || [];
    entityX.push(row.x[0]);
    xByEntity.set(row.entity, entityX);
    const entityY = yByEntity.get(row.entity) || [];
    entityY.push(row.y);
    yByEntity.set(row.entity, entityY);
  }

  const counts = Array.from(obsPerEntity.values()).sort((a, b) => a - b);
  const completeCaseEntities = obsPerEntity.size;
  const completeCasePeriods = timeValues.size;
  const repeatedEntityCount = counts.filter(count => count >= 2).length;
  const informativeEntityCountX = Array.from(xByEntity.values()).filter(values => values.length >= 2 && Math.max(...values) - Math.min(...values) > 1e-10).length;
  const informativeEntityCountY = Array.from(yByEntity.values()).filter(values => values.length >= 2 && Math.max(...values) - Math.min(...values) > 1e-10).length;
  const informativeEntityCountBoth = Array.from(obsPerEntity.keys()).filter(entity => {
    const xValues = xByEntity.get(entity) || [];
    const yValues = yByEntity.get(entity) || [];
    return xValues.length >= 2 && yValues.length >= 2 &&
      Math.max(...xValues) - Math.min(...xValues) > 1e-10 &&
      Math.max(...yValues) - Math.min(...yValues) > 1e-10;
  }).length;

  if (rows.length < 40) reasons.push(`complete-case rows too small (${rows.length} < 40)`);
  if (completeCaseEntities < 8) reasons.push(`too few entities (${completeCaseEntities} < 8)`);
  if (completeCasePeriods < 3) reasons.push(`too few periods (${completeCasePeriods} < 3)`);
  if (repeatedEntityCount < 5) reasons.push(`too few entities with repeated observations (${repeatedEntityCount} < 5)`);
  if (informativeEntityCountBoth < 5) reasons.push(`insufficient within-entity variation (${informativeEntityCountBoth} informative entities < 5)`);

  const predictorCount = prepared.regressorCols.length;
  const entityXMeans = new Map<string, { sum: number[]; count: number }>();
  const entityYMeans = new Map<string, { sum: number; count: number }>();
  const timeXMeans = new Map<number, { sum: number[]; count: number }>();
  const timeYMeans = new Map<number, { sum: number; count: number }>();
  for (const row of rows) {
    const ex = entityXMeans.get(row.entity) || { sum: Array(predictorCount).fill(0), count: 0 };
    for (let index = 0; index < predictorCount; index++) ex.sum[index] += row.x[index];
    ex.count++;
    entityXMeans.set(row.entity, ex);
    const ey = entityYMeans.get(row.entity) || { sum: 0, count: 0 };
    ey.sum += row.y;
    ey.count++;
    entityYMeans.set(row.entity, ey);
    const tx = timeXMeans.get(row.time) || { sum: Array(predictorCount).fill(0), count: 0 };
    for (let index = 0; index < predictorCount; index++) tx.sum[index] += row.x[index];
    tx.count++;
    timeXMeans.set(row.time, tx);
    const ty = timeYMeans.get(row.time) || { sum: 0, count: 0 };
    ty.sum += row.y;
    ty.count++;
    timeYMeans.set(row.time, ty);
  }

  const grandX = Array.from({ length: predictorCount }, (_, index) =>
    rows.length > 0 ? rows.reduce((sum, row) => sum + row.x[index], 0) / rows.length : 0
  );
  const grandY = rows.length > 0 ? rows.reduce((sum, row) => sum + row.y, 0) / rows.length : 0;
  const transformed: Array<{ x: number[]; ydd: number; clusterId: string }> = [];
  let transformedSsTot = 0;
  for (const row of rows) {
    const meanEntityX = entityXMeans.get(row.entity)!.sum.map(value => value / entityXMeans.get(row.entity)!.count);
    const meanEntityY = entityYMeans.get(row.entity)!.sum / entityYMeans.get(row.entity)!.count;
    const meanTimeX = timeXMeans.get(row.time)!.sum.map(value => value / timeXMeans.get(row.time)!.count);
    const meanTimeY = timeYMeans.get(row.time)!.sum / timeYMeans.get(row.time)!.count;
    const transformedX = row.x.map((value, index) => value - meanEntityX[index] - meanTimeX[index] + grandX[index]);
    const ydd = row.y - meanEntityY - meanTimeY + grandY;
    if (!transformedX.every(value => isFinite(value)) || !isFinite(ydd)) continue;
    transformed.push({ x: transformedX, ydd, clusterId: row.clusterId });
    transformedSsTot += ydd * ydd;
  }

  if (transformed.length < 30) reasons.push(`effective transformed observations too small (${transformed.length} < 30)`);
  const primaryVariance = transformed.reduce((sum, row) => sum + row.x[0] * row.x[0], 0);
  if (primaryVariance <= 1e-10) reasons.push("demeaned regressor has no within variation");

  const diagnostics: PanelFixedEffectsDiagnostics = {
    status: reasons.length === 0 ? "passed" : "blocked",
    reason: reasons.join("; "),
    reasons,
    entityCol,
    timeCol,
    xCol,
    yCol,
    completeCaseRows: rows.length,
    completeCaseEntities,
    completeCasePeriods,
    repeatedEntityCount,
    informativeEntityCountX,
    informativeEntityCountY,
    informativeEntityCountBoth,
    minObsPerEntity: counts[0] || 0,
    medianObsPerEntity: counts.length > 0 ? counts[Math.floor(counts.length / 2)] : 0,
    maxObsPerEntity: counts[counts.length - 1] || 0,
    transformedRows: transformed.length,
  };

  return {
    diagnostics,
    prepared,
    transformed,
    transformedPredictorNames: prepared.regressorCols,
    transformedSsTot,
  };
}

function computeRobustOls(
  ds: ParsedDataset,
  hints: EconometricDesignHints,
  missingDataMode: MissingDataMode,
): RobustOlsResult | null {
  const prepared = prepareRegressionData(ds, hints, missingDataMode);
  if (!prepared || prepared.rows.length < 20) return null;

  const selected = fitLinearModelWithSelection(prepared.rows, prepared.regressorCols);
  if (!selected) return null;

  const primaryIndex = selected.regressorCols.findIndex(column => column === prepared.primaryRegressorCol);
  if (primaryIndex < 0) return null;

  const { fit, regressorCols, droppedCols } = selected;
  const coefficientNames = ["intercept", ...regressorCols];
  const coefficients: RegressionCoefficientEstimate[] = coefficientNames.map((name, index) => ({
    name,
    coefficient: fit.coefficients[index],
    se: fit.standardErrors[index],
    tStat: fit.tStats[index],
    pValue: fit.pValues[index],
    ciLower: fit.ciLower[index],
    ciUpper: fit.ciUpper[index],
  }));
  const fittedResiduals = fit.fitted.slice(0, 400).map((fitted, index) => ({
    fitted,
    residual: fit.residuals[index],
  }));

  return {
    xCol: prepared.primaryRegressorCol,
    yCol: prepared.yCol,
    regressorCols,
    controlCols: regressorCols.filter(column => column !== prepared.primaryRegressorCol),
    omittedControlCols: uniqueColumns([...prepared.omittedControlCols, ...droppedCols]),
    droppedCollinearCols: droppedCols,
    intercept: fit.coefficients[0],
    slope: fit.coefficients[primaryIndex + 1],
    seIntercept: fit.standardErrors[0],
    seSlope: fit.standardErrors[primaryIndex + 1],
    tStat: fit.tStats[primaryIndex + 1],
    pValue: fit.pValues[primaryIndex + 1],
    r2: fit.r2,
    adjR2: fit.adjR2,
    n: fit.n,
    ciLower: fit.ciLower[primaryIndex + 1],
    ciUpper: fit.ciUpper[primaryIndex + 1],
    vcovType: fit.vcovType,
    clusterCol: fit.vcovType === "cluster" ? prepared.clusterCol : undefined,
    clusterCount: fit.clusterCount,
    missingDataMode,
    imputedPredictorCells: prepared.imputedPredictorCells,
    coefficients,
    fittedResiduals,
  };
}

function computePanelFixedEffects(
  ds: ParsedDataset,
  hints: EconometricDesignHints,
  missingDataMode: MissingDataMode,
): PanelFixedEffectsResult | null {
  const assessment = assessPanelFixedEffects(ds, hints, missingDataMode);
  if (assessment.diagnostics.status !== "passed") return null;

  const { diagnostics, prepared, transformed, transformedPredictorNames, transformedSsTot: ssTot } = assessment;
  if (!prepared) return null;
  const entityCol = diagnostics.entityCol!;
  const timeCol = diagnostics.timeCol!;
  const xCol = diagnostics.xCol!;
  const yCol = diagnostics.yCol!;
  const selected = fitLinearModelWithSelection(
    transformed.map(row => ({ y: row.ydd, x: row.x, clusterId: row.clusterId })),
    transformedPredictorNames,
  );
  if (!selected) return null;
  const primaryIndex = selected.regressorCols.findIndex(column => column === prepared.primaryRegressorCol);
  if (primaryIndex < 0) return null;

  const coefficientNames = ["intercept", ...selected.regressorCols];
  const coefficients: RegressionCoefficientEstimate[] = coefficientNames.map((name, index) => ({
    name,
    coefficient: selected.fit.coefficients[index],
    se: selected.fit.standardErrors[index],
    tStat: selected.fit.tStats[index],
    pValue: selected.fit.pValues[index],
    ciLower: selected.fit.ciLower[index],
    ciUpper: selected.fit.ciUpper[index],
  }));
  const fittedResiduals = selected.fit.fitted.slice(0, 400).map((fitted, index) => ({
    fitted,
    residual: selected.fit.residuals[index],
  }));
  const ssRes = selected.fit.residuals.reduce((sum, residual) => sum + residual * residual, 0);
  const r2Within = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  return {
    entityCol,
    timeCol,
    xCol,
    yCol,
    regressorCols: selected.regressorCols,
    controlCols: selected.regressorCols.filter(column => column !== prepared.primaryRegressorCol),
    omittedControlCols: uniqueColumns([...prepared.omittedControlCols, ...selected.droppedCols]),
    droppedCollinearCols: selected.droppedCols,
    beta: selected.fit.coefficients[primaryIndex + 1],
    se: selected.fit.standardErrors[primaryIndex + 1],
    tStat: selected.fit.tStats[primaryIndex + 1],
    pValue: selected.fit.pValues[primaryIndex + 1],
    n: selected.fit.n,
    entities: diagnostics.completeCaseEntities,
    periods: diagnostics.completeCasePeriods,
    r2Within,
    vcovType: selected.fit.vcovType,
    clusterCol: selected.fit.vcovType === "cluster" ? prepared.entityCol : undefined,
    clusterCount: selected.fit.clusterCount,
    missingDataMode,
    imputedPredictorCells: prepared.imputedPredictorCells,
    coefficients,
    fittedResiduals,
  };
}

function computeDiffInDiff(ds: ParsedDataset, hints: EconometricDesignHints): DiffInDiffResult | null {
  const timeCol = hints.primaryTimeCol;
  const treatmentCol = hints.primaryTreatmentCol;
  const outcomeCol = hints.primaryOutcomeCol;
  if (!timeCol || !treatmentCol || !outcomeCol) return null;

  const rows = ds.data
    .map(row => ({
      entity: hints.primaryEntityCol ? String(row[hints.primaryEntityCol] ?? "").trim() : "",
      timeValue: parseTimeValue(row[timeCol]),
      timeLabel: String(row[timeCol] ?? ""),
      treatment: parseBinaryValue(row[treatmentCol]),
      outcome: Number(row[outcomeCol]),
    }))
    .filter(row => row.timeValue !== null && row.treatment !== null && !isNaN(row.outcome));
  if (rows.length < 40) return null;

  let treatmentStart = Infinity;
  let treatedEntities = new Set<string>();
  let controlEntities = new Set<string>();

  if (hints.primaryEntityCol) {
    const everTreated = new Map<string, boolean>();
    for (const row of rows) {
      if (!row.entity) continue;
      if (row.treatment === 1) {
        everTreated.set(row.entity, true);
        treatmentStart = Math.min(treatmentStart, row.timeValue!);
      } else if (!everTreated.has(row.entity)) {
        everTreated.set(row.entity, false);
      }
    }
    treatedEntities = new Set(Array.from(everTreated.entries()).filter(([, treated]) => treated).map(([entity]) => entity));
    controlEntities = new Set(Array.from(everTreated.entries()).filter(([, treated]) => !treated).map(([entity]) => entity));
  } else {
    for (const row of rows) {
      if (row.treatment === 1) treatmentStart = Math.min(treatmentStart, row.timeValue!);
    }
  }
  if (!isFinite(treatmentStart)) return null;

  const treatedPre: number[] = [];
  const treatedPost: number[] = [];
  const controlPre: number[] = [];
  const controlPost: number[] = [];
  const treatedByTime = new Map<number, { sum: number; count: number; label: string }>();
  const controlByTime = new Map<number, { sum: number; count: number; label: string }>();

  for (const row of rows) {
    const isTreatedGroup = hints.primaryEntityCol
      ? treatedEntities.has(row.entity)
      : row.treatment === 1;
    const isControlGroup = hints.primaryEntityCol
      ? controlEntities.has(row.entity)
      : row.treatment === 0;
    if (!isTreatedGroup && !isControlGroup) continue;
    const isPost = row.timeValue! >= treatmentStart;

    if (isTreatedGroup) {
      (isPost ? treatedPost : treatedPre).push(row.outcome);
      const current = treatedByTime.get(row.timeValue!) || { sum: 0, count: 0, label: row.timeLabel };
      current.sum += row.outcome;
      current.count++;
      treatedByTime.set(row.timeValue!, current);
    } else if (isControlGroup) {
      (isPost ? controlPost : controlPre).push(row.outcome);
      const current = controlByTime.get(row.timeValue!) || { sum: 0, count: 0, label: row.timeLabel };
      current.sum += row.outcome;
      current.count++;
      controlByTime.set(row.timeValue!, current);
    }
  }

  if (treatedPre.length < 5 || treatedPost.length < 5 || controlPre.length < 5 || controlPost.length < 5) return null;

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const treatedPreMean = mean(treatedPre);
  const treatedPostMean = mean(treatedPost);
  const controlPreMean = mean(controlPre);
  const controlPostMean = mean(controlPost);
  const estimate = (treatedPostMean - treatedPreMean) - (controlPostMean - controlPreMean);

  const commonTimes = Array.from(treatedByTime.keys())
    .filter(time => controlByTime.has(time))
    .sort((a, b) => a - b);
  if (commonTimes.length < 4) return null;

  const startIndex = commonTimes.findIndex(time => time >= treatmentStart);
  const baselineIndex = Math.max(0, startIndex - 1);
  const baselineTime = commonTimes[baselineIndex];
  const baselineDiff =
    treatedByTime.get(baselineTime)!.sum / treatedByTime.get(baselineTime)!.count -
    controlByTime.get(baselineTime)!.sum / controlByTime.get(baselineTime)!.count;
  const firstPreTime = commonTimes[0];
  const firstPreDiff =
    treatedByTime.get(firstPreTime)!.sum / treatedByTime.get(firstPreTime)!.count -
    controlByTime.get(firstPreTime)!.sum / controlByTime.get(firstPreTime)!.count;

  const series = commonTimes.map((time, index) => {
    const treatedMean = treatedByTime.get(time)!.sum / treatedByTime.get(time)!.count;
    const controlMean = controlByTime.get(time)!.sum / controlByTime.get(time)!.count;
    return {
      label: treatedByTime.get(time)?.label || controlByTime.get(time)?.label || String(time),
      timeValue: time,
      relIndex: index - startIndex,
      treatedMean,
      controlMean,
      effect: (treatedMean - controlMean) - baselineDiff,
    };
  });

  return {
    timeCol,
    entityCol: hints.primaryEntityCol,
    treatmentCol,
    outcomeCol,
    treatmentStart,
    estimate,
    treatedPre: treatedPreMean,
    treatedPost: treatedPostMean,
    controlPre: controlPreMean,
    controlPost: controlPostMean,
    n: treatedPre.length + treatedPost.length + controlPre.length + controlPost.length,
    preTrendDelta: baselineDiff - firstPreDiff,
    series,
  };
}

function projectOntoSimplex(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => b - a);
  let cumulative = 0;
  let rho = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i];
    const theta = (cumulative - 1) / (i + 1);
    if (sorted[i] - theta > 0) {
      rho = i + 1;
    }
  }
  const theta = (sorted.slice(0, rho).reduce((sum, value) => sum + value, 0) - 1) / Math.max(1, rho);
  return values.map(value => Math.max(value - theta, 0));
}

function fitSyntheticControlWeights(donorSeries: number[][], treatedSeries: number[]): number[] {
  const donorCount = donorSeries.length;
  if (donorCount === 0) return [];
  let weights = Array(donorCount).fill(1 / donorCount);
  const maxNorm = Math.max(
    1,
    ...donorSeries.map(series => series.reduce((sum, value) => sum + value * value, 0))
  );
  const learningRate = 0.2 / maxNorm;

  for (let iter = 0; iter < 800; iter++) {
    const prediction = treatedSeries.map((_, timeIndex) =>
      donorSeries.reduce((sum, series, donorIndex) => sum + weights[donorIndex] * series[timeIndex], 0)
    );
    const gradient = donorSeries.map(series =>
      2 * series.reduce((sum, value, timeIndex) => sum + value * (prediction[timeIndex] - treatedSeries[timeIndex]), 0)
    );
    const next = projectOntoSimplex(weights.map((weight, index) => weight - learningRate * gradient[index]));
    const maxDelta = Math.max(...next.map((value, index) => Math.abs(value - weights[index])));
    weights = next;
    if (maxDelta < 1e-8) break;
  }

  return weights;
}

function buildSyntheticControlPanelData(ds: ParsedDataset, hints: EconometricDesignHints): {
  entityCol: string;
  timeCol: string;
  treatmentCol: string;
  outcomeCol: string;
  treatedCandidates: Array<[string, number]>;
  donorUnits: string[];
  outcomeByEntityTime: Map<string, Map<number, { sum: number; count: number; label: string }>>;
} | null {
  const entityCol = hints.primaryEntityCol;
  const timeCol = hints.primaryTimeCol;
  const treatmentCol = hints.primaryTreatmentCol;
  const outcomeCol = hints.primaryOutcomeCol;
  if (!entityCol || !timeCol || !treatmentCol || !outcomeCol) return null;

  const rows = ds.data
    .map(row => ({
      entity: String(row[entityCol] ?? "").trim(),
      timeValue: parseTimeValue(row[timeCol]),
      timeLabel: String(row[timeCol] ?? ""),
      treatment: parseBinaryValue(row[treatmentCol]),
      outcome: Number(row[outcomeCol]),
    }))
    .filter(row => row.entity && row.timeValue !== null && row.treatment !== null && !isNaN(row.outcome));
  if (rows.length < 60) return null;

  const firstTreatmentByEntity = new Map<string, number>();
  const outcomeByEntityTime = new Map<string, Map<number, { sum: number; count: number; label: string }>>();
  for (const row of rows) {
    if (row.treatment === 1) {
      firstTreatmentByEntity.set(
        row.entity,
        Math.min(firstTreatmentByEntity.get(row.entity) ?? Infinity, row.timeValue!)
      );
    }
    const entityMap = outcomeByEntityTime.get(row.entity) || new Map<number, { sum: number; count: number; label: string }>();
    const current = entityMap.get(row.timeValue!) || { sum: 0, count: 0, label: row.timeLabel };
    current.sum += row.outcome;
    current.count++;
    entityMap.set(row.timeValue!, current);
    outcomeByEntityTime.set(row.entity, entityMap);
  }

  const treatedCandidates = Array.from(firstTreatmentByEntity.entries()).sort((a, b) => a[1] - b[1]);
  const donorUnits = Array.from(outcomeByEntityTime.keys()).filter(entity => !firstTreatmentByEntity.has(entity));
  if (treatedCandidates.length === 0 || donorUnits.length < 2) return null;

  return {
    entityCol,
    timeCol,
    treatmentCol,
    outcomeCol,
    treatedCandidates,
    donorUnits,
    outcomeByEntityTime,
  };
}

function computeSyntheticControlForUnit(
  panel: NonNullable<ReturnType<typeof buildSyntheticControlPanelData>>,
  treatedUnit: string,
  treatmentStart: number,
  donorPool: string[],
): SyntheticControlResult | null {
  const treatedMap = panel.outcomeByEntityTime.get(treatedUnit);
  if (!treatedMap || donorPool.length < 2) return null;
  const preTimes = Array.from(treatedMap.keys()).filter(time => time < treatmentStart).sort((a, b) => a - b);
  if (preTimes.length < 4) return null;

  const donorDistances = donorPool
    .map(entity => {
      const donorMap = panel.outcomeByEntityTime.get(entity);
      if (!donorMap) return null;
      const overlappingPreTimes = preTimes.filter(time => donorMap.has(time));
      if (overlappingPreTimes.length < 4) return null;
      const distance = overlappingPreTimes.reduce((sum, time) => {
        const treatedMean = treatedMap.get(time)!.sum / treatedMap.get(time)!.count;
        const donorMean = donorMap.get(time)!.sum / donorMap.get(time)!.count;
        return sum + (treatedMean - donorMean) ** 2;
      }, 0) / overlappingPreTimes.length;
      return { entity, distance };
    })
    .filter((item): item is { entity: string; distance: number } => item !== null)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8);
  if (donorDistances.length < 2) return null;

  const selectedDonors = donorDistances.map(item => item.entity);
  const commonPreTimes = preTimes.filter(time =>
    selectedDonors.every(entity => panel.outcomeByEntityTime.get(entity)?.has(time))
  );
  if (commonPreTimes.length < 4) return null;

  const donorSeries = selectedDonors.map(entity =>
    commonPreTimes.map(time => {
      const point = panel.outcomeByEntityTime.get(entity)!.get(time)!;
      return point.sum / point.count;
    })
  );
  const treatedSeries = commonPreTimes.map(time => {
    const point = treatedMap.get(time)!;
    return point.sum / point.count;
  });
  const weights = fitSyntheticControlWeights(donorSeries, treatedSeries);
  if (weights.length !== selectedDonors.length) return null;

  const usableTimes = Array.from(treatedMap.keys())
    .filter(time => selectedDonors.every(entity => panel.outcomeByEntityTime.get(entity)?.has(time)))
    .sort((a, b) => a - b);
  if (usableTimes.length < 6) return null;

  const startIndex = usableTimes.findIndex(value => value >= treatmentStart);
  if (startIndex < 0) return null;
  const series = usableTimes.map((time, index) => {
    const treated = treatedMap.get(time)!.sum / treatedMap.get(time)!.count;
    const synthetic = selectedDonors.reduce((sum, entity, donorIndex) => {
      const point = panel.outcomeByEntityTime.get(entity)!.get(time)!;
      return sum + weights[donorIndex] * (point.sum / point.count);
    }, 0);
    const label = treatedMap.get(time)?.label || String(time);
    return {
      label,
      timeValue: time,
      relIndex: index - startIndex,
      treated,
      synthetic,
      gap: treated - synthetic,
    };
  });

  const preSeries = series.filter(point => point.timeValue < treatmentStart);
  const postSeries = series.filter(point => point.timeValue >= treatmentStart);
  if (preSeries.length < 4 || postSeries.length < 2) return null;

  const rmse = (items: Array<{ gap: number }>) => Math.sqrt(items.reduce((sum, item) => sum + item.gap ** 2, 0) / items.length);
  const preRmse = rmse(preSeries);
  const postRmse = rmse(postSeries);
  const attPostMean = postSeries.reduce((sum, item) => sum + item.gap, 0) / postSeries.length;

  return {
    entityCol: panel.entityCol,
    timeCol: panel.timeCol,
    outcomeCol: panel.outcomeCol,
    treatmentCol: panel.treatmentCol,
    treatedUnit,
    treatmentStart,
    donorCount: selectedDonors.length,
    preRmse,
    postRmse,
    attPostMean,
    weights: selectedDonors.map((unit, index) => ({ unit, weight: weights[index] }))
      .sort((a, b) => b.weight - a.weight),
    series,
  };
}

function computeSyntheticControl(ds: ParsedDataset, hints: EconometricDesignHints): SyntheticControlResult | null {
  const panel = buildSyntheticControlPanelData(ds, hints);
  if (!panel) return null;
  const [treatedUnit, treatmentStart] = panel.treatedCandidates[0];
  return computeSyntheticControlForUnit(panel, treatedUnit, treatmentStart, panel.donorUnits);
}

function computeSyntheticControlPlacebos(
  ds: ParsedDataset,
  hints: EconometricDesignHints,
  actualResult?: SyntheticControlResult | null,
): SyntheticControlPlaceboResult | null {
  const panel = buildSyntheticControlPanelData(ds, hints);
  const actual = actualResult || computeSyntheticControl(ds, hints);
  if (!panel || !actual || actual.preRmse <= 1e-9) return null;

  const ratios: SyntheticControlPlaceboResult["ratios"] = [{
    unit: actual.treatedUnit,
    ratio: actual.postRmse / actual.preRmse,
    preRmse: actual.preRmse,
    postRmse: actual.postRmse,
    isActual: true,
  }];

  for (const donorUnit of panel.donorUnits.slice(0, 8)) {
    const donorPool = panel.donorUnits.filter(unit => unit !== donorUnit);
    const placebo = computeSyntheticControlForUnit(panel, donorUnit, actual.treatmentStart, donorPool);
    if (!placebo || placebo.preRmse <= 1e-9) continue;
    ratios.push({
      unit: donorUnit,
      ratio: placebo.postRmse / placebo.preRmse,
      preRmse: placebo.preRmse,
      postRmse: placebo.postRmse,
      isActual: false,
    });
  }

  if (ratios.length < 3) return null;
  const sorted = [...ratios].sort((a, b) => b.ratio - a.ratio);
  const actualRank = sorted.findIndex(item => item.isActual) + 1;
  return {
    treatedUnit: actual.treatedUnit,
    treatmentStart: actual.treatmentStart,
    actualRatio: actual.postRmse / actual.preRmse,
    ratios: sorted,
    actualRank,
  };
}

function computeIv2Sls(ds: ParsedDataset, hints: EconometricDesignHints): Iv2SlsResult | null {
  const zCol = hints.primaryInstrumentCol;
  const xCol = hints.primaryTreatmentCol || hints.primaryRegressorCol;
  const yCol = hints.primaryOutcomeCol;
  if (!zCol || !xCol || !yCol || zCol === xCol || zCol === yCol || xCol === yCol) return null;

  const observations = ds.data
    .map(row => ({
      z: Number(row[zCol]),
      x: Number(row[xCol]),
      y: Number(row[yCol]),
    }))
    .filter(obs => !isNaN(obs.z) && !isNaN(obs.x) && !isNaN(obs.y) && isFinite(obs.z) && isFinite(obs.x) && isFinite(obs.y));
  if (observations.length < 60) return null;

  const firstStagePairs: [number, number][] = observations.map(obs => [obs.z, obs.x]);
  const reducedFormPairs: [number, number][] = observations.map(obs => [obs.z, obs.y]);
  const firstStage = regressionStatsFromPairs(firstStagePairs);
  const reducedForm = regressionStatsFromPairs(reducedFormPairs);
  if (!firstStage || !reducedForm) return null;

  const zValues = observations.map(obs => obs.z);
  const meanZ = mean(zValues);
  const ssZ = zValues.reduce((sum, value) => sum + (value - meanZ) ** 2, 0);
  if (ssZ <= 1e-10) return null;

  const firstStageResiduals = observations.map(obs => obs.x - (firstStage.intercept + firstStage.slope * obs.z));
  const firstStageMse = firstStageResiduals.reduce((sum, residual) => sum + residual ** 2, 0) / Math.max(1, observations.length - 2);
  const firstStageSe = Math.sqrt(firstStageMse / ssZ);
  if (!isFinite(firstStageSe) || firstStageSe <= 0) return null;
  const firstStageT = firstStage.slope / firstStageSe;
  const firstStagePValue = approxTwoTailPValue(firstStageT, observations.length - 2);
  const firstStageF = firstStageT ** 2;

  const fittedTreatment = observations.map(obs => firstStage.intercept + firstStage.slope * obs.z);
  const secondStagePairs: [number, number][] = observations.map((obs, index) => [fittedTreatment[index], obs.y]);
  const secondStage = regressionStatsFromPairs(secondStagePairs);
  if (!secondStage) return null;
  const meanDHat = mean(fittedTreatment);
  const ssDhat = fittedTreatment.reduce((sum, value) => sum + (value - meanDHat) ** 2, 0);
  if (ssDhat <= 1e-10) return null;
  const secondStageResiduals = observations.map((obs, index) => obs.y - (secondStage.intercept + secondStage.slope * fittedTreatment[index]));
  const secondStageMse = secondStageResiduals.reduce((sum, residual) => sum + residual ** 2, 0) / Math.max(1, observations.length - 2);
  const secondStageSe = Math.sqrt(secondStageMse / ssDhat);
  if (!isFinite(secondStageSe) || secondStageSe <= 0) return null;

  const tStat = secondStage.slope / secondStageSe;
  const pValue = approxTwoTailPValue(tStat, observations.length - 2);
  return {
    zCol,
    xCol,
    yCol,
    beta: secondStage.slope,
    se: secondStageSe,
    tStat,
    pValue,
    ciLower: secondStage.slope - 1.96 * secondStageSe,
    ciUpper: secondStage.slope + 1.96 * secondStageSe,
    n: observations.length,
    firstStageSlope: firstStage.slope,
    firstStageSe,
    firstStageF,
    firstStagePValue,
    reducedFormSlope: reducedForm.slope,
    firstStagePoints: observations.slice(0, 300).map(obs => ({ x: obs.z, y: obs.x })),
  };
}

function computeRegressionDiscontinuity(ds: ParsedDataset, hints: EconometricDesignHints): RddResult | null {
  const runningCol = hints.primaryRunningCol;
  const treatmentCol = hints.primaryTreatmentCol;
  const outcomeCol = hints.primaryOutcomeCol;
  if (!runningCol || !treatmentCol || !outcomeCol) return null;

  const rows = ds.data
    .map(row => ({
      running: Number(row[runningCol]),
      treatment: parseBinaryValue(row[treatmentCol]),
      outcome: Number(row[outcomeCol]),
    }))
    .filter(row => !isNaN(row.running) && row.treatment !== null && !isNaN(row.outcome));
  if (rows.length < 80) return null;

  const cutoffInfo = inferRddCutoff(rows.map(row => ({ running: row.running, treatment: row.treatment! })));
  if (!cutoffInfo || cutoffInfo.misclassificationRate > 0.35) return null;

  const centeredRows = rows.map(row => ({
    x: row.running - cutoffInfo.cutoff,
    running: row.running,
    treatment: row.treatment!,
    outcome: row.outcome,
  }));
  const absDistances = centeredRows.map(row => Math.abs(row.x)).sort((a, b) => a - b);
  const bandwidth = absDistances[Math.min(absDistances.length - 1, Math.max(40, Math.floor(absDistances.length * 0.35)))] || absDistances[absDistances.length - 1];
  if (!isFinite(bandwidth) || bandwidth <= 0) return null;

  const local = centeredRows.filter(row => Math.abs(row.x) <= bandwidth);
  const leftRows = local
    .filter(row => row.x < 0)
    .map(row => ({ x: row.x, y: row.outcome, weight: Math.max(0.05, 1 - Math.abs(row.x) / bandwidth), running: row.running }));
  const rightRows = local
    .filter(row => row.x >= 0)
    .map(row => ({ x: row.x, y: row.outcome, weight: Math.max(0.05, 1 - Math.abs(row.x) / bandwidth), running: row.running }));
  if (leftRows.length < 20 || rightRows.length < 20) return null;

  const leftFit = fitSimpleWeightedLine(leftRows);
  const rightFit = fitSimpleWeightedLine(rightRows);
  if (!leftFit || !rightFit) return null;

  const estimate = cutoffInfo.direction === "right"
    ? rightFit.intercept - leftFit.intercept
    : leftFit.intercept - rightFit.intercept;
  const se = Math.sqrt(leftFit.interceptSe ** 2 + rightFit.interceptSe ** 2);
  if (!isFinite(se) || se <= 0) return null;
  const tStat = estimate / se;
  const pValue = approxTwoTailPValue(tStat, leftRows.length + rightRows.length - 4);

  const makeBins = (subset: typeof local, side: "left" | "right") => {
    const ordered = [...subset].sort((a, b) => a.running - b.running);
    const binSize = Math.max(6, Math.ceil(ordered.length / 6));
    const bins: RddResult["bins"] = [];
    for (let start = 0; start < ordered.length; start += binSize) {
      const chunk = ordered.slice(start, start + binSize);
      if (chunk.length === 0) continue;
      bins.push({
        x: mean(chunk.map(row => row.running)),
        y: mean(chunk.map(row => row.outcome)),
        side,
        count: chunk.length,
      });
    }
    return bins;
  };

  const leftMin = Math.min(...leftRows.map(row => row.x));
  const rightMax = Math.max(...rightRows.map(row => row.x));
  return {
    runningCol,
    treatmentCol,
    outcomeCol,
    cutoff: cutoffInfo.cutoff,
    bandwidth,
    estimate,
    se,
    tStat,
    pValue,
    nLocal: local.length,
    leftN: leftRows.length,
    rightN: rightRows.length,
    leftSlope: leftFit.slope,
    rightSlope: rightFit.slope,
    bins: [
      ...makeBins(local.filter(row => row.x < 0), "left"),
      ...makeBins(local.filter(row => row.x >= 0), "right"),
    ],
    fitLine: [
      { x: cutoffInfo.cutoff + leftMin, y: leftFit.intercept + leftFit.slope * leftMin, side: "left" },
      { x: cutoffInfo.cutoff, y: leftFit.intercept, side: "left" },
      { x: cutoffInfo.cutoff, y: rightFit.intercept, side: "right" },
      { x: cutoffInfo.cutoff + rightMax, y: rightFit.intercept + rightFit.slope * rightMax, side: "right" },
    ],
  };
}

function computePropensityScore(ds: ParsedDataset, hints: EconometricDesignHints): PropensityScoreResult | null {
  const treatmentCol = hints.primaryTreatmentCol;
  const outcomeCol = hints.primaryOutcomeCol;
  if (!treatmentCol || !outcomeCol) return null;

  const { numericCols, idCols } = classifyColumns(ds.data, ds.columns);
  const covariates = numericCols
    .filter(col => !idCols.includes(col))
    .filter(col => col !== treatmentCol && col !== outcomeCol && col !== hints.primaryInstrumentCol && col !== hints.primaryRunningCol)
    .slice(0, 5);
  if (covariates.length < 2) return null;

  const rows = ds.data
    .map(row => ({
      treatment: parseBinaryValue(row[treatmentCol]),
      outcome: Number(row[outcomeCol]),
      covariates: covariates.map(col => Number(row[col])),
    }))
    .filter(row => row.treatment !== null && !isNaN(row.outcome) && row.covariates.every(value => !isNaN(value) && isFinite(value)));
  if (rows.length < 80) return null;

  const model = fitLogisticPropensityModel(rows.map(row => ({ treatment: row.treatment!, covariates: row.covariates })));
  if (!model) return null;

  const scoreRows = rows.map((row, index) => ({
    score: model.scores[index],
    treatment: row.treatment!,
    outcome: row.outcome,
    covariates: row.covariates,
  }));
  const treated = scoreRows.filter(row => row.treatment === 1);
  const control = scoreRows.filter(row => row.treatment === 0);
  if (treated.length < 15 || control.length < 15) return null;

  const contributions = scoreRows.map(row =>
    row.treatment === 1 ? row.outcome / row.score : -row.outcome / (1 - row.score)
  );
  const ate = mean(contributions);
  const se = stdDev(contributions) / Math.sqrt(scoreRows.length);
  if (!isFinite(se) || se <= 0) return null;
  const tStat = ate / se;
  const pValue = approxTwoTailPValue(tStat, scoreRows.length - 1);

  const treatedWeights = treated.map(row => 1 / row.score);
  const controlWeights = control.map(row => 1 / (1 - row.score));
  const balance = covariates.map((covariate, index) => {
    const treatedValues = treated.map(row => row.covariates[index]);
    const controlValues = control.map(row => row.covariates[index]);
    return {
      covariate,
      smdBefore: standardisedMeanDifference(treatedValues, controlValues),
      smdAfter: standardisedMeanDifference(treatedValues, controlValues, treatedWeights, controlWeights),
      meanTreated: mean(treatedValues),
      meanControl: mean(controlValues),
      weightedTreated: weightedMean(treatedValues, treatedWeights),
      weightedControl: weightedMean(controlValues, controlWeights),
    };
  });

  const treatedScores = treated.map(row => row.score);
  const controlScores = control.map(row => row.score);
  return {
    treatmentCol,
    outcomeCol,
    covariates,
    ate,
    se,
    tStat,
    pValue,
    ciLower: ate - 1.96 * se,
    ciUpper: ate + 1.96 * se,
    n: scoreRows.length,
    meanScoreTreated: mean(treatedScores),
    meanScoreControl: mean(controlScores),
    overlapMin: Math.max(Math.min(...treatedScores), Math.min(...controlScores)),
    overlapMax: Math.min(Math.max(...treatedScores), Math.max(...controlScores)),
    balance,
    scoreRows: scoreRows.map(row => ({ score: row.score, treatment: row.treatment })),
  };
}

function computeQuantileRegression(
  ds: ParsedDataset,
  hints: EconometricDesignHints,
  missingDataMode: MissingDataMode,
): QuantileRegressionResult | null {
  const prepared = prepareRegressionData(ds, hints, missingDataMode);
  if (!prepared || prepared.rows.length < 80) return null;

  const variances = prepared.regressorCols.map((_, index) =>
    variance(prepared.rows.map(row => row.x[index]), false)
  );
  const activeIndexes = prepared.regressorCols
    .map((column, index) => ({ column, index }))
    .filter(item => variances[item.index] > 1e-10)
    .map(item => item.index);
  const primaryActiveIndex = prepared.regressorCols.findIndex(column => column === prepared.primaryRegressorCol);
  if (primaryActiveIndex < 0 || !activeIndexes.includes(primaryActiveIndex)) return null;

  const activeRows = prepared.rows.map(row => ({
    y: row.y,
    x: activeIndexes.map(index => row.x[index]),
    clusterId: row.clusterId,
  }));
  const activeRegressorCols = activeIndexes.map(index => prepared.regressorCols[index]);
  const droppedCollinearCols = prepared.regressorCols.filter((_, index) => !activeIndexes.includes(index));

  const estimates = [0.25, 0.5, 0.75]
    .map(tau => {
      const fit = fitQuantileRegressionModel(activeRows, tau);
      if (!fit) return null;
      const bootstrap = computeBootstrapStandardErrors(activeRows, tau, activeRegressorCols.length + 1);
      if (!bootstrap) return null;
      const primaryIndex = activeRegressorCols.findIndex(column => column === prepared.primaryRegressorCol);
      if (primaryIndex < 0) return null;
      const coefficientVector = [fit.intercept, ...fit.slopes];
      const degreesOfFreedom = bootstrap.clusterCount
        ? Math.max(1, bootstrap.clusterCount - 1)
        : Math.max(1, activeRows.length - activeRegressorCols.length - 1);
      const coefficients: RegressionCoefficientEstimate[] = ["intercept", ...activeRegressorCols].map((name, index) => {
        const se = bootstrap.standardErrors[index];
        const tStat = se > 0 ? coefficientVector[index] / se : 0;
        const pValue = approxTwoTailPValue(tStat, degreesOfFreedom);
        return {
          name,
          coefficient: coefficientVector[index],
          se,
          tStat,
          pValue,
          ciLower: coefficientVector[index] - 1.96 * se,
          ciUpper: coefficientVector[index] + 1.96 * se,
        };
      });
      const primaryEstimate = coefficients[primaryIndex + 1];
      return {
        tau,
        intercept: fit.intercept,
        slope: fit.slopes[primaryIndex],
        interceptSe: coefficients[0].se,
        slopeSe: primaryEstimate.se,
        tStat: primaryEstimate.tStat,
        pValue: primaryEstimate.pValue,
        ciLower: primaryEstimate.ciLower,
        ciUpper: primaryEstimate.ciUpper,
        pseudoR1: fit.pseudoR1,
        coefficients,
        bootstrapReplicates: bootstrap.replicates,
      };
    })
    .filter((item): item is QuantileRegressionEstimate => item !== null);
  if (estimates.length < 3) return null;

  const clusterIds = Array.from(new Set(activeRows.map(row => row.clusterId).filter((value): value is string => Boolean(value))));
  return {
    xCol: prepared.primaryRegressorCol,
    yCol: prepared.yCol,
    regressorCols: activeRegressorCols,
    controlCols: activeRegressorCols.filter(column => column !== prepared.primaryRegressorCol),
    omittedControlCols: uniqueColumns([...prepared.omittedControlCols, ...droppedCollinearCols]),
    droppedCollinearCols,
    n: activeRows.length,
    vcovType: "bootstrap",
    clusterCol: clusterIds.length >= Math.max(8, activeRegressorCols.length + 1) ? prepared.clusterCol : undefined,
    clusterCount: clusterIds.length >= Math.max(8, activeRegressorCols.length + 1) ? clusterIds.length : undefined,
    missingDataMode,
    imputedPredictorCells: prepared.imputedPredictorCells,
    estimates,
  };
}

function detectTextColumns(ds: ParsedDataset): string[] {
  const textCols: string[] = [];
  for (const col of ds.columns) {
    const sample = ds.data.slice(0, 300).map(r => r[col]).filter(v => v !== null && v !== undefined && v !== "");
    if (sample.length < 20) continue;
    const stringVals = sample.filter(v => typeof v === "string") as string[];
    if (stringVals.length / sample.length < 0.6) continue;
    const avgLen = stringVals.reduce((a, s) => a + s.length, 0) / stringVals.length;
    const nameHintsText = /(text|comment|abstract|title|description|review|note|content|summary)/i.test(col);
    if (avgLen >= 20 || nameHintsText) textCols.push(col);
  }
  return textCols;
}

type MethodApplicabilityStatus = "executable_now" | "partially_ready" | "blocked";

interface MethodApplicabilityAssessment {
  methodId: string;
  label: string;
  status: MethodApplicabilityStatus;
  readinessScore: number;
  evidence: string;
  notes: string;
}

interface AnalysisComputationBundle {
  ds: ParsedDataset;
  rawNumericCols: string[];
  categoricalCols: string[];
  idCols: string[];
  baseMeaningfulNumericCols: string[];
  meaningfulNumericCols: string[];
  designHints: EconometricDesignHints;
  missingDataMode: MissingDataMode;
  primaryDescriptiveCol?: string;
  secondaryDescriptiveCol?: string;
  methodAssessments: MethodApplicabilityAssessment[];
  panelFeAssessment: PanelFixedEffectsAssessment;
  preparedRegression: PreparedRegressionData | null;
  robustOls: RobustOlsResult | null;
  panelFixedEffects: PanelFixedEffectsResult | null;
  diffInDiff: DiffInDiffResult | null;
  syntheticControl: SyntheticControlResult | null;
  syntheticControlPlacebos: SyntheticControlPlaceboResult | null;
  iv2Sls: Iv2SlsResult | null;
  rdd: RddResult | null;
  propensityScore: PropensityScoreResult | null;
  quantileRegression: QuantileRegressionResult | null;
}

function formatMethodApplicabilityStatus(status: MethodApplicabilityStatus): string {
  if (status === "executable_now") return "Executable now";
  if (status === "partially_ready") return "Partially ready";
  return "Blocked";
}

function clampReadinessScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildAnalysisComputationBundle(
  allData: ParsedDataset[],
  analysisTopic = "",
  analysisInputs?: AnalysisInputs,
  executableMethods?: Set<string> | null,
): AnalysisComputationBundle | null {
  const ds = getPrimaryDataset(allData);
  if (!ds) return null;

  const { numericCols: rawNumericCols, categoricalCols, idCols } = classifyColumns(ds.data, ds.columns);
  const baseMeaningfulNumericCols = rawNumericCols.filter(col => !idCols.includes(col));
  const designHints = inferEconometricDesignHints(ds, baseMeaningfulNumericCols, categoricalCols, idCols, analysisTopic, analysisInputs);
  const missingDataMode = resolveMissingDataMode(analysisInputs);
  const meaningfulNumericCols = rankMeaningfulNumericColumns(ds, baseMeaningfulNumericCols, designHints, analysisTopic);
  const primaryDescriptiveCol = choosePreferredDescriptiveNumericColumn(ds, meaningfulNumericCols, designHints);
  const secondaryDescriptiveCol = chooseSecondaryDescriptiveNumericColumn(ds, meaningfulNumericCols, designHints, primaryDescriptiveCol);
  const methodAssessments = buildMethodApplicabilityAssessment(ds, meaningfulNumericCols, categoricalCols);
  const panelFeAssessment = assessPanelFixedEffects(ds, designHints, missingDataMode);
  const preparedRegression = prepareRegressionData(ds, designHints, missingDataMode);
  const robustOls = methodAllowed(executableMethods || null, "robust_ols")
    ? computeRobustOls(ds, designHints, missingDataMode)
    : null;
  const panelFixedEffects = methodAllowed(executableMethods || null, "panel_fixed_effects")
    ? computePanelFixedEffects(ds, designHints, missingDataMode)
    : null;
  const shouldComputeDiffInDiff =
    methodAllowed(executableMethods || null, "diff_in_diff") ||
    methodAllowed(executableMethods || null, "event_study");
  const diffInDiff = shouldComputeDiffInDiff
    ? computeDiffInDiff(ds, designHints)
    : null;
  const syntheticControl = methodAllowed(executableMethods || null, "synthetic_control")
    ? computeSyntheticControl(ds, designHints)
    : null;
  const syntheticControlPlacebos = syntheticControl
    && methodAllowed(executableMethods || null, "synthetic_control")
    ? computeSyntheticControlPlacebos(ds, designHints, syntheticControl)
    : null;
  const iv2Sls = methodAllowed(executableMethods || null, "iv_2sls")
    ? computeIv2Sls(ds, designHints)
    : null;
  const rdd = methodAllowed(executableMethods || null, "regression_discontinuity")
    ? computeRegressionDiscontinuity(ds, designHints)
    : null;
  const propensityScore = methodAllowed(executableMethods || null, "propensity_score")
    ? computePropensityScore(ds, designHints)
    : null;
  const quantileRegression = methodAllowed(executableMethods || null, "quantile_regression")
    ? computeQuantileRegression(ds, designHints, missingDataMode)
    : null;

  return {
    ds,
    rawNumericCols,
    categoricalCols,
    idCols,
    baseMeaningfulNumericCols,
    meaningfulNumericCols,
    designHints,
    missingDataMode,
    primaryDescriptiveCol,
    secondaryDescriptiveCol,
    methodAssessments,
    panelFeAssessment,
    preparedRegression,
    robustOls,
    panelFixedEffects,
    diffInDiff,
    syntheticControl,
    syntheticControlPlacebos,
    iv2Sls,
    rdd,
    propensityScore,
    quantileRegression,
  };
}

function resolveAnalysisComputationBundle(
  allData: ParsedDataset[],
  analysisTopic = "",
  analysisInputs?: AnalysisInputs,
  executableMethods?: Set<string> | null,
  analysisBundle?: AnalysisComputationBundle | null,
): AnalysisComputationBundle | null {
  return analysisBundle ?? buildAnalysisComputationBundle(allData, analysisTopic, analysisInputs, executableMethods);
}

export function buildMethodApplicabilityAssessment(
  ds: ParsedDataset,
  numericCols: string[],
  categoricalCols: string[]
): MethodApplicabilityAssessment[] {
  const rowCount = ds.totalRows || ds.data.length;
  const { idCols } = classifyColumns(ds.data, ds.columns);
  const timeCols = ds.columns.filter(c => /(year|month|date|time|wave|period|quarter)/i.test(c));
  const textCols = detectTextColumns(ds);
  const lowerCols = ds.columns.map(c => c.toLowerCase());
  const hasGraphLike = lowerCols.some(c => /(node|edge|source|target|network|graph)/i.test(c));
  const hasImageLike = lowerCols.some(c => /(image|img|pixel|vision|frame|video|path)/i.test(c));
  const hasPanelLike = timeCols.length > 0 && lowerCols.some(c => /(id|code|entity|respondent|household|firm|user|patient)/i.test(c));
  const hasTreatmentLike = lowerCols.some(c => /(treat|treatment|intervention|policy|program|exposure|group)/i.test(c));
  const hasOutcomeLike = lowerCols.some(c => /(outcome|target|response|score|rate|risk|income|wage|price|cost)/i.test(c)) || numericCols.length > 0;
  const designHints = inferEconometricDesignHints(ds, numericCols, categoricalCols, idCols);

  const textDocumentCount = (() => {
    if (textCols.length === 0) return 0;
    const col = textCols[0];
    return ds.data
      .map(r => (typeof r[col] === "string" ? String(r[col]).trim() : ""))
      .filter(s => s.length >= 20)
      .length;
  })();

  let bestCorrelationPairs = 0;
  if (numericCols.length >= 2) {
    const pairLimit = Math.min(6, numericCols.length);
    for (let i = 0; i < pairLimit; i++) {
      for (let j = i + 1; j < pairLimit; j++) {
        bestCorrelationPairs = Math.max(bestCorrelationPairs, parseNumericPairs(ds, numericCols[i], numericCols[j]).length);
      }
    }
  }

  let bestTimePairs = 0;
  if (timeCols.length > 0 && numericCols.length > 0) {
    for (const tCol of timeCols.slice(0, 3)) {
      for (const nCol of numericCols.slice(0, 5)) {
        let n = 0;
        for (const row of ds.data) {
          const t = parseTimeValue(row[tCol]);
          const y = Number(row[nCol]);
          if (t !== null && !isNaN(y)) n++;
        }
        bestTimePairs = Math.max(bestTimePairs, n);
      }
    }
  }

  let bestGroupCount = 0;
  let smallestGroupN = 0;
  let bestGroupPairedRows = 0;
  if (categoricalCols.length > 0 && numericCols.length > 0) {
    for (const catCol of categoricalCols.slice(0, 4)) {
      for (const numCol of numericCols.slice(0, 4)) {
        const groups = new Map<string, number>();
        for (const row of ds.data) {
          const key = String(row[catCol] ?? "").trim();
          const value = Number(row[numCol]);
          if (!key || isNaN(value)) continue;
          groups.set(key, (groups.get(key) || 0) + 1);
        }
        const valid = Array.from(groups.values()).filter(v => v >= 3);
        if (valid.length < 2) continue;
        const minGroup = Math.min(...valid);
        const pairedRows = valid.reduce((sum, v) => sum + v, 0);
        if (pairedRows > bestGroupPairedRows) {
          bestGroupPairedRows = pairedRows;
          bestGroupCount = valid.length;
          smallestGroupN = minGroup;
        }
      }
    }
  }

  const assessments: MethodApplicabilityAssessment[] = [];
  const pushAssessment = (
    methodId: string,
    label: string,
    status: MethodApplicabilityStatus,
    readinessScore: number,
    evidence: string,
    notes: string
  ) => {
    assessments.push({
      methodId,
      label,
      status,
      readinessScore: clampReadinessScore(readinessScore),
      evidence,
      notes,
    });
  };

  const baselineEvidence = `rows=${rowCount}, numeric=${numericCols.length}, categorical=${categoricalCols.length}`;
  if (rowCount >= 20 && (numericCols.length > 0 || categoricalCols.length > 0)) {
    pushAssessment("descriptive_statistics", "Descriptive Statistics", "executable_now", 95, baselineEvidence, "Sufficient observations for robust summary statistics and distribution profiling.");
  } else if (rowCount >= 10) {
    pushAssessment("descriptive_statistics", "Descriptive Statistics", "partially_ready", 60, baselineEvidence, "Only limited descriptive summaries are reliable with current sample size.");
  } else {
    pushAssessment("descriptive_statistics", "Descriptive Statistics", "blocked", 25, baselineEvidence, "Too few observations for stable descriptive inference.");
  }

  const corrEvidence = `numeric_vars=${numericCols.length}, max_pair_n=${bestCorrelationPairs}`;
  if (numericCols.length >= 2 && bestCorrelationPairs >= 20) {
    pushAssessment("correlation", "Correlation Analysis", "executable_now", 85, corrEvidence, "At least one numeric variable pair has adequate overlap for interpretable correlation testing.");
  } else if (numericCols.length >= 2 && bestCorrelationPairs >= 10) {
    pushAssessment("correlation", "Correlation Analysis", "partially_ready", 60, corrEvidence, "Numeric pairs exist, but paired sample size is modest for stable inference.");
  } else {
    pushAssessment("correlation", "Correlation Analysis", "blocked", 20, corrEvidence, "Need two meaningful numeric variables with sufficient paired observations.");
  }

  const regressionEvidence = `numeric_vars=${numericCols.length}, max_model_n=${bestCorrelationPairs}`;
  if (numericCols.length >= 2 && bestCorrelationPairs >= 40) {
    pushAssessment("linear_regression", "Linear Regression", "executable_now", 80, regressionEvidence, "Data volume supports baseline OLS modelling and residual diagnostics.");
  } else if (numericCols.length >= 2 && bestCorrelationPairs >= 20) {
    pushAssessment("linear_regression", "Linear Regression", "partially_ready", 55, regressionEvidence, "Regression is feasible but may be underpowered for nuanced effect estimation.");
  } else {
    pushAssessment("linear_regression", "Linear Regression", "blocked", 20, regressionEvidence, "Need larger paired numeric sample and clearer dependent/independent structure.");
  }

  const groupEvidence = `groups=${bestGroupCount}, min_group_n=${smallestGroupN}, paired_rows=${bestGroupPairedRows}`;
  if (bestGroupCount >= 2 && smallestGroupN >= 5 && bestGroupPairedRows >= 30) {
    pushAssessment("group_comparison", "Group Comparison (t-test/ANOVA)", "executable_now", 78, groupEvidence, "Group structure is sufficient for between-group mean comparison with effect-size reporting.");
  } else if (bestGroupCount >= 2 && smallestGroupN >= 3) {
    pushAssessment("group_comparison", "Group Comparison (t-test/ANOVA)", "partially_ready", 52, groupEvidence, "Groups exist but small cells limit reliability of inferential comparisons.");
  } else {
    pushAssessment("group_comparison", "Group Comparison (t-test/ANOVA)", "blocked", 18, groupEvidence, "Need categorical groups and numeric outcomes with adequate per-group sample size.");
  }

  const trendEvidence = `time_cols=${timeCols.length}, numeric_vars=${numericCols.length}, max_trend_n=${bestTimePairs}`;
  if (timeCols.length > 0 && numericCols.length > 0 && bestTimePairs >= 20) {
    pushAssessment("time_trend", "Time Trend Analysis", "executable_now", 76, trendEvidence, "Temporal fields and numeric outcomes support trend estimation.");
  } else if (timeCols.length > 0 && numericCols.length > 0 && bestTimePairs >= 10) {
    pushAssessment("time_trend", "Time Trend Analysis", "partially_ready", 50, trendEvidence, "Temporal analysis is possible but limited by sparse aligned observations.");
  } else {
    pushAssessment("time_trend", "Time Trend Analysis", "blocked", 15, trendEvidence, "Need reliable temporal index and sufficient aligned numeric observations.");
  }

  const textEvidence = `text_cols=${textCols.length}, docs>=20chars=${textDocumentCount}`;
  if (textCols.length > 0 && textDocumentCount >= 30) {
    pushAssessment("text_feature_analysis", "Text Feature Analysis", "executable_now", 74, textEvidence, "Text volume supports token-frequency and document-length analytics.");
  } else if (textCols.length > 0 && textDocumentCount >= 10) {
    pushAssessment("text_feature_analysis", "Text Feature Analysis", "partially_ready", 48, textEvidence, "Text exists, but coverage is modest for robust lexical signal extraction.");
  } else {
    pushAssessment("text_feature_analysis", "Text Feature Analysis", "blocked", 12, textEvidence, "Need richer text fields with sufficient document coverage.");
  }

  const visualEvidence = `rows=${rowCount}, variables=${ds.columns.length}`;
  if (rowCount >= 10 && ds.columns.length >= 2) {
    pushAssessment("data_visualisation", "Academic Data Visualisation", "executable_now", 90, visualEvidence, "Dataset supports publication-style descriptive and inferential graphics.");
  } else if (rowCount >= 5) {
    pushAssessment("data_visualisation", "Academic Data Visualisation", "partially_ready", 55, visualEvidence, "Basic charts are feasible but inferential visualisation is limited.");
  } else {
    pushAssessment("data_visualisation", "Academic Data Visualisation", "blocked", 15, visualEvidence, "Insufficient data density for meaningful figures.");
  }

  const robustEvidence = `numeric_vars=${numericCols.length}, max_model_n=${bestCorrelationPairs}`;
  if (numericCols.length >= 2 && bestCorrelationPairs >= 40) {
    pushAssessment("robust_ols", "Robust OLS Inference", "executable_now", 82, robustEvidence, "The data supports OLS with heteroskedasticity-robust standard errors and coefficient intervals.");
  } else if (numericCols.length >= 2 && bestCorrelationPairs >= 20) {
    pushAssessment("robust_ols", "Robust OLS Inference", "partially_ready", 56, robustEvidence, "Regression is feasible, but robust inference remains sample-limited.");
  } else {
    pushAssessment("robust_ols", "Robust OLS Inference", "blocked", 18, robustEvidence, "Need a stronger paired numeric design for defensible robust inference.");
  }

  const panelFeEvidence = `entity=${designHints.primaryEntityCol || "none"}, time=${designHints.primaryTimeCol || "none"}, regressor=${designHints.primaryRegressorCol || "none"}, outcome=${designHints.primaryOutcomeCol || "none"}, rows=${rowCount}`;
  if (designHints.primaryEntityCol && designHints.primaryTimeCol && designHints.primaryOutcomeCol && designHints.primaryRegressorCol && rowCount >= 120) {
    pushAssessment("panel_fixed_effects", "Panel Fixed Effects", "executable_now", 78, panelFeEvidence, "Entity-time structure and a within-unit regressor/outcome pairing support fixed-effects estimation.");
  } else if (designHints.primaryEntityCol && designHints.primaryTimeCol && rowCount >= 60) {
    pushAssessment("panel_fixed_effects", "Panel Fixed Effects", "partially_ready", 52, panelFeEvidence, "Panel structure exists, but stronger within-unit variation or more depth is needed.");
  } else {
    pushAssessment("panel_fixed_effects", "Panel Fixed Effects", "blocked", 16, panelFeEvidence, "Need a clearer entity-time panel with repeated observations and a varying regressor.");
  }

  const didEvidence = `time=${designHints.primaryTimeCol || "none"}, treatment=${designHints.primaryTreatmentCol || "none"}, outcome=${designHints.primaryOutcomeCol || "none"}, rows=${rowCount}`;
  if (designHints.primaryTimeCol && designHints.primaryTreatmentCol && designHints.primaryOutcomeCol && rowCount >= 80) {
    pushAssessment("diff_in_diff", "Difference-in-Differences", "executable_now", 74, didEvidence, "A time, treatment, and outcome structure is available for a baseline treated-versus-control DiD design.");
  } else if (designHints.primaryTimeCol && designHints.primaryTreatmentCol && rowCount >= 50) {
    pushAssessment("diff_in_diff", "Difference-in-Differences", "partially_ready", 48, didEvidence, "Some DiD ingredients exist, but outcome support or pre/post coverage is still limited.");
  } else {
    pushAssessment("diff_in_diff", "Difference-in-Differences", "blocked", 14, didEvidence, "Need explicit treatment assignment, a time axis, and an interpretable outcome.");
  }

  const eventStudyEvidence = `time=${designHints.primaryTimeCol || "none"}, treatment=${designHints.primaryTreatmentCol || "none"}, entity=${designHints.primaryEntityCol || "none"}, rows=${rowCount}`;
  if (designHints.primaryTimeCol && designHints.primaryTreatmentCol && designHints.primaryEntityCol && designHints.primaryOutcomeCol && rowCount >= 120) {
    pushAssessment("event_study", "Event Study", "executable_now", 72, eventStudyEvidence, "Panel timing structure can support dynamic treatment-effect profiling around the intervention date.");
  } else if (designHints.primaryTimeCol && designHints.primaryTreatmentCol && rowCount >= 80) {
    pushAssessment("event_study", "Event Study", "partially_ready", 44, eventStudyEvidence, "Event-study diagnostics may be possible, but richer panel timing support is still needed.");
  } else {
    pushAssessment("event_study", "Event Study", "blocked", 12, eventStudyEvidence, "Need panel timing structure and enough pre/post observations for dynamic effect estimation.");
  }

  const scmEvidence = `entity=${designHints.primaryEntityCol || "none"}, time=${designHints.primaryTimeCol || "none"}, treatment=${designHints.primaryTreatmentCol || "none"}, rows=${rowCount}`;
  if (designHints.primaryEntityCol && designHints.primaryTimeCol && designHints.primaryTreatmentCol && designHints.primaryOutcomeCol && rowCount >= 120) {
    pushAssessment("synthetic_control", "Synthetic Control", "executable_now", 68, scmEvidence, "A treated unit, donor pool, and panel outcome history are plausibly available for synthetic-control estimation.");
  } else if (designHints.primaryEntityCol && designHints.primaryTimeCol && rowCount >= 80) {
    pushAssessment("synthetic_control", "Synthetic Control", "partially_ready", 42, scmEvidence, "Some synthetic-control ingredients exist, but donor coverage or treatment structure remains thin.");
  } else {
    pushAssessment("synthetic_control", "Synthetic Control", "blocked", 10, scmEvidence, "Need an identifiable treated unit, a donor pool, and pre-treatment panel history.");
  }

  const advancedTsEvidence = `time_cols=${timeCols.length}, trend_pairs=${bestTimePairs}`;
  if (timeCols.length > 0 && bestTimePairs >= 120) {
    pushAssessment("advanced_time_series", "Advanced Time-Series Modelling", "partially_ready", 62, advancedTsEvidence, "Temporal structure exists; advanced models may be feasible with stronger stationarity diagnostics.");
  } else {
    pushAssessment("advanced_time_series", "Advanced Time-Series Modelling", "blocked", timeCols.length > 0 ? 30 : 8, advancedTsEvidence, "Needs longer, denser temporal sequences and richer lag structure.");
  }

  const panelEvidence = `panel_like=${hasPanelLike ? "yes" : "no"}, rows=${rowCount}`;
  if (hasPanelLike && rowCount >= 150) {
    pushAssessment("panel_econometrics", "Panel Econometrics", "partially_ready", 64, panelEvidence, "Panel-style identifiers detected; feasibility depends on balanced panels and entity coverage.");
  } else {
    pushAssessment("panel_econometrics", "Panel Econometrics", "blocked", hasPanelLike ? 35 : 10, panelEvidence, "Needs explicit entity-time panel structure and broader sample depth.");
  }

  const causalEvidence = `treatment_like=${hasTreatmentLike ? "yes" : "no"}, time_like=${timeCols.length > 0 ? "yes" : "no"}, outcome_like=${hasOutcomeLike ? "yes" : "no"}, rows=${rowCount}`;
  if (hasTreatmentLike && hasOutcomeLike && timeCols.length > 0 && rowCount >= 200) {
    pushAssessment("causal_inference", "Causal Inference", "partially_ready", 55, causalEvidence, "Potential treatment/outcome structure exists, but identification assumptions still need rigorous validation.");
  } else {
    pushAssessment("causal_inference", "Causal Inference", "blocked", 12, causalEvidence, "Identification strategy prerequisites are not fully evidenced in the current data.");
  }

  const ivEvidence = `instrument=${designHints.primaryInstrumentCol || "none"}, treatment=${designHints.primaryTreatmentCol || "none"}, outcome=${designHints.primaryOutcomeCol || "none"}, rows=${rowCount}`;
  if (designHints.primaryInstrumentCol && designHints.primaryTreatmentCol && designHints.primaryOutcomeCol && rowCount >= 120) {
    pushAssessment("iv_2sls", "Instrumental Variables / 2SLS", "executable_now", 70, ivEvidence, "An instrument-like field, treatment, and outcome are available for a baseline just-identified 2SLS specification.");
  } else if (designHints.primaryInstrumentCol && designHints.primaryTreatmentCol && rowCount >= 80) {
    pushAssessment("iv_2sls", "Instrumental Variables / 2SLS", "partially_ready", 48, ivEvidence, "Instrument-like structure is present, but more support is needed for defensible first-stage strength and exclusion claims.");
  } else {
    pushAssessment("iv_2sls", "Instrumental Variables / 2SLS", "blocked", designHints.primaryInstrumentCol ? 26 : 8, ivEvidence, "Need a credible instrument plus treatment and outcome support.");
  }

  const rddEvidence = `running=${designHints.primaryRunningCol || "none"}, treatment=${designHints.primaryTreatmentCol || "none"}, outcome=${designHints.primaryOutcomeCol || "none"}, rows=${rowCount}`;
  if (designHints.primaryRunningCol && designHints.primaryTreatmentCol && designHints.primaryOutcomeCol && rowCount >= 140) {
    pushAssessment("regression_discontinuity", "Regression Discontinuity", "executable_now", 68, rddEvidence, "Running variable, treatment assignment, and outcome support a baseline local-linear RDD with bandwidth diagnostics.");
  } else if (designHints.primaryRunningCol && designHints.primaryTreatmentCol && rowCount >= 90) {
    pushAssessment("regression_discontinuity", "Regression Discontinuity", "partially_ready", 44, rddEvidence, "A running variable exists, but local support around the cutoff may still be thin.");
  } else {
    pushAssessment("regression_discontinuity", "Regression Discontinuity", "blocked", designHints.primaryRunningCol ? 24 : 8, rddEvidence, "Need an explicit running variable, cutoff logic, and sufficient local sample support.");
  }

  const psmEvidence = `treatment=${designHints.primaryTreatmentCol || "none"}, outcome=${designHints.primaryOutcomeCol || "none"}, covariates=${Math.max(0, numericCols.length - 1)}, rows=${rowCount}`;
  if (designHints.primaryTreatmentCol && designHints.primaryOutcomeCol && numericCols.length >= 4 && rowCount >= 120) {
    pushAssessment("propensity_score", "Propensity Score Methods", "executable_now", 66, psmEvidence, "Treatment and multiple covariates support a baseline propensity-score weighting design with overlap and balance diagnostics.");
  } else if (designHints.primaryTreatmentCol && designHints.primaryOutcomeCol && numericCols.length >= 3 && rowCount >= 80) {
    pushAssessment("propensity_score", "Propensity Score Methods", "partially_ready", 46, psmEvidence, "Treatment and covariates exist, but balance and overlap support may still be limited.");
  } else {
    pushAssessment("propensity_score", "Propensity Score Methods", "blocked", 12, psmEvidence, "Need richer treatment/covariate structure for matching or weighting designs.");
  }

  const quantileEvidence = `numeric_vars=${numericCols.length}, rows=${rowCount}`;
  if (numericCols.length >= 2 && rowCount >= 120) {
    pushAssessment("quantile_regression", "Quantile Regression", "executable_now", 72, quantileEvidence, "The sample supports baseline quantile-regression profiling across conditional outcome quantiles.");
  } else if (numericCols.length >= 2 && rowCount >= 80) {
    pushAssessment("quantile_regression", "Quantile Regression", "partially_ready", 50, quantileEvidence, "Quantile profiling is plausible, but tail support remains limited.");
  } else {
    pushAssessment("quantile_regression", "Quantile Regression", "blocked", 16, quantileEvidence, "Need larger continuous-outcome samples for stable tail estimation.");
  }

  const advNlpEvidence = `text_cols=${textCols.length}, docs>=20chars=${textDocumentCount}`;
  if (textCols.length > 0 && textDocumentCount >= 300) {
    pushAssessment("advanced_nlp", "Advanced NLP / Deep Text Models", "partially_ready", 58, advNlpEvidence, "Text volume may support more advanced NLP with additional model-validation resources.");
  } else {
    pushAssessment("advanced_nlp", "Advanced NLP / Deep Text Models", "blocked", textCols.length > 0 ? 26 : 8, advNlpEvidence, "Requires larger text corpora and stronger computational/annotation support.");
  }

  const graphEvidence = `graph_features=${hasGraphLike ? "detected" : "not_detected"}, rows=${rowCount}`;
  if (hasGraphLike && rowCount >= 200) {
    pushAssessment("graph_modelling", "Graph Modelling", "partially_ready", 52, graphEvidence, "Graph-like schema is present; network completeness should be validated before modelling.");
  } else {
    pushAssessment("graph_modelling", "Graph Modelling", "blocked", hasGraphLike ? 28 : 8, graphEvidence, "Needs explicit node-edge structure and sufficient graph connectivity.");
  }

  const visionEvidence = `image_features=${hasImageLike ? "detected" : "not_detected"}, rows=${rowCount}`;
  if (hasImageLike && rowCount >= 200) {
    pushAssessment("vision_analysis", "Vision Analysis", "partially_ready", 52, visionEvidence, "Image/path indicators exist; image quality and label structure should be validated.");
  } else {
    pushAssessment("vision_analysis", "Vision Analysis", "blocked", hasImageLike ? 28 : 8, visionEvidence, "Requires image tensors/paths and adequate labelled image volume.");
  }

  return assessments;
}

function topTerms(texts: string[], topN = 10): Array<[string, number]> {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has", "had", "not", "but", "you", "your", "our", "their", "its", "into", "than", "also", "can", "could", "would", "should", "about", "between", "within", "using"]);
  const freq = new Map<string, number>();
  for (const text of texts) {
    const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
    for (const token of tokens) {
      if (stop.has(token)) continue;
      freq.set(token, (freq.get(token) || 0) + 1);
    }
  }
  return Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN);
}

function getPrimaryDataset(allData: ParsedDataset[]): ParsedDataset | null {
  if (allData.length === 0) return null;
  let best: ParsedDataset | null = null;
  let bestScore = -Infinity;
  for (const ds of allData) {
    if (!ds || ds.data.length === 0) continue;
    const { numericCols, categoricalCols, idCols } = classifyColumns(ds.data, ds.columns);
    const meaningfulNumeric = numericCols.filter(c => !idCols.includes(c)).length;
    const score = ds.totalRows + meaningfulNumeric * 300 + categoricalCols.length * 50;
    if (score > bestScore) {
      bestScore = score;
      best = ds;
    }
  }
  return best || allData[0];
}

/* ------------------------------------------------------------------ */
/*  Figure planning helpers                                            */
/* ------------------------------------------------------------------ */

export type FigureSection = "descriptive" | "main" | "diagnostic";

export interface ChartDefinition {
  name: string;
  /** Short description used in logs and prompts. */
  description: string;
  /** Publication caption (what is shown, sample, uncertainty). */
  caption?: string;
  section?: FigureSection;
  config: any;
  width?: number;
  height?: number;
}

export interface TableDefinition {
  name: string;
  description: string;
  headers: string[];
  rows: (string | number)[][];
  /** Table notes printed under the table (significance legend, sample notes). */
  notes?: string;
  section?: "descriptive" | "main" | "diagnostic" | "appendix" | "methods";
}

const FIGURE_COLORS = {
  primary: "#2a78d6",
  secondary: "#eb6834",
  tertiary: "#1baf7a",
  quaternary: "#eda100",
  accent: "#e34948",
  violet: "#4a3aa7",
  neutral: "#9a9890",
};
const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

/** Rounds to significant digits (fixed-decimal rounding would turn 1e-5 coefficients into 0). */
function roundSig(value: number, digits = 5): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Number(value.toPrecision(digits));
}

function displayName(col: string, max = 36): string {
  const text = String(col ?? "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "NA";
  const abs = Math.abs(value);
  if (abs >= 1e6) return value.toExponential(2);
  if (abs >= 1000) return value.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  if (abs === 0) return "0";
  if (abs < 0.001) return value.toExponential(2);
  return value.toFixed(3);
}

function formatCount(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatPValue(p: number): string {
  if (!Number.isFinite(p)) return "NA";
  if (p < 0.001) return "< 0.001";
  return p.toFixed(3);
}

function significanceStars(p: number): string {
  if (!Number.isFinite(p)) return "";
  if (p < 0.001) return "***";
  if (p < 0.01) return "**";
  if (p < 0.05) return "*";
  return "";
}

function numericValuesOf(ds: ParsedDataset, col: string, limit = Number.POSITIVE_INFINITY): number[] {
  const values: number[] = [];
  for (const row of ds.data) {
    const raw = row[col];
    if (isMissingValue(raw)) continue;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(value)) values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function sortedQuantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

interface NumericSummary {
  n: number;
  mean: number;
  sd: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

function summariseValues(values: number[]): NumericSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const m = sorted.reduce((sum, v) => sum + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(sorted.reduce((sum, v) => sum + (v - m) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    mean: m,
    sd,
    min: sorted[0],
    q1: sortedQuantile(sorted, 0.25),
    median: sortedQuantile(sorted, 0.5),
    q3: sortedQuantile(sorted, 0.75),
    max: sorted[n - 1],
  };
}

function meanConfidenceInterval(values: number[]): { mean: number; low: number; high: number; n: number; sd: number } | null {
  const n = values.length;
  if (n === 0) return null;
  const m = values.reduce((sum, v) => sum + v, 0) / n;
  if (n < 2) return { mean: m, low: m, high: m, n, sd: 0 };
  const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (n - 1));
  const half = studentTCritical(n - 1) * sd / Math.sqrt(n);
  return { mean: m, low: m - half, high: m + half, n, sd };
}

function pearsonFromPairs(pairs: [number, number][]): { r: number; n: number; p: number } | null {
  const n = pairs.length;
  if (n < 4) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (const [x, y] of pairs) {
    cov += (x - mx) * (y - my);
    vx += (x - mx) ** 2;
    vy += (y - my) ** 2;
  }
  if (vx <= 0 || vy <= 0) return null;
  const r = Math.max(-1, Math.min(1, cov / Math.sqrt(vx * vy)));
  const t = Math.abs(r) >= 1 ? Infinity : r * Math.sqrt((n - 2) / (1 - r * r));
  return { r, n, p: studentTTwoTailPValue(t, n - 2) };
}

function distinctNumericCount(ds: ParsedDataset, col: string, sample = 3000): number {
  return new Set(numericValuesOf(ds, col, sample)).size;
}

function isContinuousColumn(ds: ParsedDataset, col: string): boolean {
  return distinctNumericCount(ds, col) > 10;
}

function categoryKey(raw: unknown): string | null {
  if (isMissingValue(raw)) return null;
  const text = String(raw).trim();
  return text ? text.slice(0, 40) : null;
}

function groupNumericValues(ds: ParsedDataset, groupCol: string, valueCol: string): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const row of ds.data) {
    const key = categoryKey(row[groupCol]);
    if (key === null) continue;
    const raw = row[valueCol];
    if (isMissingValue(raw)) continue;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function orderCategoryKeys(keys: string[], sizeOf: (key: string) => number): string[] {
  const allNumeric = keys.length > 0 && keys.every(key => key !== "" && Number.isFinite(Number(key)));
  if (allNumeric) return [...keys].sort((a, b) => Number(a) - Number(b));
  return [...keys].sort((a, b) => sizeOf(b) - sizeOf(a) || a.localeCompare(b));
}

function categoryCounts(ds: ParsedDataset, col: string): Map<string, number> {
  const fromProfile = ds.fullDataProfile?.categorical?.[col];
  const counts = new Map<string, number>();
  if (fromProfile && Object.keys(fromProfile).length > 0) {
    for (const [key, count] of Object.entries(fromProfile)) counts.set(key.slice(0, 40), (counts.get(key.slice(0, 40)) || 0) + count);
    return counts;
  }
  for (const row of ds.data) {
    const key = categoryKey(row[col]);
    if (key === null) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function averageTextLength(ds: ParsedDataset, col: string): number {
  const values = ds.data.slice(0, 300).map(row => row[col]).filter(v => typeof v === "string") as string[];
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v.length, 0) / values.length;
}

/**
 * Picks the categorical variable that best serves as a comparison grouping:
 * user-specified subgroup, then a binary treatment, then a meaningfully named
 * categorical with a handful of reasonably balanced levels.
 */
function chooseGroupingColumn(ds: ParsedDataset, bundle: AnalysisComputationBundle, exclude: Array<string | undefined> = [], topic = ""): string | undefined {
  const topicKeywords = extractTopicKeywords(topic);
  const hints = bundle.designHints;
  const blocked = new Set(
    [hints.primaryOutcomeCol, hints.primaryEntityCol, hints.primaryTimeCol, ...hints.timeCols, ...exclude]
      .filter((c): c is string => Boolean(c)),
  );
  const levelInfo = (col: string) => {
    const counts = categoryCounts(ds, col);
    const levels = counts.size;
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    const smallest = levels > 0 ? Math.min(...Array.from(counts.values())) : 0;
    return { levels, total, smallest };
  };
  if (hints.subgroupCol && !blocked.has(hints.subgroupCol)) {
    const info = levelInfo(hints.subgroupCol);
    if (info.levels >= 2 && info.levels <= 20) return hints.subgroupCol;
  }
  if (hints.primaryTreatmentCol && !blocked.has(hints.primaryTreatmentCol) && isBinaryLikeColumn(ds, hints.primaryTreatmentCol)) {
    return hints.primaryTreatmentCol;
  }
  let best: { col: string; score: number } | null = null;
  for (const col of bundle.categoricalCols) {
    if (blocked.has(col) || bundle.idCols.includes(col)) continue;
    if (averageTextLength(ds, col) > 40) continue;
    const info = levelInfo(col);
    if (info.levels < 2 || info.levels > 20 || info.total < 10) continue;
    let score = 0;
    if (info.levels <= 8) score += 4;
    else if (info.levels <= 12) score += 2;
    if (info.smallest >= 5) score += 2;
    if (/(group|sex|gender|region|type|category|status|education|occupation|industry|arm|cohort|class|segment|country|state|prefecture|employment|marital|race|ethnic|treat)/i.test(col)) score += 3;
    if (/(wave|year|month|date|time|period|quarter)/i.test(col)) score -= 5;
    score += scoreTopicAlignment(col, topicKeywords);
    if (!best || score > best.score) best = { col, score };
  }
  return best?.col;
}

function chooseTimeColumn(ds: ParsedDataset, hints: EconometricDesignHints): string | undefined {
  const candidates = uniqueDefinedColumns([hints.primaryTimeCol, ...hints.timeCols]);
  for (const col of candidates) {
    const distinct = sampleDistinctValues(ds, col, 400).length;
    if (distinct >= 3) return col;
  }
  return undefined;
}

interface TimeBucketing {
  keyOf: (raw: unknown) => { key: string; order: number } | null;
}

function buildTimeBucketing(ds: ParsedDataset, timeCol: string): TimeBucketing {
  const sample = ds.data.slice(0, 2000).map(row => row[timeCol]).filter(v => !isMissingValue(v));
  const numericShare = sample.filter(v => Number.isFinite(Number(v))).length / Math.max(1, sample.length);
  if (numericShare >= 0.9) {
    const values = numericValuesOf(ds, timeCol);
    const distinct = Array.from(new Set(values)).sort((a, b) => a - b);
    if (distinct.length <= 40) {
      return {
        keyOf: raw => {
          const v = Number(raw);
          if (!Number.isFinite(v) || isMissingValue(raw)) return null;
          // Periods are labels, not quantities: never add thousands separators (2015, not 2,015).
          return { key: Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6))), order: v };
        },
      };
    }
    const min = distinct[0];
    const max = distinct[distinct.length - 1];
    const bins = 30;
    const width = (max - min) / bins || 1;
    return {
      keyOf: raw => {
        const v = Number(raw);
        if (isMissingValue(raw) || !Number.isFinite(v)) return null;
        const index = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / width)));
        const center = min + (index + 0.5) * width;
        return { key: String(Number(center.toPrecision(5))), order: center };
      },
    };
  }
  // Date-like strings: bucket by month when the span is short, otherwise by year.
  const times = sample.map(v => new Date(String(v)).getTime()).filter(t => Number.isFinite(t));
  const span = times.length ? (Math.max(...times) - Math.min(...times)) / (365.25 * 86400000) : 0;
  const byMonth = span <= 5;
  return {
    keyOf: raw => {
      if (isMissingValue(raw)) return null;
      const time = new Date(String(raw)).getTime();
      if (!Number.isFinite(time)) {
        const text = String(raw).trim();
        return text ? { key: text.slice(0, 20), order: Number.NaN } : null;
      }
      const date = new Date(time);
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      return byMonth
        ? { key: `${year}-${String(month).padStart(2, "0")}`, order: year * 12 + month }
        : { key: String(year), order: year };
    },
  };
}

/** Gaussian KDE evaluated on a grid and scaled to histogram counts. */
function kernelDensityCurve(values: number[], lo: number, hi: number, scale: number, gridSize = 80): Array<{ x: number; y: number }> {
  const sample = values.length > 4000 ? values.filter((_, i) => i % Math.ceil(values.length / 4000) === 0) : values;
  const summary = summariseValues(sample);
  if (!summary || summary.sd <= 0) return [];
  const spread = Math.min(summary.sd, (summary.q3 - summary.q1) / 1.34 || summary.sd);
  const bandwidth = 0.9 * spread * Math.pow(sample.length, -0.2);
  if (!(bandwidth > 0)) return [];
  const points: Array<{ x: number; y: number }> = [];
  const norm = 1 / (sample.length * bandwidth * Math.sqrt(2 * Math.PI));
  for (let i = 0; i <= gridSize; i++) {
    const x = lo + ((hi - lo) * i) / gridSize;
    let density = 0;
    for (const v of sample) {
      const u = (x - v) / bandwidth;
      if (Math.abs(u) < 6) density += Math.exp(-0.5 * u * u);
    }
    points.push({ x: Math.round(x * 1e6) / 1e6, y: Math.round(density * norm * scale * 1e6) / 1e6 });
  }
  return points;
}

function oneWayAnova(groups: number[][]): { f: number; df1: number; df2: number; p: number; eta2: number } | null {
  const valid = groups.filter(g => g.length >= 2);
  if (valid.length < 2) return null;
  const all = valid.flat();
  const grand = all.reduce((a, b) => a + b, 0) / all.length;
  let ssBetween = 0;
  let ssWithin = 0;
  for (const g of valid) {
    const gm = g.reduce((a, b) => a + b, 0) / g.length;
    ssBetween += g.length * (gm - grand) ** 2;
    for (const v of g) ssWithin += (v - gm) ** 2;
  }
  const df1 = valid.length - 1;
  const df2 = all.length - valid.length;
  if (df2 <= 0 || ssWithin <= 0) return null;
  const f = (ssBetween / df1) / (ssWithin / df2);
  return { f, df1, df2, p: fDistributionPValue(f, df1, df2), eta2: ssBetween / (ssBetween + ssWithin) };
}

function welchTTest(a: number[], b: number[]): { t: number; df: number; p: number; diff: number } | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (b.length - 1);
  const se2 = va / a.length + vb / b.length;
  if (!(se2 > 0)) return null;
  const t = (ma - mb) / Math.sqrt(se2);
  const df = se2 ** 2 / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1));
  return { t, df, p: studentTTwoTailPValue(t, df), diff: ma - mb };
}

function columnStandardDeviation(ds: ParsedDataset, col: string): number {
  const values = ds.data.map(row => regressorValue(ds, row, col)).filter((v): v is number => v !== null);
  const summary = summariseValues(values);
  return summary?.sd || 0;
}

const SECTION_ORDER: Record<FigureSection, number> = { descriptive: 0, main: 1, diagnostic: 2 };
const MAX_FIGURES = 12;

export function generateDefaultCharts(
  allData: { name: string; data: Record<string, any>[]; columns: string[]; totalRows: number; fullDataProfile?: FullDataProfile }[],
  executableMethods: Set<string> | null,
  analysisTopic = "",
  analysisInputs?: AnalysisInputs,
  analysisBundle?: AnalysisComputationBundle | null,
): ChartDefinition[] {
  const charts: ChartDefinition[] = [];
  const bundle = resolveAnalysisComputationBundle(allData, analysisTopic, analysisInputs, executableMethods, analysisBundle);
  const ds = bundle?.ds || getPrimaryDataset(allData);
  if (!ds || ds.data.length === 0 || !bundle) return charts;

  const hints = bundle.designHints;
  const numericCols = bundle.meaningfulNumericCols || [];
  const outcomeCol = bundle.primaryDescriptiveCol;
  const outcomeLabel = outcomeCol ? displayName(outcomeCol) : "";
  const outcomeIsBinary = outcomeCol ? isBinaryLikeColumn(ds, outcomeCol) : false;
  const groupCol = chooseGroupingColumn(ds, bundle, [], analysisTopic);
  const timeCol = chooseTimeColumn(ds, hints);
  const { robustOls, panelFixedEffects, diffInDiff, syntheticControl, syntheticControlPlacebos, iv2Sls, rdd, propensityScore, quantileRegression } = bundle;
  const push = (chart: ChartDefinition) => charts.push({ section: "main", ...chart });

  // ---------------------------------------------------------------- F1: outcome distribution
  if (outcomeCol && methodAllowed(executableMethods, "descriptive_statistics")) {
    const values = numericValuesOf(ds, outcomeCol);
    const summary = summariseValues(values);
    if (summary && values.length >= 3) {
      const distinct = new Set(values.slice(0, 5000)).size;
      const discrete = distinct <= 12 && values.slice(0, 5000).every(v => Number.isInteger(v));
      const stats = `n = ${formatCount(summary.n)}; mean = ${formatNumber(summary.mean)} (SD = ${formatNumber(summary.sd)}); median = ${formatNumber(summary.median)}`;
      let config: any;
      let note = "";
      if (discrete) {
        const counts = new Map<number, number>();
        for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
        const keys = Array.from(counts.keys()).sort((a, b) => a - b);
        config = {
          type: "bar",
          data: {
            labels: keys.map(k => String(k)),
            datasets: [{ label: outcomeLabel, data: keys.map(k => Math.round((counts.get(k)! / values.length) * 1000) / 10), backgroundColor: FIGURE_COLORS.primary }],
          },
          options: {
            plugins: { title: { display: true, text: `Distribution of ${outcomeLabel}` }, subtitle: { text: stats }, valueLabels: { decimals: 1, suffix: "%" } },
            scales: { x: { title: { display: true, text: outcomeLabel } }, y: { title: { display: true, text: "Share of observations (%)" } } },
          },
        };
        note = "Bars show the share of observations taking each value.";
      } else {
        const sorted = [...values].sort((a, b) => a - b);
        const p005 = sortedQuantile(sorted, 0.005);
        const p995 = sortedQuantile(sorted, 0.995);
        const core = p995 - p005;
        const trim = core > 0 && (summary.max - p995 > 0.5 * core || p005 - summary.min > 0.5 * core);
        const lo = trim ? p005 : summary.min;
        const hi = trim ? p995 : summary.max;
        const inRange = trim ? values.filter(v => v >= lo && v <= hi) : values;
        const iqr = summary.q3 - summary.q1;
        const fdWidth = iqr > 0 ? (2 * iqr) / Math.cbrt(inRange.length) : 0;
        const sturges = Math.ceil(Math.log2(inRange.length) + 1);
        const binCount = Math.max(6, Math.min(40, fdWidth > 0 ? Math.ceil((hi - lo) / fdWidth) : sturges));
        const width = (hi - lo) / binCount || 1;
        const counts = Array(binCount).fill(0);
        for (const v of inRange) counts[Math.min(binCount - 1, Math.max(0, Math.floor((v - lo) / width)))]++;
        const bins = counts.map((count, i) => ({ x0: lo + i * width, x1: lo + (i + 1) * width, count }));
        const density = kernelDensityCurve(inRange, lo, hi, inRange.length * width);
        config = {
          type: "histogram",
          data: {
            datasets: [
              { label: "Observations", data: bins, backgroundColor: FIGURE_COLORS.primary },
              ...(density.length ? [{ type: "line", label: "Kernel density (scaled to counts)", data: density, borderColor: FIGURE_COLORS.secondary }] : []),
            ],
          },
          options: {
            plugins: { title: { display: true, text: `Distribution of ${outcomeLabel}` }, subtitle: { text: stats } },
            referenceLines: [{ axis: "x", value: summary.mean, label: `Mean ${formatNumber(summary.mean)}` }],
            scales: { x: { title: { display: true, text: outcomeLabel } }, y: { title: { display: true, text: "Number of observations" } } },
          },
        };
        note = `Bars use ${binCount} equal-width bins (Freedman-Diaconis rule); the curve is a Gaussian kernel density estimate scaled to counts; the dashed line marks the mean.${trim ? ` The horizontal axis is limited to the 0.5th-99.5th percentiles (${formatCount(values.length - inRange.length)} extreme observations not shown).` : ""}`;
      }
      push({
        name: "distribution_histogram",
        description: `Distribution of ${outcomeLabel} (n = ${formatCount(values.length)})`,
        caption: `Distribution of ${outcomeLabel} (${stats}). ${note}`,
        section: "descriptive",
        config,
      });
    }
  }

  // ---------------------------------------------------------------- F2: categorical composition
  if (groupCol && methodAllowed(executableMethods, "descriptive_statistics")) {
    const counts = categoryCounts(ds, groupCol);
    const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (entries.length >= 2) {
      const total = entries.reduce((sum, [, c]) => sum + c, 0);
      const top = entries.slice(0, 12);
      const rest = entries.slice(12).reduce((sum, [, c]) => sum + c, 0);
      if (rest > 0) top.push([`Other (${entries.length - 12} categories)`, rest]);
      const label = displayName(groupCol);
      push({
        name: "category_distribution",
        description: `Composition of the sample by ${label}`,
        caption: `Composition of the sample by ${label} (N = ${formatCount(total)}). Bars show the percentage of observations in each category${rest > 0 ? "; smaller categories are pooled as Other" : ""}.`,
        section: "descriptive",
        height: Math.max(360, Math.min(620, 150 + top.length * 34)),
        config: {
          type: "bar",
          data: {
            labels: top.map(([k]) => k),
            datasets: [{ label: "Share (%)", data: top.map(([, c]) => Math.round((c / total) * 1000) / 10), backgroundColor: FIGURE_COLORS.primary }],
          },
          options: {
            indexAxis: "y",
            plugins: { title: { display: true, text: `Sample composition by ${label}` }, valueLabels: { decimals: 1, suffix: "%" } },
            scales: { x: { title: { display: true, text: "Share of observations (%)" } }, y: { title: { display: true, text: label } } },
          },
        },
      });
    }
  }

  // ---------------------------------------------------------------- F3/F4: outcome by group
  if (outcomeCol && groupCol && groupCol !== outcomeCol && methodAllowed(executableMethods, "group_comparison")) {
    const grouped = groupNumericValues(ds, groupCol, outcomeCol);
    const eligible = Array.from(grouped.entries()).filter(([, v]) => v.length >= 3);
    const kept = eligible.sort((a, b) => b[1].length - a[1].length).slice(0, 12);
    const keys = orderCategoryKeys(kept.map(([k]) => k), k => grouped.get(k)?.length || 0);
    const groupLabel = displayName(groupCol);
    if (keys.length >= 2) {
      const anova = oneWayAnova(keys.map(k => grouped.get(k)!));
      const testText = anova
        ? `One-way ANOVA: F(${anova.df1}, ${anova.df2}) = ${anova.f.toFixed(2)}, p ${anova.p < 0.001 ? "< 0.001" : `= ${anova.p.toFixed(3)}`}, eta^2 = ${anova.eta2.toFixed(3)}`
        : "";
      if (!outcomeIsBinary && isContinuousColumn(ds, outcomeCol)) {
        const boxes = keys.map(key => {
          const sorted = [...grouped.get(key)!].sort((a, b) => a - b);
          const q1 = sortedQuantile(sorted, 0.25);
          const q3 = sortedQuantile(sorted, 0.75);
          const iqr = q3 - q1;
          const lowFence = q1 - 1.5 * iqr;
          const highFence = q3 + 1.5 * iqr;
          const inside = sorted.filter(v => v >= lowFence && v <= highFence);
          const outliers = sorted.filter(v => v < lowFence || v > highFence);
          const pickedOutliers = outliers.length > 12 ? [...outliers.slice(0, 6), ...outliers.slice(-6)] : outliers;
          return {
            min: inside.length ? inside[0] : sorted[0],
            q1,
            median: sortedQuantile(sorted, 0.5),
            q3,
            max: inside.length ? inside[inside.length - 1] : sorted[sorted.length - 1],
            mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
            outliers: pickedOutliers,
          };
        });
        push({
          name: "box_plot",
          description: `Distribution of ${outcomeLabel} by ${groupLabel}`,
          caption: `Distribution of ${outcomeLabel} by ${groupLabel}. Boxes span the interquartile range, the thick line marks the median, the diamond marks the mean, whiskers extend to 1.5 x IQR and circles show observations beyond the whiskers.${testText ? ` ${testText}.` : ""}`,
          section: "descriptive",
          config: {
            type: "boxplot",
            data: { labels: keys, datasets: [{ label: outcomeLabel, data: boxes, backgroundColor: "rgba(42, 120, 214, 0.35)", borderColor: "#1c5cab" }] },
            options: {
              plugins: { title: { display: true, text: `${outcomeLabel} by ${groupLabel}` }, subtitle: { text: testText } },
              scales: { x: { title: { display: true, text: groupLabel } }, y: { title: { display: true, text: outcomeLabel } } },
            },
          },
        });
      }
      const cis = keys.map(key => meanConfidenceInterval(grouped.get(key)!)!);
      const horizontal = keys.length > 6 || keys.some(k => k.length > 14);
      const valueTitle = outcomeIsBinary ? `Share with ${outcomeLabel} = 1` : `Mean ${outcomeLabel}`;
      push({
        name: "category_comparison",
        description: `Mean ${outcomeLabel} by ${groupLabel} with 95% confidence intervals`,
        caption: `${outcomeIsBinary ? "Proportion" : "Mean"} of ${outcomeLabel} by ${groupLabel}. Error bars are 95% confidence intervals based on the t distribution (group sizes ${keys.map((k, i) => `${k}: ${formatCount(cis[i].n)}`).slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""}).${testText ? ` ${testText}.` : ""}`,
        section: "main",
        height: horizontal ? Math.max(380, Math.min(640, 150 + keys.length * 36)) : undefined,
        config: {
          type: "bar",
          data: {
            labels: keys,
            datasets: [{
              label: valueTitle,
              data: cis.map(ci => roundSig(ci.mean)),
              errorBars: cis.map(ci => [roundSig(ci.low), roundSig(ci.high)]),
              backgroundColor: FIGURE_COLORS.primary,
            }],
          },
          options: {
            indexAxis: horizontal ? "y" : "x",
            plugins: { title: { display: true, text: `${valueTitle} by ${groupLabel} (95% CI)` }, subtitle: { text: testText } },
            scales: horizontal
              ? { x: { title: { display: true, text: valueTitle } }, y: { title: { display: true, text: groupLabel } } }
              : { x: { title: { display: true, text: groupLabel } }, y: { title: { display: true, text: valueTitle } } },
          },
        },
      });
    }
  }

  // ---------------------------------------------------------------- F5: correlation heatmap
  if (numericCols.length >= 3 && methodAllowed(executableMethods, "correlation")) {
    const cols = numericCols.filter(c => !isPathologicalNumericColumn(ds, c)).slice(0, 8);
    if (cols.length >= 3) {
      const cells: Array<{ x: number; y: number; v: number }> = [];
      let minN = Infinity;
      let maxN = 0;
      for (let i = 0; i < cols.length; i++) {
        for (let j = 0; j <= i; j++) {
          if (i === j) { cells.push({ x: j, y: i, v: 1 }); continue; }
          const result = pearsonFromPairs(parseNumericPairs(ds, cols[i], cols[j]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)));
          if (result) {
            minN = Math.min(minN, result.n);
            maxN = Math.max(maxN, result.n);
          }
          cells.push({ x: j, y: i, v: result ? Math.round(result.r * 100) / 100 : 0 });
        }
      }
      push({
        name: "correlation_matrix",
        description: "Pairwise Pearson correlations among the main numeric variables",
        caption: `Pairwise Pearson correlation coefficients among ${cols.length} numeric variables (pairwise-complete observations${Number.isFinite(minN) ? `, n = ${formatCount(minN)}${maxN !== minN ? `-${formatCount(maxN)}` : ""}` : ""}). Blue indicates positive and red negative association; the lower triangle is shown.`,
        section: "descriptive",
        width: 900,
        height: 640,
        config: {
          type: "heatmap",
          data: { labels: cols.map(c => displayName(c, 28)), datasets: [{ data: cells }] },
          options: { heatmap: { triangle: "lower" }, plugins: { title: { display: true, text: "Correlation matrix (Pearson r)" } } },
        },
      });
    }
  }

  // ---------------------------------------------------------------- F6: key bivariate relation
  if (outcomeCol && numericCols.length >= 2 && methodAllowed(executableMethods, "correlation")) {
    let xCol: string | undefined;
    if (hints.primaryRegressorCol && hints.primaryRegressorCol !== outcomeCol && numericCols.includes(hints.primaryRegressorCol) && isContinuousColumn(ds, hints.primaryRegressorCol)) {
      xCol = hints.primaryRegressorCol;
    } else {
      let bestAbs = -1;
      for (const candidate of numericCols.slice(0, 10)) {
        if (candidate === outcomeCol || !isContinuousColumn(ds, candidate) || isPathologicalNumericColumn(ds, candidate)) continue;
        const result = pearsonFromPairs(parseNumericPairs(ds, candidate, outcomeCol));
        if (result && Math.abs(result.r) > bestAbs) {
          bestAbs = Math.abs(result.r);
          xCol = candidate;
        }
      }
    }
    if (xCol) {
      const pairs = parseNumericPairs(ds, xCol, outcomeCol).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
      const corr = pearsonFromPairs(pairs);
      const reg = regressionStatsFromPairs(pairs);
      if (corr && pairs.length >= 10) {
        const stride = Math.max(1, Math.ceil(pairs.length / 1500));
        const xDistinct = new Set(pairs.slice(0, 3000).map(p => p[0])).size;
        const yDistinct = new Set(pairs.slice(0, 3000).map(p => p[1])).size;
        const xs = pairs.map(p => p[0]);
        const xMin = Math.min(...xs);
        const xMax = Math.max(...xs);
        const ys = pairs.map(p => p[1]);
        const yRange = Math.max(...ys) - Math.min(...ys) || 1;
        const xRange = xMax - xMin || 1;
        const jitter = (i: number, span: number, distinct: number) => (distinct <= 15 ? (((i * 7919) % 1000) / 1000 - 0.5) * span * 0.02 : 0);
        const points = [] as Array<{ x: number; y: number }>;
        for (let i = 0; i < pairs.length; i += stride) {
          points.push({
            x: roundSig((pairs[i][0] + jitter(i, xRange, xDistinct))),
            y: roundSig((pairs[i][1] + jitter(i + 13, yRange, yDistinct))),
          });
        }
        const xLabel = displayName(xCol);
        const datasets: any[] = [{ label: "Observations", data: points, backgroundColor: FIGURE_COLORS.primary, pointRadius: pairs.length > 800 ? 2.2 : 3 }];
        if (reg) {
          datasets.push({
            label: `Least-squares fit (slope = ${formatNumber(reg.slope)})`,
            data: [{ x: xMin, y: reg.intercept + reg.slope * xMin }, { x: xMax, y: reg.intercept + reg.slope * xMax }],
            showLine: true,
            pointRadius: 0,
            borderColor: FIGURE_COLORS.accent,
          });
        }
        const stats = `r = ${corr.r.toFixed(3)} (p ${corr.p < 0.001 ? "< 0.001" : `= ${corr.p.toFixed(3)}`}), n = ${formatCount(corr.n)}`;
        push({
          name: "scatter_plot",
          description: `${outcomeLabel} versus ${xLabel} (${stats})`,
          caption: `Relationship between ${xLabel} and ${outcomeLabel} (${stats}). Points are individual observations${stride > 1 ? ` (every ${stride}th observation plotted)` : ""}${xDistinct <= 15 || yDistinct <= 15 ? " with slight jitter to reduce overplotting" : ""}; the line is the bivariate least-squares fit.`,
          section: "main",
          config: {
            type: "scatter",
            data: { datasets },
            options: {
              plugins: { title: { display: true, text: `${outcomeLabel} vs ${xLabel}` }, subtitle: { text: stats } },
              scales: { x: { title: { display: true, text: xLabel } }, y: { title: { display: true, text: outcomeLabel } } },
            },
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------- F7: time trend
  if (timeCol && outcomeCol && timeCol !== outcomeCol && methodAllowed(executableMethods, "time_trend")) {
    const bucketing = buildTimeBucketing(ds, timeCol);
    // A time-varying treatment indicator would split the series mechanically at onset;
    // the parallel-trends figure handles treated-versus-control comparisons instead.
    const trendGroupCol = groupCol && groupCol !== timeCol && groupCol !== hints.primaryTreatmentCol && categoryCounts(ds, groupCol).size <= 5 ? groupCol : undefined;
    const buckets = new Map<string, { order: number; byGroup: Map<string, number[]> }>();
    for (const row of ds.data) {
      const bucket = bucketing.keyOf(row[timeCol]);
      if (!bucket) continue;
      const raw = row[outcomeCol];
      if (isMissingValue(raw)) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const group = trendGroupCol ? categoryKey(row[trendGroupCol]) : "All";
      if (group === null) continue;
      const entry = buckets.get(bucket.key) || { order: bucket.order, byGroup: new Map<string, number[]>() };
      const list = entry.byGroup.get(group) || [];
      list.push(value);
      entry.byGroup.set(group, list);
      buckets.set(bucket.key, entry);
    }
    const orderedKeys = Array.from(buckets.entries())
      .sort((a, b) => (Number.isFinite(a[1].order) && Number.isFinite(b[1].order) ? a[1].order - b[1].order : a[0].localeCompare(b[0])))
      .map(([k]) => k)
      .slice(-60);
    if (orderedKeys.length >= 3) {
      const groupNames = trendGroupCol
        ? orderCategoryKeys(Array.from(new Set(orderedKeys.flatMap(k => Array.from(buckets.get(k)!.byGroup.keys())))), g => orderedKeys.reduce((s, k) => s + (buckets.get(k)!.byGroup.get(g)?.length || 0), 0))
        : ["All"];
      const datasets = groupNames.slice(0, 5).map((group, index) => {
        const cis = orderedKeys.map(k => {
          const values = buckets.get(k)!.byGroup.get(group) || [];
          return values.length ? meanConfidenceInterval(values) : null;
        });
        const round = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : roundSig(v));
        return {
          label: trendGroupCol ? `${displayName(trendGroupCol, 20)} = ${group}` : `Mean ${outcomeLabel}`,
          data: cis.map(ci => round(ci?.mean)),
          ciLower: cis.map(ci => (ci && ci.n >= 2 ? round(ci.low) : null)),
          ciUpper: cis.map(ci => (ci && ci.n >= 2 ? round(ci.high) : null)),
          borderColor: SERIES_COLORS[index % SERIES_COLORS.length],
        };
      }).filter(d => d.data.filter(v => v !== null).length >= 2);
      if (datasets.length > 0) {
        const timeLabel = displayName(timeCol);
        push({
          name: "time_trend",
          description: `Trend in mean ${outcomeLabel} over ${timeLabel}${trendGroupCol ? ` by ${displayName(trendGroupCol)}` : ""}`,
          caption: `Mean ${outcomeLabel} by ${timeLabel}${trendGroupCol ? `, separately by ${displayName(trendGroupCol)}` : ""}. Shaded bands are 95% confidence intervals for the period means.`,
          section: "main",
          config: {
            type: "line",
            data: { labels: orderedKeys, datasets },
            options: {
              plugins: { title: { display: true, text: `Mean ${outcomeLabel} over ${timeLabel}` } },
              scales: { x: { title: { display: true, text: timeLabel } }, y: { title: { display: true, text: `Mean ${outcomeLabel}` } } },
            },
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------- F8: standardised coefficients
  if (robustOls && robustOls.regressorCols.length >= 2 && methodAllowed(executableMethods, "robust_ols")) {
    const ySd = columnStandardDeviation(ds, robustOls.yCol);
    const rows = robustOls.coefficients
      .filter(c => c.name !== "intercept")
      .map(c => {
        const xSd = columnStandardDeviation(ds, c.name);
        const scale = ySd > 0 && xSd > 0 ? xSd / ySd : NaN;
        return { name: c.name, estimate: c.coefficient * scale, low: c.ciLower * scale, high: c.ciUpper * scale, p: c.pValue };
      })
      .filter(row => Number.isFinite(row.estimate) && Number.isFinite(row.low) && Number.isFinite(row.high));
    if (rows.length >= 2) {
      push({
        name: "coefficient_forest_plot",
        description: `Standardised multivariable OLS coefficients for ${displayName(robustOls.yCol)}`,
        caption: `Standardised coefficients (change in SD of ${displayName(robustOls.yCol)} per SD change in each regressor) from the multivariable OLS model with ${robustOls.vcovType === "cluster" ? `standard errors clustered by ${robustOls.clusterCol || "entity"}` : "heteroskedasticity-robust (HC1) standard errors"} (n = ${formatCount(robustOls.n)}). Horizontal lines are 95% confidence intervals; the dashed line marks zero.`,
        section: "main",
        height: Math.max(360, Math.min(680, 150 + rows.length * 44)),
        config: {
          type: "forest",
          data: {
            labels: rows.map(row => `${displayName(row.name, 30)}${significanceStars(row.p) ? ` ${significanceStars(row.p)}` : ""}`),
            datasets: [{ label: "Standardised coefficient", data: rows.map(row => ({ estimate: roundSig(row.estimate), low: roundSig(row.low), high: roundSig(row.high) })), borderColor: FIGURE_COLORS.primary }],
          },
          options: {
            referenceLines: [{ axis: "x", value: 0 }],
            plugins: { title: { display: true, text: `Standardised coefficients: ${displayName(robustOls.yCol)}` }, footnote: { text: "* p < 0.05, ** p < 0.01, *** p < 0.001" } },
            scales: { x: { title: { display: true, text: "Standardised coefficient (95% CI)" } } },
          },
        },
      });
    }
  }

  // ---------------------------------------------------------------- F9: estimator comparison
  {
    const rows: Array<{ label: string; estimate: number; low: number; high: number }> = [];
    if (robustOls && methodAllowed(executableMethods, "robust_ols")) {
      rows.push({ label: `OLS${robustOls.controlCols.length ? " + controls" : ""} (${robustOls.vcovType === "cluster" ? "clustered SE" : "HC1 SE"})`, estimate: robustOls.slope, low: robustOls.ciLower, high: robustOls.ciUpper });
    }
    if (panelFixedEffects && methodAllowed(executableMethods, "panel_fixed_effects")) {
      const crit = studentTCritical(Math.max(1, (panelFixedEffects.clusterCount || panelFixedEffects.n) - 1));
      rows.push({ label: "Two-way fixed effects", estimate: panelFixedEffects.beta, low: panelFixedEffects.beta - crit * panelFixedEffects.se, high: panelFixedEffects.beta + crit * panelFixedEffects.se });
    }
    if (iv2Sls && methodAllowed(executableMethods, "iv_2sls")) rows.push({ label: "IV / 2SLS", estimate: iv2Sls.beta, low: iv2Sls.ciLower, high: iv2Sls.ciUpper });
    if (rdd && methodAllowed(executableMethods, "regression_discontinuity")) rows.push({ label: "RDD (local linear)", estimate: rdd.estimate, low: rdd.estimate - 1.96 * rdd.se, high: rdd.estimate + 1.96 * rdd.se });
    if (propensityScore && methodAllowed(executableMethods, "propensity_score")) rows.push({ label: "IPW (ATE)", estimate: propensityScore.ate, low: propensityScore.ciLower, high: propensityScore.ciUpper });
    if (quantileRegression && methodAllowed(executableMethods, "quantile_regression")) {
      const median = quantileRegression.estimates.find(e => Math.abs(e.tau - 0.5) < 1e-6);
      if (median) rows.push({ label: "Median regression (tau = 0.5)", estimate: median.slope, low: median.ciLower, high: median.ciUpper });
    }
    const valid = rows.filter(row => [row.estimate, row.low, row.high].every(Number.isFinite));
    const hasForest = charts.some(c => c.name === "coefficient_forest_plot");
    if (valid.length >= 2 || (valid.length === 1 && !hasForest)) {
      const effectOf = robustOls?.xCol || hints.primaryTreatmentCol || hints.primaryRegressorCol || "the primary regressor";
      const scale = coefficientDisplayScale(ds, effectOf, valid.map(row => row.estimate));
      for (const row of valid) {
        row.estimate *= scale;
        row.low *= scale;
        row.high *= scale;
      }
      const unitNote = scale > 1 ? ` per ${formatCount(scale)} units of ${displayName(effectOf, 24)}` : "";
      push({
        name: "coefficient_interval_plot",
        description: "Estimated effect of the primary regressor across estimators with 95% confidence intervals",
        caption: `Estimated coefficient on ${displayName(effectOf)}${unitNote} for ${displayName(hints.primaryOutcomeCol || outcomeCol || "the outcome")} across ${valid.length} estimator${valid.length > 1 ? "s" : ""}. Points are point estimates and horizontal lines 95% confidence intervals. Estimators identify different estimands (conditional association, within-unit, local or weighted effects), so differences reflect design as well as sampling variation.`,
        section: "main",
        height: Math.max(320, Math.min(600, 160 + valid.length * 48)),
        config: {
          type: "forest",
          data: {
            labels: valid.map(row => row.label),
            datasets: [{ label: "Estimate", data: valid.map(row => ({ estimate: roundSig(row.estimate), low: roundSig(row.low), high: roundSig(row.high) })), borderColor: FIGURE_COLORS.violet }],
          },
          options: {
            referenceLines: [{ axis: "x", value: 0 }],
            plugins: { title: { display: true, text: `Effect of ${displayName(effectOf, 30)} across estimators` } },
            scales: { x: { title: { display: true, text: `Coefficient${scale > 1 ? ` per ${formatCount(scale)} units` : ""} (units of ${displayName(hints.primaryOutcomeCol || outcomeCol || "outcome", 24)})` } } },
          },
        },
      });
    }
  }

  // ---------------------------------------------------------------- causal design figures
  if (diffInDiff && methodAllowed(executableMethods, "diff_in_diff")) {
    const startLabel = diffInDiff.series.find(point => point.relIndex === 0)?.label;
    push({
      name: "parallel_trends_plot",
      description: `Treated and control group means of ${diffInDiff.outcomeCol} around the treatment onset`,
      caption: `Mean ${displayName(diffInDiff.outcomeCol)} for treated and control units by ${displayName(diffInDiff.timeCol)}. The dashed vertical line marks the first treated period; similar pre-treatment slopes support the parallel-trends assumption behind the difference-in-differences estimate (${formatNumber(diffInDiff.estimate)}).`,
      section: "main",
      config: {
        type: "line",
        data: {
          labels: diffInDiff.series.map(point => point.label),
          datasets: [
            { label: "Treated", data: diffInDiff.series.map(point => roundSig(point.treatedMean)), borderColor: FIGURE_COLORS.primary },
            { label: "Control", data: diffInDiff.series.map(point => roundSig(point.controlMean)), borderColor: FIGURE_COLORS.secondary },
          ],
        },
        options: {
          referenceLines: startLabel ? [{ axis: "x", value: startLabel, label: "Treatment onset" }] : [],
          plugins: { title: { display: true, text: "Treated vs control means (parallel trends)" } },
          scales: { x: { title: { display: true, text: displayName(diffInDiff.timeCol) } }, y: { title: { display: true, text: `Mean ${displayName(diffInDiff.outcomeCol)}` } } },
        },
      },
    });
  }

  if (diffInDiff && methodAllowed(executableMethods, "event_study")) {
    const labels = diffInDiff.series.map(point => String(point.relIndex));
    push({
      name: "event_study_plot",
      description: `Event-study profile of ${diffInDiff.outcomeCol} relative to the pre-treatment baseline`,
      caption: `Event-study profile: treated-minus-control difference in mean ${displayName(diffInDiff.outcomeCol)} in each period relative to treatment onset, normalised to the pre-treatment baseline. Leads (negative periods) near zero are consistent with no anticipation or pre-trends.`,
      section: "main",
      config: {
        type: "line",
        data: {
          labels,
          datasets: [{ label: "Relative effect", data: diffInDiff.series.map(point => roundSig(point.effect)), borderColor: FIGURE_COLORS.tertiary }],
        },
        options: {
          referenceLines: [{ axis: "y", value: 0 }, ...(labels.includes("0") ? [{ axis: "x", value: "0", label: "Onset" }] : [])],
          plugins: { title: { display: true, text: "Event-study profile" } },
          scales: { x: { title: { display: true, text: "Periods relative to treatment" } }, y: { title: { display: true, text: "Difference vs baseline" } } },
        },
      },
    });
  }

  if (syntheticControl && methodAllowed(executableMethods, "synthetic_control")) {
    const onset = syntheticControl.series.find(point => point.relIndex === 0)?.label;
    const refs = onset ? [{ axis: "x", value: onset, label: "Treatment" }] : [];
    push({
      name: "synthetic_control_path",
      description: `Observed versus synthetic trajectory for ${syntheticControl.treatedUnit}`,
      caption: `Observed ${displayName(syntheticControl.outcomeCol)} for ${syntheticControl.treatedUnit} and its synthetic control built from ${syntheticControl.donorCount} donor units (pre-treatment RMSE = ${formatNumber(syntheticControl.preRmse)}).`,
      section: "main",
      config: {
        type: "line",
        data: {
          labels: syntheticControl.series.map(point => point.label),
          datasets: [
            { label: `Observed: ${syntheticControl.treatedUnit}`, data: syntheticControl.series.map(point => roundSig(point.treated)), borderColor: FIGURE_COLORS.primary },
            { label: "Synthetic control", data: syntheticControl.series.map(point => roundSig(point.synthetic)), borderColor: FIGURE_COLORS.accent, borderDash: [6, 4] },
          ],
        },
        options: {
          referenceLines: refs,
          plugins: { title: { display: true, text: "Synthetic control: observed vs synthetic" } },
          scales: { x: { title: { display: true, text: displayName(syntheticControl.timeCol) } }, y: { title: { display: true, text: displayName(syntheticControl.outcomeCol) } } },
        },
      },
    });
    push({
      name: "synthetic_control_gap",
      description: `Gap between ${syntheticControl.treatedUnit} and its synthetic control`,
      caption: `Difference between observed and synthetic ${displayName(syntheticControl.outcomeCol)} for ${syntheticControl.treatedUnit}; the mean post-treatment gap is ${formatNumber(syntheticControl.attPostMean)}.`,
      section: "diagnostic",
      config: {
        type: "line",
        data: {
          labels: syntheticControl.series.map(point => point.label),
          datasets: [{ label: "Gap", data: syntheticControl.series.map(point => roundSig(point.gap)), borderColor: FIGURE_COLORS.tertiary }],
        },
        options: {
          referenceLines: [{ axis: "y", value: 0 }, ...refs],
          plugins: { title: { display: true, text: "Synthetic control gap" } },
          scales: { x: { title: { display: true, text: displayName(syntheticControl.timeCol) } }, y: { title: { display: true, text: "Observed - synthetic" } } },
        },
      },
    });
    const topWeights = syntheticControl.weights.filter(item => item.weight > 0.001).slice(0, 10);
    if (topWeights.length > 0) {
      push({
        name: "synthetic_control_weights",
        description: `Donor weights for the synthetic control of ${syntheticControl.treatedUnit}`,
        caption: `Donor-unit weights defining the synthetic control for ${syntheticControl.treatedUnit} (weights are non-negative and sum to one; units with weight < 0.001 omitted).`,
        section: "diagnostic",
        height: Math.max(320, Math.min(600, 150 + topWeights.length * 34)),
        config: {
          type: "bar",
          data: { labels: topWeights.map(item => item.unit), datasets: [{ label: "Weight", data: topWeights.map(item => Math.round(item.weight * 1000) / 1000), backgroundColor: FIGURE_COLORS.quaternary }] },
          options: {
            indexAxis: "y",
            plugins: { title: { display: true, text: "Synthetic control donor weights" }, valueLabels: { decimals: 3 } },
            scales: { x: { min: 0, title: { display: true, text: "Weight" } }, y: { title: { display: true, text: "Donor unit" } } },
          },
        },
      });
    }
  }

  if (syntheticControlPlacebos && methodAllowed(executableMethods, "synthetic_control")) {
    const placeboBars = syntheticControlPlacebos.ratios.slice().sort((a, b) => b.ratio - a.ratio).slice(0, 12);
    push({
      name: "synthetic_control_placebo_rmspe",
      description: `Placebo post/pre RMSPE ratios around ${syntheticControlPlacebos.treatedUnit}`,
      caption: `Post- to pre-treatment RMSPE ratios from in-space placebo tests; the treated unit (${syntheticControlPlacebos.treatedUnit}, highlighted) ranks ${syntheticControlPlacebos.actualRank} of ${syntheticControlPlacebos.ratios.length}.`,
      section: "diagnostic",
      height: Math.max(320, Math.min(620, 150 + placeboBars.length * 32)),
      config: {
        type: "bar",
        data: {
          labels: placeboBars.map(item => item.unit),
          datasets: [{ label: "Post / pre RMSPE", data: placeboBars.map(item => Math.round(item.ratio * 1000) / 1000), backgroundColor: placeboBars.map(item => (item.isActual ? FIGURE_COLORS.accent : FIGURE_COLORS.neutral)) }],
        },
        options: {
          indexAxis: "y",
          plugins: { title: { display: true, text: "Placebo RMSPE ratios" } },
          scales: { x: { title: { display: true, text: "Post / pre RMSPE ratio" } }, y: { title: { display: true, text: "Unit" } } },
        },
      },
    });
  }

  if (iv2Sls && methodAllowed(executableMethods, "iv_2sls")) {
    const firstStageLine = regressionStatsFromPairs(iv2Sls.firstStagePoints.map(point => [point.x, point.y] as [number, number]));
    if (firstStageLine) {
      const xs = iv2Sls.firstStagePoints.map(point => point.x);
      const xMin = Math.min(...xs);
      const xMax = Math.max(...xs);
      push({
        name: "iv_first_stage_plot",
        description: `First-stage relevance of instrument ${iv2Sls.zCol} for ${iv2Sls.xCol}`,
        caption: `First stage of the IV design: ${displayName(iv2Sls.xCol)} against the instrument ${displayName(iv2Sls.zCol)} with the least-squares fit (first-stage F = ${formatNumber(iv2Sls.firstStageF)}; values above 10 indicate a strong instrument).`,
        section: "diagnostic",
        config: {
          type: "scatter",
          data: {
            datasets: [
              { label: "Observations", data: iv2Sls.firstStagePoints.slice(0, 1500), backgroundColor: FIGURE_COLORS.primary },
              { label: "First-stage fit", data: [{ x: xMin, y: firstStageLine.intercept + firstStageLine.slope * xMin }, { x: xMax, y: firstStageLine.intercept + firstStageLine.slope * xMax }], showLine: true, pointRadius: 0, borderColor: FIGURE_COLORS.accent },
            ],
          },
          options: {
            plugins: { title: { display: true, text: "IV first stage" }, subtitle: { text: `First-stage F = ${formatNumber(iv2Sls.firstStageF)}` } },
            scales: { x: { title: { display: true, text: displayName(iv2Sls.zCol) } }, y: { title: { display: true, text: displayName(iv2Sls.xCol) } } },
          },
        },
      });
    }
  }

  if (rdd && methodAllowed(executableMethods, "regression_discontinuity")) {
    const leftBins = rdd.bins.filter(point => point.side === "left").map(point => ({ x: point.x, y: point.y }));
    const rightBins = rdd.bins.filter(point => point.side === "right").map(point => ({ x: point.x, y: point.y }));
    const fitLeft = rdd.fitLine.filter(point => point.side === "left").map(point => ({ x: point.x, y: point.y }));
    const fitRight = rdd.fitLine.filter(point => point.side === "right").map(point => ({ x: point.x, y: point.y }));
    push({
      name: "rdd_plot",
      description: `Regression-discontinuity plot for ${rdd.outcomeCol} at cutoff ${formatNumber(rdd.cutoff)}`,
      caption: `Binned means of ${displayName(rdd.outcomeCol)} against the running variable ${displayName(rdd.runningCol)} with separate local-linear fits on each side of the cutoff (${formatNumber(rdd.cutoff)}, bandwidth ${formatNumber(rdd.bandwidth)}). The estimated discontinuity is ${formatNumber(rdd.estimate)} (SE ${formatNumber(rdd.se)}).`,
      section: "main",
      config: {
        type: "scatter",
        data: {
          datasets: [
            { label: "Below cutoff (binned means)", data: leftBins, backgroundColor: FIGURE_COLORS.primary, pointRadius: 4 },
            { label: "Above cutoff (binned means)", data: rightBins, backgroundColor: FIGURE_COLORS.secondary, pointRadius: 4 },
            { label: "Local linear fit", data: fitLeft, showLine: true, pointRadius: 0, borderColor: FIGURE_COLORS.primary },
            { label: "Local linear fit (right)", data: fitRight, showLine: true, pointRadius: 0, borderColor: FIGURE_COLORS.secondary, hideInLegend: true },
          ],
        },
        options: {
          referenceLines: [{ axis: "x", value: rdd.cutoff, label: "Cutoff" }],
          plugins: { title: { display: true, text: "Regression discontinuity" } },
          scales: { x: { title: { display: true, text: displayName(rdd.runningCol) } }, y: { title: { display: true, text: displayName(rdd.outcomeCol) } } },
        },
      },
    });
  }

  if (propensityScore && methodAllowed(executableMethods, "propensity_score")) {
    const binCount = 10;
    const treatedBins = Array(binCount).fill(0);
    const controlBins = Array(binCount).fill(0);
    for (const row of propensityScore.scoreRows) {
      const index = Math.min(binCount - 1, Math.max(0, Math.floor(row.score * binCount)));
      if (row.treatment === 1) treatedBins[index]++;
      else controlBins[index]++;
    }
    const treatedTotal = treatedBins.reduce((a, b) => a + b, 0) || 1;
    const controlTotal = controlBins.reduce((a, b) => a + b, 0) || 1;
    const labels = Array.from({ length: binCount }, (_, index) => `${(index / binCount).toFixed(1)}-${((index + 1) / binCount).toFixed(1)}`);
    push({
      name: "propensity_overlap_plot",
      description: `Propensity-score overlap for ${propensityScore.treatmentCol}`,
      caption: `Distribution of estimated propensity scores for treated and control units (share of each group per score bin). Substantial overlap across bins supports the common-support assumption required for inverse-probability weighting.`,
      section: "diagnostic",
      config: {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "Treated", data: treatedBins.map(c => Math.round((c / treatedTotal) * 1000) / 10), backgroundColor: FIGURE_COLORS.primary },
            { label: "Control", data: controlBins.map(c => Math.round((c / controlTotal) * 1000) / 10), backgroundColor: FIGURE_COLORS.secondary },
          ],
        },
        options: {
          plugins: { title: { display: true, text: "Propensity score overlap" } },
          scales: { x: { title: { display: true, text: "Estimated propensity score" } }, y: { title: { display: true, text: "Share of group (%)" } } },
        },
      },
    });

    const topBalance = propensityScore.balance.slice().sort((a, b) => Math.abs(b.smdBefore) - Math.abs(a.smdBefore)).slice(0, 12);
    if (topBalance.length > 0) {
      push({
        name: "love_plot",
        description: "Covariate balance before and after inverse-probability weighting",
        caption: "Absolute standardised mean differences between treated and control units before and after inverse-probability weighting; values below 0.1 (dashed line) are conventionally regarded as balanced.",
        section: "diagnostic",
        height: Math.max(340, Math.min(640, 160 + topBalance.length * 40)),
        config: {
          type: "forest",
          data: {
            labels: topBalance.map(item => item.covariate),
            datasets: [
              { label: "Before weighting", data: topBalance.map(item => Math.round(Math.abs(item.smdBefore) * 1000) / 1000), borderColor: FIGURE_COLORS.accent },
              { label: "After weighting", data: topBalance.map(item => Math.round(Math.abs(item.smdAfter) * 1000) / 1000), borderColor: FIGURE_COLORS.tertiary },
            ],
          },
          options: {
            referenceLines: [{ axis: "x", value: 0.1, label: "0.1" }],
            plugins: { title: { display: true, text: "Covariate balance (love plot)" } },
            scales: { x: { min: 0, title: { display: true, text: "|Standardised mean difference|" } } },
          },
        },
      });
    }
  }

  if (quantileRegression && methodAllowed(executableMethods, "quantile_regression")) {
    const qScale = coefficientDisplayScale(ds, quantileRegression.xCol, quantileRegression.estimates.map(estimate => estimate.slope));
    const refs: Array<{ axis: "x" | "y"; value: number; label?: string }> = robustOls && robustOls.xCol === quantileRegression.xCol && robustOls.yCol === quantileRegression.yCol
      ? [{ axis: "y", value: roundSig(robustOls.slope * qScale), label: "OLS estimate" }]
      : [{ axis: "y", value: 0 }];
    push({
      name: "quantile_regression_profile",
      description: `Quantile-regression slope profile for ${quantileRegression.yCol}`,
      caption: `Coefficient on ${displayName(quantileRegression.xCol)} across conditional quantiles of ${displayName(quantileRegression.yCol)} (n = ${formatCount(quantileRegression.n)}); the shaded band is the bootstrap 95% confidence interval${refs[0].label ? " and the dashed line the OLS (mean) estimate" : ""}.`,
      section: "main",
      config: {
        type: "line",
        data: {
          labels: quantileRegression.estimates.map(estimate => estimate.tau.toFixed(2)),
          datasets: [{
            label: `Slope on ${displayName(quantileRegression.xCol, 24)}`,
            data: quantileRegression.estimates.map(estimate => roundSig(estimate.slope * qScale)),
            ciLower: quantileRegression.estimates.map(estimate => roundSig(estimate.ciLower * qScale)),
            ciUpper: quantileRegression.estimates.map(estimate => roundSig(estimate.ciUpper * qScale)),
            borderColor: FIGURE_COLORS.tertiary,
          }],
        },
        options: {
          referenceLines: refs,
          plugins: { title: { display: true, text: "Quantile regression coefficient profile" } },
          scales: { x: { title: { display: true, text: "Quantile (tau)" } }, y: { title: { display: true, text: qScale > 1 ? `Coefficient per ${formatCount(qScale)} units` : "Coefficient" } } },
        },
      },
    });
  }

  // ---------------------------------------------------------------- diagnostics
  if (robustOls && methodAllowed(executableMethods, "robust_ols")) {
    const residualPoints = robustOls.fittedResiduals.slice(0, 1500).map(point => ({
      x: roundSig(point.fitted),
      y: roundSig(point.residual),
    }));
    if (residualPoints.length >= 12) {
      push({
        name: "residual_fitted_plot",
        description: `Residuals versus fitted values for the OLS model of ${robustOls.yCol}`,
        caption: `Residuals against fitted values from the OLS model of ${displayName(robustOls.yCol)}. A patternless band around zero supports linearity; funnel shapes indicate heteroskedasticity (addressed with robust standard errors).`,
        section: "diagnostic",
        config: {
          type: "scatter",
          data: { datasets: [{ label: "Residuals", data: residualPoints, backgroundColor: FIGURE_COLORS.primary, pointRadius: residualPoints.length > 600 ? 2.2 : 3 }] },
          options: {
            referenceLines: [{ axis: "y", value: 0 }],
            plugins: { title: { display: true, text: "Residuals vs fitted values" } },
            scales: { x: { title: { display: true, text: "Fitted value" } }, y: { title: { display: true, text: "Residual" } } },
          },
        },
      });
    }
  }

  if (methodAllowed(executableMethods, "descriptive_statistics")) {
    const missingRows = ds.columns
      .map(col => {
        let missing = 0;
        for (const row of ds.data) if (isMissingValue(row[col])) missing++;
        return { col, pct: (missing / Math.max(1, ds.data.length)) * 100 };
      })
      .filter(item => item.pct > 0)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 15);
    if (missingRows.length > 0 && missingRows[0].pct >= 1) {
      push({
        name: "missing_data_profile",
        description: "Share of missing values by variable",
        caption: `Percentage of missing values for the ${missingRows.length} variables with incomplete data (N = ${formatCount(ds.data.length)} rows analysed). Missing data are handled by ${bundle.missingDataMode === "mean_imputation" ? "mean imputation of predictors" : "complete-case analysis"} in the regression models.`,
        section: "diagnostic",
        height: Math.max(320, Math.min(620, 150 + missingRows.length * 30)),
        config: {
          type: "bar",
          data: { labels: missingRows.map(item => item.col), datasets: [{ label: "Missing (%)", data: missingRows.map(item => Math.round(item.pct * 10) / 10), backgroundColor: FIGURE_COLORS.neutral }] },
          options: {
            indexAxis: "y",
            plugins: { title: { display: true, text: "Missing data by variable" }, valueLabels: { decimals: 1, suffix: "%" } },
            scales: { x: { min: 0, title: { display: true, text: "Missing values (%)" } }, y: { title: { display: true, text: "Variable" } } },
          },
        },
      });
    }
  }

  // ---------------------------------------------------------------- cross-tab composition
  if (groupCol && methodAllowed(executableMethods, "descriptive_statistics")) {
    const secondCol = chooseGroupingColumn(ds, bundle, [groupCol], analysisTopic);
    if (secondCol && secondCol !== groupCol) {
      const rowLevels = Array.from(categoryCounts(ds, groupCol).entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
      const segLevels = Array.from(categoryCounts(ds, secondCol).entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
      if (rowLevels.length >= 2 && segLevels.length >= 2) {
        const table = new Map<string, Map<string, number>>();
        for (const row of ds.data) {
          const a = categoryKey(row[groupCol]);
          const b = categoryKey(row[secondCol]);
          if (a === null || b === null || !rowLevels.includes(a) || !segLevels.includes(b)) continue;
          const inner = table.get(a) || new Map<string, number>();
          inner.set(b, (inner.get(b) || 0) + 1);
          table.set(a, inner);
        }
        const totals = rowLevels.map(level => Array.from(table.get(level)?.values() || []).reduce((s, v) => s + v, 0));
        if (totals.every(total => total > 0)) {
          push({
            name: "composition_stacked_bar",
            description: `Composition of ${secondCol} within each level of ${groupCol}`,
            caption: `Distribution of ${displayName(secondCol)} within each category of ${displayName(groupCol)} (row percentages; each bar sums to 100%).`,
            section: "descriptive",
            height: Math.max(340, Math.min(620, 170 + rowLevels.length * 36)),
            config: {
              type: "bar",
              data: {
                labels: rowLevels,
                datasets: segLevels.map((segment, index) => ({
                  label: `${displayName(secondCol, 18)} = ${segment}`,
                  data: rowLevels.map((level, i) => Math.round(((table.get(level)?.get(segment) || 0) / totals[i]) * 1000) / 10),
                  backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length],
                })),
              },
              options: {
                indexAxis: "y",
                plugins: { title: { display: true, text: `${displayName(secondCol)} by ${displayName(groupCol)}` } },
                scales: { x: { stacked: true, min: 0, max: 100, title: { display: true, text: "Row percentage (%)" } }, y: { stacked: true, title: { display: true, text: displayName(groupCol) } } },
              },
            },
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- text features
  if (methodAllowed(executableMethods, "text_feature_analysis")) {
    const textCol = detectTextColumns(ds)[0];
    if (textCol) {
      const texts = ds.data.map(row => row[textCol]).filter(v => typeof v === "string") as string[];
      const terms = topTerms(texts, 15);
      if (terms.length >= 5) {
        push({
          name: "text_top_terms",
          description: `Most frequent terms in ${textCol}`,
          caption: `Fifteen most frequent terms in ${displayName(textCol)} across ${formatCount(texts.length)} documents (lower-cased tokens of three or more letters; common stop words removed).`,
          section: "descriptive",
          height: 560,
          config: {
            type: "bar",
            data: { labels: terms.map(([term]) => term), datasets: [{ label: "Frequency", data: terms.map(([, count]) => count), backgroundColor: FIGURE_COLORS.primary }] },
            options: {
              indexAxis: "y",
              plugins: { title: { display: true, text: `Top terms in ${displayName(textCol)}` } },
              scales: { x: { title: { display: true, text: "Frequency" } }, y: { title: { display: true, text: "Term" } } },
            },
          },
        });
      }
    }
  }

  // Order figures as they would appear in a paper and keep the set focused.
  const ordered = charts
    .map((chart, index) => ({ chart, index }))
    .sort((a, b) => SECTION_ORDER[a.chart.section || "main"] - SECTION_ORDER[b.chart.section || "main"] || a.index - b.index)
    .map(item => item.chart);
  if (ordered.length <= MAX_FIGURES) return ordered;
  // Drop the lowest-priority diagnostics/descriptives first, keeping main results.
  const dropOrder = ["composition_stacked_bar", "text_top_terms", "missing_data_profile", "synthetic_control_weights", "residual_fitted_plot", "category_distribution", "synthetic_control_gap", "box_plot"];
  let result = ordered;
  for (const name of dropOrder) {
    if (result.length <= MAX_FIGURES) break;
    result = result.filter(chart => chart.name !== name);
  }
  return result.slice(0, MAX_FIGURES);
}

function buildRoutingDiagnostics(
  datasets: ParsedDataset[],
  metrics: Record<string, number | string>,
  charts: { name: string }[],
  tables: { name: string }[],
  executableMethods: Set<string> | null,
  methodContract?: MethodFeasibilityContractInput | null
): {
  executedMethods: string[];
  blockedMethods: string[];
  unresolvedPrerequisites: string[];
  skippedExecutableMethods: string[];
  noOutputReasons: string[];
} {
  const executedMethods: string[] = [];
  const metricKeys = Object.keys(metrics);
  if (metricKeys.some(k => k.startsWith("mean_") || k.startsWith("std_") || k.startsWith("median_"))) executedMethods.push("descriptive_statistics");
  if (metricKeys.some(k => k.startsWith("strongest_correlation_"))) executedMethods.push("correlation");
  if (metricKeys.some(k => k.startsWith("regression_"))) executedMethods.push("linear_regression");
  if (metricKeys.some(k => k.startsWith("robust_ols_"))) executedMethods.push("robust_ols");
  if (metricKeys.some(k => k.startsWith("anova_"))) executedMethods.push("group_comparison");
  if (metricKeys.some(k => k.startsWith("time_trend_"))) executedMethods.push("time_trend");
  if (metricKeys.some(k => k.startsWith("text_") || k.startsWith("top_term_"))) executedMethods.push("text_feature_analysis");
  if (metricKeys.some(k => k.startsWith("panel_fe_beta_") || k.startsWith("panel_fe_within_r2_") || k.startsWith("panel_fe_sample_size_"))) executedMethods.push("panel_fixed_effects");
  if (metricKeys.some(k => k.startsWith("did_"))) executedMethods.push("diff_in_diff");
  if (metricKeys.some(k => k.startsWith("event_study_"))) executedMethods.push("event_study");
  if (metricKeys.some(k => k.startsWith("synthetic_control_"))) executedMethods.push("synthetic_control");
  if (metricKeys.some(k => k.startsWith("iv_2sls_"))) executedMethods.push("iv_2sls");
  if (metricKeys.some(k => k.startsWith("rdd_"))) executedMethods.push("regression_discontinuity");
  if (metricKeys.some(k => k.startsWith("propensity_score_"))) executedMethods.push("propensity_score");
  if (metricKeys.some(k => k.startsWith("quantile_regression_"))) executedMethods.push("quantile_regression");
  if (charts.length > 0) executedMethods.push("data_visualisation");

  const executedSet = new Set(executedMethods.map(normaliseMethodId));
  const blockedMethods = Array.from(
    new Set([
      ...(methodContract?.requiresMissingData || []),
      ...(methodContract?.futureWorkOnly || []),
    ].map(normaliseMethodId).filter(Boolean))
  );

  const unresolvedPrerequisites: string[] = [];
  const allCols = datasets.flatMap(ds => ds.columns || []).map(c => c.toLowerCase());
  const hasTimeLike = allCols.some(c => /(year|month|date|time|wave|period|quarter)/i.test(c));
  const hasTextLike = allCols.some(c => /(text|comment|abstract|title|description|review|note|content|summary)/i.test(c));
  const hasGraphLike = allCols.some(c => /(node|edge|source|target|network|graph)/i.test(c));
  const hasImageLike = allCols.some(c => /(image|img|pixel|vision|frame|video|path)/i.test(c));
  const hasPanelLike = hasTimeLike && allCols.some(c => /(id|code|entity|respondent|household|firm|user|patient)/i.test(c));

  if (blockedMethods.includes("advanced_nlp") && !hasTextLike) unresolvedPrerequisites.push("advanced_nlp: text columns not detected");
  if (blockedMethods.includes("advanced_time_series") && !hasTimeLike) unresolvedPrerequisites.push("advanced_time_series: time index not detected");
  if (blockedMethods.includes("panel_econometrics") && !hasPanelLike) unresolvedPrerequisites.push("panel_econometrics: panel identifiers/time pairing not detected");
  if (blockedMethods.includes("panel_fixed_effects") && !hasPanelLike) unresolvedPrerequisites.push("panel_fixed_effects: panel identifiers/time pairing not detected");
  if (blockedMethods.includes("graph_modelling") && !hasGraphLike) unresolvedPrerequisites.push("graph_modelling: graph edge/node structure not detected");
  if (blockedMethods.includes("vision_analysis") && !hasImageLike) unresolvedPrerequisites.push("vision_analysis: image/path features not detected");
  if (blockedMethods.includes("causal_inference")) unresolvedPrerequisites.push("causal_inference: identification assumptions not met");
  if (blockedMethods.includes("diff_in_diff")) unresolvedPrerequisites.push("diff_in_diff: treatment/outcome/time structure not detected");
  if (blockedMethods.includes("event_study")) unresolvedPrerequisites.push("event_study: dynamic treatment timing support not detected");
  if (blockedMethods.includes("synthetic_control")) unresolvedPrerequisites.push("synthetic_control: treated unit or donor pool not detected");
  if (blockedMethods.includes("iv_2sls")) unresolvedPrerequisites.push("iv_2sls: instrument field not detected");
  if (blockedMethods.includes("regression_discontinuity")) unresolvedPrerequisites.push("regression_discontinuity: running variable/cutoff not detected");
  if (blockedMethods.includes("propensity_score")) unresolvedPrerequisites.push("propensity_score: treatment/covariate overlap structure not detected");
  if (typeof metrics.analysis_inputs_missing_columns === "string" && metrics.analysis_inputs_missing_columns.trim()) {
    unresolvedPrerequisites.push(`analysis_inputs: requested columns missing (${metrics.analysis_inputs_missing_columns})`);
  }

  const requested = executableMethods ? Array.from(executableMethods) : [];
  const panelFeRequested = requested.some(methodId => normaliseMethodId(methodId) === "panel_fixed_effects");
  if (panelFeRequested && metrics.panel_fe_gate_status === "blocked") {
    unresolvedPrerequisites.push(`panel_fixed_effects: ${String(metrics.panel_fe_gate_reason || "failed diagnostics")}`);
  }
  const skippedExecutableMethods = requested.filter(m => !executedSet.has(normaliseMethodId(m)));
  const noOutputReasons: string[] = [];
  if (skippedExecutableMethods.length > 0) {
    noOutputReasons.push(`Executable methods without observed outputs: ${skippedExecutableMethods.join(", ")}`);
  }
  if (panelFeRequested && metrics.panel_fe_gate_status === "blocked") {
    noOutputReasons.push(`Panel fixed effects skipped: ${String(metrics.panel_fe_gate_reason || "failed diagnostics")}`);
  }
  if (charts.length === 0) noOutputReasons.push("No charts were generated from executable methods.");
  if (tables.length === 0) noOutputReasons.push("No tables were generated from executable methods.");
  if (metricKeys.length === 0) noOutputReasons.push("No metrics were generated from executable methods.");

  return {
    executedMethods: Array.from(new Set(executedMethods.map(normaliseMethodId))).filter(Boolean),
    blockedMethods,
    unresolvedPrerequisites,
    skippedExecutableMethods,
    noOutputReasons,
  };
}

function tableNumber(value: number): number | string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1e7) return Number(value.toPrecision(6));
  if (abs >= 1000) return Math.round(value * 10) / 10;
  if (abs >= 1) return Math.round(value * 1000) / 1000;
  return Math.round(value * 10000) / 10000;
}

function formatCoefficient(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs === 0) return "0.000";
  if (abs >= 1e5 || abs < 0.0005) return value.toExponential(2);
  if (abs >= 100) return value.toFixed(1);
  return value.toFixed(3);
}

interface RegressionModelColumn {
  title: string;
  coefficients: Map<string, { coef: number; se: number; p: number }>;
  n: number;
  r2: number;
  r2Label: string;
  adjR2?: number;
  fixedEffects: string;
  seType: string;
}

function coefficientMapFromEstimates(estimates: RegressionCoefficientEstimate[]): Map<string, { coef: number; se: number; p: number }> {
  const map = new Map<string, { coef: number; se: number; p: number }>();
  for (const estimate of estimates) {
    map.set(estimate.name, { coef: estimate.coefficient, se: estimate.se, p: estimate.pValue });
  }
  return map;
}

/** Power-of-ten scale that brings very small coefficients on large-unit variables into a readable range. */
function coefficientDisplayScale(ds: ParsedDataset, column: string, coefficients: Array<number | undefined>): number {
  const finite = coefficients.filter((c): c is number => c !== undefined && Number.isFinite(c) && c !== 0);
  if (finite.length === 0) return 1;
  const largest = Math.max(...finite.map(c => Math.abs(c)));
  if (largest >= 0.01) return 1;
  const sd = columnStandardDeviation(ds, column);
  if (!(sd >= 100)) return 1;
  const scale = Math.pow(10, Math.floor(Math.log10(sd)));
  return scale > 1 ? scale : 1;
}

function describeSeType(vcovType: "hc1" | "cluster", clusterCol?: string, clusterCount?: number): string {
  if (vcovType === "cluster") return `Clustered by ${displayName(clusterCol || "entity", 20)}${clusterCount ? ` (${clusterCount})` : ""}`;
  return "Robust (HC1)";
}

export function generateDefaultTables(
  allData: { name: string; data: Record<string, any>[]; columns: string[]; totalRows: number; fullDataProfile?: FullDataProfile }[],
  executableMethods: Set<string> | null,
  analysisTopic = "",
  analysisInputs?: AnalysisInputs,
  analysisBundle?: AnalysisComputationBundle | null,
): TableDefinition[] {
  const tables: TableDefinition[] = [];
  const bundle = resolveAnalysisComputationBundle(allData, analysisTopic, analysisInputs, executableMethods, analysisBundle);
  const ds = bundle?.ds || getPrimaryDataset(allData);
  if (!ds || ds.data.length === 0 || !bundle) return tables;

  const numericCols = bundle.meaningfulNumericCols || [];
  const outcomeCol = bundle.primaryDescriptiveCol;
  const designHints = bundle.designHints;
  const groupCol = chooseGroupingColumn(ds, bundle, [], analysisTopic);
  const { robustOls, panelFixedEffects, diffInDiff, syntheticControl, iv2Sls, rdd, propensityScore, quantileRegression } = bundle;

  // ---------------------------------------------------------------- variable roles (methods)
  {
    const causalOutputs = [
      panelFixedEffects ? "two-way fixed effects" : "",
      diffInDiff ? "difference-in-differences / event study" : "",
      syntheticControl ? "synthetic control" : "",
      iv2Sls ? "IV / 2SLS" : "",
      rdd ? "regression discontinuity" : "",
      propensityScore ? "inverse-probability weighting" : "",
    ].filter(Boolean).join(", ") || "None (estimates are associational)";
    tables.push({
      name: "analysis_design_diagnostics",
      description: "Variable roles and identification designs used in the empirical analysis",
      section: "methods",
      headers: ["Role", "Variable", "Notes"],
      rows: [
        ["Outcome", designHints.primaryOutcomeCol || "Not identified", "Dependent variable in all models"],
        ["Key explanatory variable", designHints.primaryTreatmentCol || designHints.primaryRegressorCol || "Not identified", designHints.primaryTreatmentCol ? "Treatment / exposure indicator" : "Primary regressor"],
        ["Controls", designHints.controlCols.length > 0 ? designHints.controlCols.join(", ") : "None", [
          designHints.controlsAutoSelected ? "Selected automatically (plausible covariates; no controls were specified)" : "As specified",
          "categorical controls enter as indicators against the most frequent level",
          robustOls?.omittedControlCols.length ? `omitted (unusable or collinear): ${robustOls.omittedControlCols.join(", ")}` : "",
        ].filter(Boolean).join("; ")],
        ["Unit / cluster identifier", designHints.primaryEntityCol || "None", designHints.primaryEntityCol ? "Repeated units; used for clustered standard errors and fixed effects" : "No repeated unit identifier detected"],
        ["Time variable", designHints.primaryTimeCol || "None", "Used for trends and time fixed effects"],
        ["Grouping variable", groupCol || "None", "Used for subgroup comparisons"],
        ["Missing-data handling", bundle.missingDataMode === "mean_imputation" ? "Mean imputation (predictors)" : "Complete-case", "Applied to regression samples"],
        ["Feasible causal designs", causalOutputs, "Designs whose data requirements were met"],
        ...(designHints.specifiedInputMissing.length > 0
          ? [["Requested but unavailable", designHints.specifiedInputMissing.join("; "), "Not found in the data; not substituted"]]
          : []),
      ],
    });
  }

  // ---------------------------------------------------------------- descriptive statistics
  if (numericCols.length > 0 && methodAllowed(executableMethods, "descriptive_statistics")) {
    const headers = ["Variable", "N", "Mean", "SD", "Min", "P25", "Median", "P75", "Max"];
    const rows: (string | number)[][] = [];
    const binaryVars: string[] = [];
    for (const col of numericCols.slice(0, 15)) {
      const values = numericValuesOf(ds, col);
      const summary = summariseValues(values);
      const full = ds.fullDataProfile?.numeric[col];
      if (!summary && !full) continue;
      if (isBinaryLikeColumn(ds, col)) binaryVars.push(col);
      const n = full?.n || summary?.n || 0;
      const meanValue = full ? streamingMean(full) : summary!.mean;
      const sdValue = full ? streamingStdDev(full) : summary!.sd;
      rows.push([
        displayName(col, 40),
        n,
        tableNumber(meanValue),
        tableNumber(sdValue),
        tableNumber(full?.min ?? summary!.min),
        summary ? tableNumber(summary.q1) : "",
        summary ? tableNumber(summary.median) : "",
        summary ? tableNumber(summary.q3) : "",
        tableNumber(full?.max ?? summary!.max),
      ]);
    }
    if (rows.length > 0) {
      const notes = [
        "Statistics are computed over non-missing values of each variable.",
        ds.fullDataProfile?.scannedRows
          ? `N, mean, SD, minimum and maximum use all ${formatCount(ds.fullDataProfile.scannedRows)} rows; quartiles use the retained analysis sample of ${formatCount(ds.data.length)} rows.`
          : "",
        binaryVars.length > 0 ? `For binary (0/1) variables (${binaryVars.slice(0, 6).map(v => displayName(v, 24)).join(", ")}) the mean is the proportion of ones.` : "",
      ].filter(Boolean).join(" ");
      tables.push({
        name: "descriptive_statistics",
        description: `Summary statistics for the main numeric variables (N = ${formatCount(ds.totalRows)} observations)`,
        section: "descriptive",
        headers,
        rows,
        notes,
      });
    }
  }

  // ---------------------------------------------------------------- frequency table
  if (groupCol && (methodAllowed(executableMethods, "descriptive_statistics") || methodAllowed(executableMethods, "group_comparison"))) {
    const entries = Array.from(categoryCounts(ds, groupCol).entries()).sort((a, b) => b[1] - a[1]);
    if (entries.length >= 2) {
      const total = entries.reduce((sum, [, c]) => sum + c, 0);
      const top = entries.slice(0, 15);
      const rest = entries.slice(15).reduce((sum, [, c]) => sum + c, 0);
      if (rest > 0) top.push([`Other (${entries.length - 15} categories)`, rest]);
      let cumulative = 0;
      tables.push({
        name: "frequency_table",
        description: `Frequency distribution of ${displayName(groupCol)}`,
        section: "descriptive",
        headers: [displayName(groupCol, 30), "N", "Percent", "Cumulative percent"],
        rows: top.map(([key, count]) => {
          const pct = (count / total) * 100;
          cumulative += pct;
          return [key, count, `${pct.toFixed(1)}%`, `${Math.min(100, cumulative).toFixed(1)}%`];
        }),
        notes: `Total N = ${formatCount(total)} non-missing observations.`,
      });
    }
  }

  // ---------------------------------------------------------------- correlation matrix
  if (numericCols.length >= 2 && methodAllowed(executableMethods, "correlation")) {
    const cols = numericCols.filter(c => !isPathologicalNumericColumn(ds, c)).slice(0, 7);
    if (cols.length >= 2) {
      let minN = Infinity;
      let maxN = 0;
      const rows = cols.map((rowCol, i) => {
        const row: (string | number)[] = [`(${i + 1}) ${displayName(rowCol, 30)}`];
        for (let j = 0; j < cols.length; j++) {
          if (j > i) { row.push(""); continue; }
          if (j === i) { row.push("1"); continue; }
          const result = pearsonFromPairs(parseNumericPairs(ds, rowCol, cols[j]));
          if (!result) { row.push("NA"); continue; }
          minN = Math.min(minN, result.n);
          maxN = Math.max(maxN, result.n);
          row.push(`${result.r.toFixed(2)}${significanceStars(result.p)}`);
        }
        return row;
      });
      tables.push({
        name: "correlation_matrix",
        description: "Pairwise Pearson correlation coefficients",
        section: "descriptive",
        headers: ["Variable", ...cols.map((_, i) => `(${i + 1})`)],
        rows,
        notes: `Pearson correlations on pairwise-complete observations${Number.isFinite(minN) ? ` (n = ${formatCount(minN)}${maxN !== minN ? ` to ${formatCount(maxN)}` : ""})` : ""}. * p < 0.05, ** p < 0.01, *** p < 0.001 (two-sided t test).`,
      });
    }
  }

  // ---------------------------------------------------------------- group comparison
  if (outcomeCol && groupCol && groupCol !== outcomeCol && methodAllowed(executableMethods, "group_comparison")) {
    const grouped = groupNumericValues(ds, groupCol, outcomeCol);
    const kept = Array.from(grouped.entries()).filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 15);
    const keys = orderCategoryKeys(kept.map(([k]) => k), k => grouped.get(k)?.length || 0);
    if (keys.length >= 2) {
      const rows = keys.map(key => {
        const ci = meanConfidenceInterval(grouped.get(key)!)!;
        return [key, ci.n, tableNumber(ci.mean), tableNumber(ci.sd), `[${formatCoefficient(ci.low)}, ${formatCoefficient(ci.high)}]`];
      });
      const anova = oneWayAnova(keys.map(k => grouped.get(k)!));
      const welch = keys.length === 2 ? welchTTest(grouped.get(keys[0])!, grouped.get(keys[1])!) : null;
      const notes = [
        "95% confidence intervals for group means are based on the t distribution.",
        anova ? `One-way ANOVA: F(${anova.df1}, ${anova.df2}) = ${anova.f.toFixed(3)}, p ${formatPValue(anova.p).startsWith("<") ? formatPValue(anova.p) : `= ${formatPValue(anova.p)}`}, eta squared = ${anova.eta2.toFixed(3)}.` : "",
        welch ? `Welch two-sample t test (${keys[0]} minus ${keys[1]}): difference = ${formatCoefficient(welch.diff)}, t(${welch.df.toFixed(1)}) = ${welch.t.toFixed(3)}, p ${formatPValue(welch.p).startsWith("<") ? formatPValue(welch.p) : `= ${formatPValue(welch.p)}`}.` : "",
      ].filter(Boolean).join(" ");
      tables.push({
        name: "group_comparison",
        description: `${displayName(outcomeCol)} by ${displayName(groupCol)}: group means, dispersion and tests of equality`,
        section: "main",
        headers: [displayName(groupCol, 28), "N", "Mean", "SD", "95% CI"],
        rows,
        notes,
      });
    }
  }

  // ---------------------------------------------------------------- regression models
  const models: RegressionModelColumn[] = [];
  let regressionSampleNote = "";
  if (robustOls && methodAllowed(executableMethods, "robust_ols")) {
    const prepared = bundle.preparedRegression;
    if (prepared && robustOls.controlCols.length > 0) {
      const primaryIndex = prepared.regressorCols.indexOf(prepared.primaryRegressorCol);
      if (primaryIndex >= 0) {
        const bivariate = fitLinearModel(prepared.rows.map(row => ({ y: row.y, x: [row.x[primaryIndex]], clusterId: row.clusterId })));
        if (bivariate) {
          const names = ["intercept", prepared.primaryRegressorCol];
          models.push({
            title: "(1) OLS",
            coefficients: new Map(names.map((name, i) => [name, { coef: bivariate.coefficients[i], se: bivariate.standardErrors[i], p: bivariate.pValues[i] }])),
            n: bivariate.n,
            r2: bivariate.r2,
            r2Label: "R-squared",
            adjR2: bivariate.adjR2,
            fixedEffects: "No",
            seType: describeSeType(bivariate.vcovType, prepared.clusterCol, bivariate.clusterCount),
          });
        }
      }
    }
    models.push({
      title: `(${models.length + 1}) OLS${robustOls.controlCols.length ? " + controls" : ""}`,
      coefficients: coefficientMapFromEstimates(robustOls.coefficients),
      n: robustOls.n,
      r2: robustOls.r2,
      r2Label: "R-squared",
      adjR2: robustOls.adjR2,
      fixedEffects: "No",
      seType: describeSeType(robustOls.vcovType, robustOls.clusterCol, robustOls.clusterCount),
    });
    if (models.length === 2 && models[0].n === models[1].n) regressionSampleNote = `Columns (1) and (2) use the same estimation sample.`;
  }
  if (panelFixedEffects && methodAllowed(executableMethods, "panel_fixed_effects")) {
    models.push({
      title: `(${models.length + 1}) Two-way FE`,
      // The constant is not identified after the within transformation.
      coefficients: coefficientMapFromEstimates(panelFixedEffects.coefficients.filter(c => c.name !== "intercept")),
      n: panelFixedEffects.n,
      r2: panelFixedEffects.r2Within,
      r2Label: "Within R-squared",
      fixedEffects: `Unit + time (${panelFixedEffects.entities} units, ${panelFixedEffects.periods} periods)`,
      seType: describeSeType(panelFixedEffects.vcovType, panelFixedEffects.clusterCol, panelFixedEffects.clusterCount),
    });
  }
  if (models.length > 0) {
    const primary = robustOls?.xCol || panelFixedEffects?.xCol || "";
    const allNames = uniqueColumns(models.flatMap(model => Array.from(model.coefficients.keys())));
    const ordered = [
      ...allNames.filter(name => name === primary),
      ...allNames.filter(name => name !== primary && name !== "intercept"),
      ...allNames.filter(name => name === "intercept"),
    ];
    const rows: (string | number)[][] = [];
    const rescaled: string[] = [];
    for (const name of ordered) {
      // Report coefficients on large-unit regressors per a round number of units so the
      // table does not show values such as 0.0000098.
      const scale = name === "intercept" ? 1 : coefficientDisplayScale(ds, name, models.map(model => model.coefficients.get(name)?.coef));
      const label = name === "intercept" ? "Constant" : `${displayName(name, 34)}${scale > 1 ? ` (per ${formatCount(scale)})` : ""}`;
      if (scale > 1) rescaled.push(`${name} per ${formatCount(scale)} units`);
      rows.push([label, ...models.map(model => {
        const c = model.coefficients.get(name);
        return c ? `${formatCoefficient(c.coef * scale)}${significanceStars(c.p)}` : "";
      })]);
      rows.push(["", ...models.map(model => {
        const c = model.coefficients.get(name);
        return c ? `(${formatCoefficient(c.se * scale)})` : "";
      })]);
    }
    rows.push(["Fixed effects", ...models.map(model => model.fixedEffects)]);
    rows.push(["Standard errors", ...models.map(model => model.seType)]);
    rows.push(["Observations", ...models.map(model => formatCount(model.n))]);
    rows.push(["R-squared", ...models.map(model => `${model.r2.toFixed(3)}${model.r2Label === "Within R-squared" ? " (within)" : ""}`)]);
    if (models.some(model => model.adjR2 !== undefined)) {
      rows.push(["Adjusted R-squared", ...models.map(model => (model.adjR2 !== undefined ? model.adjR2.toFixed(3) : ""))]);
    }
    const outcome = robustOls?.yCol || panelFixedEffects?.yCol || "outcome";
    tables.push({
      name: "regression_results",
      description: `Regression estimates for ${displayName(outcome)}`,
      section: "main",
      headers: ["", ...models.map(model => model.title)],
      rows,
      notes: [
        `Dependent variable: ${outcome}. Coefficients with standard errors in parentheses. * p < 0.05, ** p < 0.01, *** p < 0.001.`,
        regressionSampleNote,
        rescaled.length ? `Coefficients rescaled for readability: ${rescaled.join("; ")}.` : "",
        bundle.missingDataMode === "mean_imputation" && robustOls?.imputedPredictorCells ? `${formatCount(robustOls.imputedPredictorCells)} missing predictor values were mean-imputed.` : "",
        !diffInDiff && !iv2Sls && !rdd && !propensityScore ? "Estimates are conditional associations and should not be interpreted causally without an identification strategy." : "",
      ].filter(Boolean).join(" "),
    });
  } else if (outcomeCol && numericCols.length >= 2 && methodAllowed(executableMethods, "linear_regression")) {
    const rows: (string | number)[][] = [];
    for (const xCol of numericCols.filter(c => c !== outcomeCol).slice(0, 8)) {
      const pairs = parseNumericPairs(ds, xCol, outcomeCol);
      const reg = regressionStatsFromPairs(pairs);
      if (!reg) continue;
      const meanX = pairs.reduce((a, p) => a + p[0], 0) / reg.n;
      let ssRes = 0;
      let ssX = 0;
      for (const [x, y] of pairs) {
        ssRes += (y - (reg.intercept + reg.slope * x)) ** 2;
        ssX += (x - meanX) ** 2;
      }
      const se = ssX > 0 && reg.n > 2 ? Math.sqrt(ssRes / (reg.n - 2) / ssX) : NaN;
      const t = se > 0 ? reg.slope / se : NaN;
      const p = studentTTwoTailPValue(t, reg.n - 2);
      rows.push([displayName(xCol, 34), `${formatCoefficient(reg.slope)}${significanceStars(p)}`, formatCoefficient(se), Number.isFinite(t) ? t.toFixed(2) : "", formatPValue(p), reg.r2.toFixed(3), formatCount(reg.n)]);
    }
    if (rows.length > 0) {
      tables.push({
        name: "regression_results",
        description: `Bivariate OLS regressions of ${displayName(outcomeCol)} on candidate explanatory variables`,
        section: "main",
        headers: ["Explanatory variable", "Coefficient", "SE", "t", "p-value", "R-squared", "N"],
        rows,
        notes: `Each row is a separate bivariate regression with ${outcomeCol} as the dependent variable (conventional OLS standard errors). * p < 0.05, ** p < 0.01, *** p < 0.001. Associations are unadjusted.`,
      });
    }
  }

  // ---------------------------------------------------------------- causal designs
  if (diffInDiff && methodAllowed(executableMethods, "diff_in_diff")) {
    const onset = diffInDiff.series.find(point => point.relIndex === 0)?.label ?? formatNumber(diffInDiff.treatmentStart);
    tables.push({
      name: "difference_in_differences",
      description: `Difference-in-differences summary for ${displayName(diffInDiff.outcomeCol)}`,
      section: "main",
      headers: ["Quantity", "Value"],
      rows: [
        ["Outcome", diffInDiff.outcomeCol],
        ["Treatment indicator", diffInDiff.treatmentCol],
        ["First treated period", onset],
        ["Treated group mean, pre-treatment", tableNumber(diffInDiff.treatedPre)],
        ["Treated group mean, post-treatment", tableNumber(diffInDiff.treatedPost)],
        ["Control group mean, pre-treatment", tableNumber(diffInDiff.controlPre)],
        ["Control group mean, post-treatment", tableNumber(diffInDiff.controlPost)],
        ["Difference-in-differences estimate", tableNumber(diffInDiff.estimate)],
        ["Pre-treatment trend difference", tableNumber(diffInDiff.preTrendDelta)],
        ["Observations", formatCount(diffInDiff.n)],
      ],
      notes: "Canonical 2 x 2 difference in group means: (treated post - treated pre) - (control post - control pre). A pre-treatment trend difference close to zero supports parallel trends.",
    });
  }

  if (iv2Sls && methodAllowed(executableMethods, "iv_2sls")) {
    tables.push({
      name: "iv_2sls_results",
      description: `Instrumental-variables (2SLS) estimates for ${displayName(iv2Sls.yCol)}`,
      section: "main",
      headers: ["Quantity", "Value"],
      rows: [
        ["Outcome", iv2Sls.yCol],
        ["Endogenous regressor", iv2Sls.xCol],
        ["Instrument", iv2Sls.zCol],
        ["2SLS coefficient", `${formatCoefficient(iv2Sls.beta)}${significanceStars(iv2Sls.pValue)}`],
        ["Standard error", formatCoefficient(iv2Sls.se)],
        ["95% confidence interval", `[${formatCoefficient(iv2Sls.ciLower)}, ${formatCoefficient(iv2Sls.ciUpper)}]`],
        ["p-value", formatPValue(iv2Sls.pValue)],
        ["First-stage coefficient", formatCoefficient(iv2Sls.firstStageSlope)],
        ["First-stage F statistic", iv2Sls.firstStageF.toFixed(2)],
        ["Reduced-form coefficient", formatCoefficient(iv2Sls.reducedFormSlope)],
        ["Observations", formatCount(iv2Sls.n)],
      ],
      notes: "Just-identified 2SLS. A first-stage F statistic below 10 indicates a weak instrument; the exclusion restriction cannot be tested with a single instrument. * p < 0.05, ** p < 0.01, *** p < 0.001.",
    });
  }

  if (rdd && methodAllowed(executableMethods, "regression_discontinuity")) {
    tables.push({
      name: "regression_discontinuity_results",
      description: `Regression-discontinuity estimate for ${displayName(rdd.outcomeCol)}`,
      section: "main",
      headers: ["Quantity", "Value"],
      rows: [
        ["Outcome", rdd.outcomeCol],
        ["Running variable", rdd.runningCol],
        ["Treatment variable", rdd.treatmentCol],
        ["Cutoff", tableNumber(rdd.cutoff)],
        ["Bandwidth", tableNumber(rdd.bandwidth)],
        ["Discontinuity estimate", `${formatCoefficient(rdd.estimate)}${significanceStars(rdd.pValue)}`],
        ["Standard error", formatCoefficient(rdd.se)],
        ["p-value", formatPValue(rdd.pValue)],
        ["Observations within bandwidth", formatCount(rdd.nLocal)],
        ["Observations left / right of cutoff", `${formatCount(rdd.leftN)} / ${formatCount(rdd.rightN)}`],
      ],
      notes: "Local-linear regression with separate slopes on each side of the cutoff. * p < 0.05, ** p < 0.01, *** p < 0.001.",
    });
  }

  if (propensityScore && methodAllowed(executableMethods, "propensity_score")) {
    tables.push({
      name: "propensity_score_balance",
      description: `Covariate balance before and after inverse-probability weighting (${displayName(propensityScore.treatmentCol)})`,
      section: "diagnostic",
      headers: ["Covariate", "Mean (treated)", "Mean (control)", "Weighted mean (treated)", "Weighted mean (control)", "SMD before", "SMD after"],
      rows: propensityScore.balance.map(item => ([
        displayName(item.covariate, 30),
        tableNumber(item.meanTreated),
        tableNumber(item.meanControl),
        tableNumber(item.weightedTreated),
        tableNumber(item.weightedControl),
        tableNumber(item.smdBefore),
        tableNumber(item.smdAfter),
      ])),
      notes: `SMD = standardised mean difference; |SMD| < 0.1 indicates adequate balance. IPW estimate of the average treatment effect on ${propensityScore.outcomeCol}: ${formatCoefficient(propensityScore.ate)} (SE ${formatCoefficient(propensityScore.se)}; 95% CI [${formatCoefficient(propensityScore.ciLower)}, ${formatCoefficient(propensityScore.ciUpper)}]; p ${formatPValue(propensityScore.pValue).startsWith("<") ? formatPValue(propensityScore.pValue) : `= ${formatPValue(propensityScore.pValue)}`}; n = ${formatCount(propensityScore.n)}).`,
    });
  }

  if (syntheticControl && methodAllowed(executableMethods, "synthetic_control")) {
    tables.push({
      name: "synthetic_control_weights",
      description: `Synthetic-control donor weights for ${syntheticControl.treatedUnit}`,
      section: "diagnostic",
      headers: ["Donor unit", "Weight"],
      rows: syntheticControl.weights.filter(item => item.weight > 0.001).slice(0, 12).map(item => [displayName(item.unit, 36), tableNumber(item.weight)]),
      notes: `Treated unit: ${syntheticControl.treatedUnit}; ${syntheticControl.donorCount} donor units. Pre-treatment RMSE = ${formatNumber(syntheticControl.preRmse)}, post-treatment RMSE = ${formatNumber(syntheticControl.postRmse)}, mean post-treatment gap = ${formatNumber(syntheticControl.attPostMean)}.`,
    });
  }

  if (quantileRegression && methodAllowed(executableMethods, "quantile_regression")) {
    const qScale = coefficientDisplayScale(ds, quantileRegression.xCol, quantileRegression.estimates.map(e => e.slope));
    tables.push({
      name: "quantile_regression_results",
      description: `Quantile-regression coefficients on ${displayName(quantileRegression.xCol)} for ${displayName(quantileRegression.yCol)}`,
      section: "main",
      headers: ["Quantile", qScale > 1 ? `Coefficient (per ${formatCount(qScale)})` : "Coefficient", "Bootstrap SE", "95% CI", "p-value", "Pseudo R1"],
      rows: quantileRegression.estimates.map(estimate => ([
        estimate.tau.toFixed(2),
        `${formatCoefficient(estimate.slope * qScale)}${significanceStars(estimate.pValue)}`,
        formatCoefficient(estimate.slopeSe * qScale),
        `[${formatCoefficient(estimate.ciLower * qScale)}, ${formatCoefficient(estimate.ciUpper * qScale)}]`,
        formatPValue(estimate.pValue),
        estimate.pseudoR1.toFixed(3),
      ])),
      notes: `Dependent variable: ${quantileRegression.yCol}; coefficient on ${quantileRegression.xCol}${quantileRegression.controlCols.length ? ` controlling for ${quantileRegression.controlCols.join(", ")}` : ""}. Bootstrap standard errors (${quantileRegression.estimates[0]?.bootstrapReplicates ?? 0} replications); n = ${formatCount(quantileRegression.n)}. * p < 0.05, ** p < 0.01, *** p < 0.001.`,
    });
  }

  // ---------------------------------------------------------------- appendix tables
  {
    const rows: (string | number)[][] = [];
    for (const col of ds.columns) {
      let missing = 0;
      let numericCount = 0;
      let nonMissing = 0;
      for (const row of ds.data) {
        const value = row[col];
        if (isMissingValue(value)) { missing++; continue; }
        nonMissing++;
        if (typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))) numericCount++;
      }
      if (missing === 0) continue;
      rows.push([
        displayName(col, 36),
        nonMissing > 0 && numericCount / nonMissing > 0.7 ? "Numeric" : "Categorical",
        missing,
        `${((missing / Math.max(1, ds.data.length)) * 100).toFixed(1)}%`,
      ]);
    }
    rows.sort((a, b) => Number(b[2]) - Number(a[2]));
    if (rows.length > 0) {
      tables.push({
        name: "missing_data_summary",
        description: "Variables with missing values",
        section: "appendix",
        headers: ["Variable", "Type", "Missing N", "Missing %"],
        rows: rows.slice(0, 30),
        notes: `Based on ${formatCount(ds.data.length)} analysed rows; ${ds.columns.length - rows.length} of ${ds.columns.length} variables have no missing values.`,
      });
    }
  }

  const methodAssessments = bundle.methodAssessments || [];
  if (methodAssessments.length > 0) {
    tables.push({
      name: "method_applicability_matrix",
      description: "Data requirements and readiness of candidate statistical methods",
      section: "appendix",
      headers: ["Methodology", "Status", "Readiness (0-100)", "Evidence", "Interpretation"],
      rows: methodAssessments.map(item => ([
        item.label,
        formatMethodApplicabilityStatus(item.status),
        item.readinessScore,
        item.evidence,
        item.notes,
      ])),
    });
  }

  return tables;
}

export function generateDefaultMetrics(
  allData: { name: string; data: Record<string, any>[]; columns: string[]; totalRows: number; fullDataProfile?: FullDataProfile }[],
  executableMethods: Set<string> | null,
  analysisTopic = "",
  analysisInputs?: AnalysisInputs,
  analysisBundle?: AnalysisComputationBundle | null,
): Record<string, number | string> {
  const metrics: Record<string, number | string> = {};
  const bundle = resolveAnalysisComputationBundle(allData, analysisTopic, analysisInputs, executableMethods, analysisBundle);
  const ds = bundle?.ds || getPrimaryDataset(allData);
  if (!ds) return metrics;
  if (!bundle) return metrics;

  metrics.total_observations = ds.totalRows;
  metrics.total_variables = ds.columns.length;
  metrics.datasets_loaded = allData.length;
  metrics.primary_dataset = ds.name;

  const { rawNumericCols, categoricalCols, idCols } = bundle;
  metrics.numeric_variables = rawNumericCols.length;
  metrics.categorical_variables = categoricalCols.length;
  if (idCols.length > 0) {
    metrics.id_code_variables_excluded = idCols.length;
    metrics.id_code_columns = idCols.join(", ");
  }

  // Count missing values
  let totalMissing = 0;
  for (const row of ds.data) {
    for (const col of ds.columns) {
      if (isMissingValue(row[col])) {
        totalMissing++;
      }
    }
  }
  metrics.missing_values = totalMissing;
  metrics.missing_rate = `${((totalMissing / (ds.data.length * ds.columns.length)) * 100).toFixed(2)}%`;
  metrics.sample_waterfall_total_rows = ds.totalRows;
  metrics.sample_waterfall_rows_loaded = ds.data.length;
  metrics.sample_waterfall_rows_not_loaded = Math.max(0, ds.totalRows - ds.data.length);
  if (ds.fullDataProfile?.scannedRows) {
    metrics.full_data_rows_scanned = ds.fullDataProfile.scannedRows;
    metrics.full_data_numeric_columns_summarized = Object.keys(ds.fullDataProfile.numeric).length;
    metrics.full_data_categorical_columns_summarized = Object.keys(ds.fullDataProfile.categorical).length;
    metrics.large_data_processing_mode = "streaming full-scan summaries plus bounded representative sample for model diagnostics";
  }

  const meaningfulNumericCols = bundle.meaningfulNumericCols;
  const designHints = bundle.designHints;
  const missingDataMode = bundle.missingDataMode;
  const methodAssessments = bundle.methodAssessments;
  const panelFeAssessment = bundle.panelFeAssessment;
  const preparedRegression = bundle.preparedRegression;
  const robustOls = bundle.robustOls;
  const panelFixedEffects = bundle.panelFixedEffects;
  const diffInDiff = bundle.diffInDiff;
  const syntheticControl = bundle.syntheticControl;
  const syntheticControlPlacebos = bundle.syntheticControlPlacebos;
  const iv2Sls = bundle.iv2Sls;
  const rdd = bundle.rdd;
  const propensityScore = bundle.propensityScore;
  const quantileRegression = bundle.quantileRegression;
  const executableNowCount = methodAssessments.filter(item => item.status === "executable_now").length;
  const partiallyReadyCount = methodAssessments.filter(item => item.status === "partially_ready").length;
  const blockedCount = methodAssessments.filter(item => item.status === "blocked").length;
  metrics.method_applicability_executable_now = executableNowCount;
  metrics.method_applicability_partially_ready = partiallyReadyCount;
  metrics.method_applicability_blocked = blockedCount;
  for (const item of methodAssessments) {
    metrics[`method_readiness_${item.methodId}`] = item.readinessScore;
    metrics[`method_status_${item.methodId}`] = item.status;
  }
  const topExecutable = methodAssessments
    .filter(item => item.status === "executable_now")
    .sort((a, b) => b.readinessScore - a.readinessScore)
    .slice(0, 5)
    .map(item => `${item.methodId}(${item.readinessScore})`)
    .join(", ");
  metrics.method_applicability_top_executable = topExecutable || "none";
  metrics.method_applicability_summary = `executable_now=${executableNowCount}, partially_ready=${partiallyReadyCount}, blocked=${blockedCount}`;
  metrics.analysis_missing_data_mode = missingDataMode;
  metrics.analysis_design_outcome = designHints.primaryOutcomeCol || "not_detected";
  metrics.analysis_design_treatment = designHints.primaryTreatmentCol || "not_detected";
  metrics.analysis_design_regressor = designHints.primaryRegressorCol || "not_detected";
  metrics.analysis_design_entity = designHints.primaryEntityCol || "not_detected";
  metrics.analysis_design_time = designHints.primaryTimeCol || "not_detected";
  if (designHints.controlCols.length > 0) {
    metrics.analysis_design_controls = designHints.controlCols.join(", ");
  }
  if (designHints.subgroupCol) {
    metrics.analysis_design_subgroup = designHints.subgroupCol;
  }
  if (designHints.specifiedInputMatches.length > 0) {
    metrics.analysis_inputs_matched_columns = designHints.specifiedInputMatches.join(", ");
  }
  if (designHints.specifiedInputMissing.length > 0) {
    metrics.analysis_inputs_missing_columns = designHints.specifiedInputMissing.join(", ");
  }

  const primaryRegressionRows = preparedRegression?.rows.length || 0;
  metrics.sample_waterfall_complete_case_primary_regression = primaryRegressionRows;
  metrics.sample_waterfall_rows_used_primary_regression = primaryRegressionRows;
  metrics.sample_waterfall_rows_dropped_primary_regression = Math.max(0, ds.data.length - primaryRegressionRows);
  metrics.sample_waterfall_imputed_predictor_cells_primary_regression = preparedRegression?.imputedPredictorCells || 0;
  const diffInDiffCompleteCases = countDiffInDiffCompleteCaseRows(ds, designHints);
  metrics.sample_waterfall_complete_case_diff_in_diff = diffInDiffCompleteCases;
  metrics.sample_waterfall_rows_dropped_diff_in_diff = Math.max(0, ds.data.length - diffInDiffCompleteCases);
  const panelFeRows = panelFeAssessment.prepared?.rows.length || panelFeAssessment.diagnostics.completeCaseRows;
  metrics.sample_waterfall_complete_case_panel_fe = panelFeRows;
  metrics.sample_waterfall_rows_used_panel_fe = panelFeRows;
  metrics.sample_waterfall_rows_dropped_panel_fe = Math.max(0, ds.data.length - panelFeRows);
  metrics.sample_waterfall_imputed_predictor_cells_panel_fe = panelFeAssessment.prepared?.imputedPredictorCells || 0;
  metrics.panel_fe_gate_status = panelFeAssessment.diagnostics.status;
  metrics.panel_fe_gate_reason = panelFeAssessment.diagnostics.reason || "passed";
  metrics.panel_fe_complete_case_rows = panelFeAssessment.diagnostics.completeCaseRows;
  metrics.panel_fe_complete_case_entities = panelFeAssessment.diagnostics.completeCaseEntities;
  metrics.panel_fe_complete_case_periods = panelFeAssessment.diagnostics.completeCasePeriods;
  metrics.panel_fe_repeated_entities = panelFeAssessment.diagnostics.repeatedEntityCount;
  metrics.panel_fe_informative_entities_x = panelFeAssessment.diagnostics.informativeEntityCountX;
  metrics.panel_fe_informative_entities_y = panelFeAssessment.diagnostics.informativeEntityCountY;
  metrics.panel_fe_informative_entities_both = panelFeAssessment.diagnostics.informativeEntityCountBoth;
  metrics.panel_fe_min_obs_per_entity = panelFeAssessment.diagnostics.minObsPerEntity;
  metrics.panel_fe_median_obs_per_entity = panelFeAssessment.diagnostics.medianObsPerEntity;
  metrics.panel_fe_max_obs_per_entity = panelFeAssessment.diagnostics.maxObsPerEntity;
  metrics.panel_fe_transformed_rows = panelFeAssessment.diagnostics.transformedRows;
  metrics.design_selected_outcome = designHints.primaryOutcomeCol || "";
  metrics.design_selected_treatment_or_regressor = designHints.primaryTreatmentCol || designHints.primaryRegressorCol || "";
  metrics.design_selected_entity = designHints.primaryEntityCol || "";
  metrics.design_selected_time = designHints.primaryTimeCol || "";
  metrics.design_causal_direction = designHints.primaryOutcomeCol && (designHints.primaryTreatmentCol || designHints.primaryRegressorCol)
    ? `${designHints.primaryOutcomeCol} <- ${designHints.primaryTreatmentCol || designHints.primaryRegressorCol}`
    : "not established";

  if (methodAllowed(executableMethods, "descriptive_statistics")) {
    for (const col of meaningfulNumericCols.slice(0, 5)) {
      const values = numericValuesOf(ds, col);
      if (values.length === 0) continue;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1 || 1);
      const std = Math.sqrt(variance);
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
    const displayCol = col.length > 20 ? col.slice(0, 17) + "..." : col;
      metrics[`mean_${displayCol}`] = Math.round(mean * 1000) / 1000;
      metrics[`std_${displayCol}`] = Math.round(std * 1000) / 1000;
      metrics[`median_${displayCol}`] = Math.round(median * 1000) / 1000;
      metrics[`min_${displayCol}`] = Math.round(sorted[0] * 1000) / 1000;
      metrics[`max_${displayCol}`] = Math.round(sorted[sorted.length - 1] * 1000) / 1000;
    }
  }

  // Correlation analysis: find the MOST MEANINGFUL pair of numeric columns
  // Skip ID/code columns and find columns that are conceptually related
  if (meaningfulNumericCols.length >= 2 && methodAllowed(executableMethods, "correlation")) {
    // Try multiple pairs and pick the one with highest absolute correlation
    // (but only report if the correlation is statistically meaningful)
    let bestCorr = 0;
    let bestPair: [string, string] | null = null;
    let bestN = 0;
    let bestPValue = 1;

    const pairsToTry = Math.min(10, meaningfulNumericCols.length * (meaningfulNumericCols.length - 1) / 2);
    let pairsTried = 0;

    for (let i = 0; i < meaningfulNumericCols.length && pairsTried < pairsToTry; i++) {
      for (let j = i + 1; j < meaningfulNumericCols.length && pairsTried < pairsToTry; j++) {
        pairsTried++;
        const col1 = meaningfulNumericCols[i];
        const col2 = meaningfulNumericCols[j];
        const pairs: [number, number][] = [];
        for (const row of ds.data) {
          const v1 = Number(row[col1]);
          const v2 = Number(row[col2]);
          if (!isNaN(v1) && !isNaN(v2)) pairs.push([v1, v2]);
        }
        if (pairs.length < 10) continue;

        const n = pairs.length;
        const m1 = pairs.reduce((a, p) => a + p[0], 0) / n;
        const m2 = pairs.reduce((a, p) => a + p[1], 0) / n;
        let num = 0, d1 = 0, d2 = 0;
        for (const [v1, v2] of pairs) {
          num += (v1 - m1) * (v2 - m2);
          d1 += (v1 - m1) ** 2;
          d2 += (v2 - m2) ** 2;
        }
        const corr = d1 > 0 && d2 > 0 ? num / Math.sqrt(d1 * d2) : 0;

        // Approximate p-value
        const t = corr * Math.sqrt((n - 2) / (1 - corr * corr + 1e-10));
        const absT = Math.abs(t);
        let pApprox: number;
        if (n > 30) {
          pApprox = Math.min(1, Math.exp(-0.717 * absT - 0.416 * absT * absT) * 2);
        } else {
          pApprox = absT > 2.576 ? 0.01 : absT > 1.96 ? 0.05 : absT > 1.645 ? 0.1 : 0.5;
        }

        if (Math.abs(corr) > Math.abs(bestCorr)) {
          bestCorr = corr;
          bestPair = [col1, col2];
          bestN = n;
          bestPValue = pApprox;
        }
      }
    }

    if (bestPair) {
      const displayCol1 = bestPair[0].length > 15 ? bestPair[0].slice(0, 12) + "..." : bestPair[0];
      const displayCol2 = bestPair[1].length > 15 ? bestPair[1].slice(0, 12) + "..." : bestPair[1];
      metrics[`strongest_correlation_${displayCol1}_vs_${displayCol2}`] = Math.round(bestCorr * 1000) / 1000;
      metrics[`p_value_${displayCol1}_vs_${displayCol2}`] = Math.round(bestPValue * 10000) / 10000;
      metrics[`correlation_sample_size`] = bestN;
      // Add interpretation
      const absCorr = Math.abs(bestCorr);
      const strength = absCorr > 0.7 ? "strong" : absCorr > 0.4 ? "moderate" : absCorr > 0.2 ? "weak" : "negligible";
      const direction = bestCorr > 0 ? "positive" : "negative";
      metrics[`correlation_interpretation`] = `${strength} ${direction} (r=${bestCorr.toFixed(3)}, p=${bestPValue < 0.001 ? "<0.001" : bestPValue.toFixed(4)}, n=${bestN})`;
    }
  }

  // Linear regression on the best numeric pair
  if (meaningfulNumericCols.length >= 2 && methodAllowed(executableMethods, "linear_regression")) {
    let bestModel: { xCol: string; yCol: string; r2: number; slope: number; intercept: number; n: number } | null = null;
    const maxPairs = Math.min(15, (meaningfulNumericCols.length * (meaningfulNumericCols.length - 1)) / 2);
    let evaluated = 0;
    for (let i = 0; i < meaningfulNumericCols.length && evaluated < maxPairs; i++) {
      for (let j = i + 1; j < meaningfulNumericCols.length && evaluated < maxPairs; j++) {
        evaluated++;
        const xCol = meaningfulNumericCols[i];
        const yCol = meaningfulNumericCols[j];
        const pairs = parseNumericPairs(ds, xCol, yCol);
        const reg = regressionStatsFromPairs(pairs);
        if (!reg) continue;
        if (!bestModel || reg.r2 > bestModel.r2) {
          bestModel = { xCol, yCol, r2: reg.r2, slope: reg.slope, intercept: reg.intercept, n: reg.n };
        }
      }
    }
    if (bestModel) {
      const xKey = metricKeyPart(bestModel.xCol, 16);
      const yKey = metricKeyPart(bestModel.yCol, 16);
      metrics[`regression_slope_${yKey}_on_${xKey}`] = Math.round(bestModel.slope * 1000) / 1000;
      metrics[`regression_intercept_${yKey}_on_${xKey}`] = Math.round(bestModel.intercept * 1000) / 1000;
      metrics[`regression_r2_${yKey}_on_${xKey}`] = Math.round(bestModel.r2 * 1000) / 1000;
      const adjR2 = 1 - (1 - bestModel.r2) * (bestModel.n - 1) / (bestModel.n - 2);
      metrics[`regression_adj_r2_${yKey}_on_${xKey}`] = Math.round(adjR2 * 1000) / 1000;
      // F-statistic for simple regression: F = (R²/1) / ((1-R²)/(n-2))
      const fStat = bestModel.r2 > 0 ? (bestModel.r2 * (bestModel.n - 2)) / (1 - bestModel.r2 + 1e-10) : 0;
      metrics[`regression_f_stat_${yKey}_on_${xKey}`] = Math.round(fStat * 100) / 100;
      const regrPValue = approxTwoTailPValue(Math.sqrt(fStat), bestModel.n - 2);
      metrics[`regression_p_value_${yKey}_on_${xKey}`] = regrPValue < 0.001 ? "<0.001" : (Math.round(regrPValue * 10000) / 10000).toString();
      metrics[`regression_sample_size_${yKey}_on_${xKey}`] = bestModel.n;
    }
  }

  if (robustOls && methodAllowed(executableMethods, "robust_ols")) {
    const xKey = metricKeyPart(robustOls.xCol, 16);
    const yKey = metricKeyPart(robustOls.yCol, 16);
    metrics[`robust_ols_beta_${yKey}_on_${xKey}`] = Math.round(robustOls.slope * 1000) / 1000;
    metrics[`robust_ols_se_${yKey}_on_${xKey}`] = Math.round(robustOls.seSlope * 1000) / 1000;
    metrics[`robust_ols_t_stat_${yKey}_on_${xKey}`] = Math.round(robustOls.tStat * 1000) / 1000;
    metrics[`robust_ols_p_value_${yKey}_on_${xKey}`] = robustOls.pValue < 0.001 ? "<0.001" : (Math.round(robustOls.pValue * 10000) / 10000).toString();
    metrics[`robust_ols_ci_low_${yKey}_on_${xKey}`] = Math.round(robustOls.ciLower * 1000) / 1000;
    metrics[`robust_ols_ci_high_${yKey}_on_${xKey}`] = Math.round(robustOls.ciUpper * 1000) / 1000;
    metrics[`robust_ols_r2_${yKey}_on_${xKey}`] = Math.round(robustOls.r2 * 1000) / 1000;
    metrics[`robust_ols_sample_size_${yKey}_on_${xKey}`] = robustOls.n;
    metrics[`robust_ols_control_count_${yKey}_on_${xKey}`] = robustOls.controlCols.length;
    metrics[`robust_ols_controls_${yKey}_on_${xKey}`] = robustOls.controlCols.join(", ") || "none";
    metrics[`robust_ols_vcov_${yKey}_on_${xKey}`] = robustOls.vcovType;
    metrics[`robust_ols_cluster_count_${yKey}_on_${xKey}`] = robustOls.clusterCount || 0;
    metrics[`robust_ols_missing_data_${yKey}_on_${xKey}`] = robustOls.missingDataMode;
    metrics[`robust_ols_imputed_predictor_cells_${yKey}_on_${xKey}`] = robustOls.imputedPredictorCells;
    if (robustOls.omittedControlCols.length > 0) {
      metrics[`robust_ols_omitted_controls_${yKey}_on_${xKey}`] = robustOls.omittedControlCols.join(", ");
    }
  }

  if (panelFixedEffects && methodAllowed(executableMethods, "panel_fixed_effects")) {
    const xKey = metricKeyPart(panelFixedEffects.xCol, 16);
    const yKey = metricKeyPart(panelFixedEffects.yCol, 16);
    metrics[`panel_fe_beta_${yKey}_on_${xKey}`] = Math.round(panelFixedEffects.beta * 1000) / 1000;
    metrics[`panel_fe_se_${yKey}_on_${xKey}`] = Math.round(panelFixedEffects.se * 1000) / 1000;
    metrics[`panel_fe_t_stat_${yKey}_on_${xKey}`] = Math.round(panelFixedEffects.tStat * 1000) / 1000;
    metrics[`panel_fe_p_value_${yKey}_on_${xKey}`] = panelFixedEffects.pValue < 0.001 ? "<0.001" : (Math.round(panelFixedEffects.pValue * 10000) / 10000).toString();
    metrics[`panel_fe_within_r2_${yKey}_on_${xKey}`] = Math.round(panelFixedEffects.r2Within * 1000) / 1000;
    metrics[`panel_fe_entities_${yKey}_on_${xKey}`] = panelFixedEffects.entities;
    metrics[`panel_fe_periods_${yKey}_on_${xKey}`] = panelFixedEffects.periods;
    metrics[`panel_fe_sample_size_${yKey}_on_${xKey}`] = panelFixedEffects.n;
    metrics[`panel_fe_control_count_${yKey}_on_${xKey}`] = panelFixedEffects.controlCols.length;
    metrics[`panel_fe_controls_${yKey}_on_${xKey}`] = panelFixedEffects.controlCols.join(", ") || "none";
    metrics[`panel_fe_vcov_${yKey}_on_${xKey}`] = panelFixedEffects.vcovType;
    metrics[`panel_fe_cluster_count_${yKey}_on_${xKey}`] = panelFixedEffects.clusterCount || 0;
    metrics[`panel_fe_missing_data_${yKey}_on_${xKey}`] = panelFixedEffects.missingDataMode;
    metrics[`panel_fe_imputed_predictor_cells_${yKey}_on_${xKey}`] = panelFixedEffects.imputedPredictorCells;
    if (panelFixedEffects.omittedControlCols.length > 0) {
      metrics[`panel_fe_omitted_controls_${yKey}_on_${xKey}`] = panelFixedEffects.omittedControlCols.join(", ");
    }
  }

  if (diffInDiff && methodAllowed(executableMethods, "diff_in_diff")) {
    const outcomeKey = metricKeyPart(diffInDiff.outcomeCol, 16);
    const treatKey = metricKeyPart(diffInDiff.treatmentCol, 16);
    metrics[`did_estimate_${outcomeKey}_by_${treatKey}`] = Math.round(diffInDiff.estimate * 1000) / 1000;
    metrics[`did_treated_pre_${outcomeKey}_by_${treatKey}`] = Math.round(diffInDiff.treatedPre * 1000) / 1000;
    metrics[`did_treated_post_${outcomeKey}_by_${treatKey}`] = Math.round(diffInDiff.treatedPost * 1000) / 1000;
    metrics[`did_control_pre_${outcomeKey}_by_${treatKey}`] = Math.round(diffInDiff.controlPre * 1000) / 1000;
    metrics[`did_control_post_${outcomeKey}_by_${treatKey}`] = Math.round(diffInDiff.controlPost * 1000) / 1000;
    metrics[`did_pretrend_delta_${outcomeKey}_by_${treatKey}`] = Math.round(diffInDiff.preTrendDelta * 1000) / 1000;
    metrics[`did_sample_size_${outcomeKey}_by_${treatKey}`] = diffInDiff.n;

    if (methodAllowed(executableMethods, "event_study")) {
      for (const point of diffInDiff.series.filter(point => point.relIndex >= -3 && point.relIndex <= 4)) {
        const key = point.relIndex < 0 ? `lead_${Math.abs(point.relIndex)}` : point.relIndex === 0 ? "event_0" : `lag_${point.relIndex}`;
        metrics[`event_study_${key}_${outcomeKey}_by_${treatKey}`] = Math.round(point.effect * 1000) / 1000;
      }
    }
  }

  if (syntheticControl && methodAllowed(executableMethods, "synthetic_control")) {
    const outcomeKey = metricKeyPart(syntheticControl.outcomeCol, 16);
    metrics[`synthetic_control_pre_rmse_${outcomeKey}`] = Math.round(syntheticControl.preRmse * 1000) / 1000;
    metrics[`synthetic_control_post_rmse_${outcomeKey}`] = Math.round(syntheticControl.postRmse * 1000) / 1000;
    metrics[`synthetic_control_att_post_${outcomeKey}`] = Math.round(syntheticControl.attPostMean * 1000) / 1000;
    metrics[`synthetic_control_donor_count_${outcomeKey}`] = syntheticControl.donorCount;
    metrics[`synthetic_control_treated_unit_${outcomeKey}`] = syntheticControl.treatedUnit;
    const topWeight = syntheticControl.weights[0];
    if (topWeight) {
      metrics[`synthetic_control_top_donor_${outcomeKey}`] = `${topWeight.unit} (${topWeight.weight.toFixed(3)})`;
    }
  }

  if (syntheticControlPlacebos && methodAllowed(executableMethods, "synthetic_control")) {
    const outcomeKey = metricKeyPart(syntheticControl?.outcomeCol || "outcome", 16);
    metrics[`synthetic_control_placebo_ratio_${outcomeKey}`] = Math.round(syntheticControlPlacebos.actualRatio * 1000) / 1000;
    metrics[`synthetic_control_placebo_rank_${outcomeKey}`] = syntheticControlPlacebos.actualRank;
    metrics[`synthetic_control_placebo_count_${outcomeKey}`] = syntheticControlPlacebos.ratios.length;
  }

  if (iv2Sls && methodAllowed(executableMethods, "iv_2sls")) {
    const yKey = metricKeyPart(iv2Sls.yCol, 16);
    const xKey = metricKeyPart(iv2Sls.xCol, 16);
    const zKey = metricKeyPart(iv2Sls.zCol, 16);
    metrics[`iv_2sls_beta_${yKey}_on_${xKey}`] = Math.round(iv2Sls.beta * 1000) / 1000;
    metrics[`iv_2sls_se_${yKey}_on_${xKey}`] = Math.round(iv2Sls.se * 1000) / 1000;
    metrics[`iv_2sls_t_stat_${yKey}_on_${xKey}`] = Math.round(iv2Sls.tStat * 1000) / 1000;
    metrics[`iv_2sls_p_value_${yKey}_on_${xKey}`] = iv2Sls.pValue < 0.001 ? "<0.001" : (Math.round(iv2Sls.pValue * 10000) / 10000).toString();
    metrics[`iv_2sls_ci_low_${yKey}_on_${xKey}`] = Math.round(iv2Sls.ciLower * 1000) / 1000;
    metrics[`iv_2sls_ci_high_${yKey}_on_${xKey}`] = Math.round(iv2Sls.ciUpper * 1000) / 1000;
    metrics[`iv_2sls_first_stage_f_${xKey}_by_${zKey}`] = Math.round(iv2Sls.firstStageF * 1000) / 1000;
    metrics[`iv_2sls_first_stage_p_${xKey}_by_${zKey}`] = iv2Sls.firstStagePValue < 0.001 ? "<0.001" : (Math.round(iv2Sls.firstStagePValue * 10000) / 10000).toString();
    metrics[`iv_2sls_sample_size_${yKey}_on_${xKey}`] = iv2Sls.n;
  }

  if (rdd && methodAllowed(executableMethods, "regression_discontinuity")) {
    const outcomeKey = metricKeyPart(rdd.outcomeCol, 16);
    const runningKey = metricKeyPart(rdd.runningCol, 16);
    metrics[`rdd_estimate_${outcomeKey}_at_${runningKey}`] = Math.round(rdd.estimate * 1000) / 1000;
    metrics[`rdd_se_${outcomeKey}_at_${runningKey}`] = Math.round(rdd.se * 1000) / 1000;
    metrics[`rdd_t_stat_${outcomeKey}_at_${runningKey}`] = Math.round(rdd.tStat * 1000) / 1000;
    metrics[`rdd_p_value_${outcomeKey}_at_${runningKey}`] = rdd.pValue < 0.001 ? "<0.001" : (Math.round(rdd.pValue * 10000) / 10000).toString();
    metrics[`rdd_cutoff_${runningKey}`] = Math.round(rdd.cutoff * 1000) / 1000;
    metrics[`rdd_bandwidth_${runningKey}`] = Math.round(rdd.bandwidth * 1000) / 1000;
    metrics[`rdd_local_n_${runningKey}`] = rdd.nLocal;
  }

  if (propensityScore && methodAllowed(executableMethods, "propensity_score")) {
    const outcomeKey = metricKeyPart(propensityScore.outcomeCol, 16);
    const treatKey = metricKeyPart(propensityScore.treatmentCol, 16);
    metrics[`propensity_score_ate_${outcomeKey}_by_${treatKey}`] = Math.round(propensityScore.ate * 1000) / 1000;
    metrics[`propensity_score_se_${outcomeKey}_by_${treatKey}`] = Math.round(propensityScore.se * 1000) / 1000;
    metrics[`propensity_score_t_stat_${outcomeKey}_by_${treatKey}`] = Math.round(propensityScore.tStat * 1000) / 1000;
    metrics[`propensity_score_p_value_${outcomeKey}_by_${treatKey}`] = propensityScore.pValue < 0.001 ? "<0.001" : (Math.round(propensityScore.pValue * 10000) / 10000).toString();
    metrics[`propensity_score_ci_low_${outcomeKey}_by_${treatKey}`] = Math.round(propensityScore.ciLower * 1000) / 1000;
    metrics[`propensity_score_ci_high_${outcomeKey}_by_${treatKey}`] = Math.round(propensityScore.ciUpper * 1000) / 1000;
    metrics[`propensity_score_overlap_min_${treatKey}`] = Math.round(propensityScore.overlapMin * 1000) / 1000;
    metrics[`propensity_score_overlap_max_${treatKey}`] = Math.round(propensityScore.overlapMax * 1000) / 1000;
    metrics[`propensity_score_max_abs_smd_before_${treatKey}`] = Math.round(Math.max(...propensityScore.balance.map(item => Math.abs(item.smdBefore))) * 1000) / 1000;
    metrics[`propensity_score_max_abs_smd_after_${treatKey}`] = Math.round(Math.max(...propensityScore.balance.map(item => Math.abs(item.smdAfter))) * 1000) / 1000;
    metrics[`propensity_score_sample_size_${outcomeKey}_by_${treatKey}`] = propensityScore.n;
  }

  if (quantileRegression && methodAllowed(executableMethods, "quantile_regression")) {
    const outcomeKey = metricKeyPart(quantileRegression.yCol, 16);
    const regressorKey = metricKeyPart(quantileRegression.xCol, 16);
    for (const estimate of quantileRegression.estimates) {
      const tauKey = `q${Math.round(estimate.tau * 100)}`;
      metrics[`quantile_regression_slope_${tauKey}_${outcomeKey}_on_${regressorKey}`] = Math.round(estimate.slope * 1000) / 1000;
      metrics[`quantile_regression_intercept_${tauKey}_${outcomeKey}_on_${regressorKey}`] = Math.round(estimate.intercept * 1000) / 1000;
      metrics[`quantile_regression_se_${tauKey}_${outcomeKey}_on_${regressorKey}`] = Math.round(estimate.slopeSe * 1000) / 1000;
      metrics[`quantile_regression_p_value_${tauKey}_${outcomeKey}_on_${regressorKey}`] = estimate.pValue < 0.001 ? "<0.001" : (Math.round(estimate.pValue * 10000) / 10000).toString();
      metrics[`quantile_regression_ci_low_${tauKey}_${outcomeKey}_on_${regressorKey}`] = Math.round(estimate.ciLower * 1000) / 1000;
      metrics[`quantile_regression_ci_high_${tauKey}_${outcomeKey}_on_${regressorKey}`] = Math.round(estimate.ciUpper * 1000) / 1000;
      metrics[`quantile_regression_pseudo_r1_${tauKey}_${outcomeKey}_on_${regressorKey}`] = Math.round(estimate.pseudoR1 * 1000) / 1000;
      metrics[`quantile_regression_bootstrap_replicates_${tauKey}_${outcomeKey}_on_${regressorKey}`] = estimate.bootstrapReplicates;
    }
    metrics[`quantile_regression_sample_size_${outcomeKey}_on_${regressorKey}`] = quantileRegression.n;
    metrics[`quantile_regression_control_count_${outcomeKey}_on_${regressorKey}`] = quantileRegression.controlCols.length;
    metrics[`quantile_regression_controls_${outcomeKey}_on_${regressorKey}`] = quantileRegression.controlCols.join(", ") || "none";
    metrics[`quantile_regression_vcov_${outcomeKey}_on_${regressorKey}`] = quantileRegression.vcovType;
    metrics[`quantile_regression_cluster_count_${outcomeKey}_on_${regressorKey}`] = quantileRegression.clusterCount || 0;
    metrics[`quantile_regression_missing_data_${outcomeKey}_on_${regressorKey}`] = quantileRegression.missingDataMode;
    metrics[`quantile_regression_imputed_predictor_cells_${outcomeKey}_on_${regressorKey}`] = quantileRegression.imputedPredictorCells;
    if (quantileRegression.omittedControlCols.length > 0) {
      metrics[`quantile_regression_omitted_controls_${outcomeKey}_on_${regressorKey}`] = quantileRegression.omittedControlCols.join(", ");
    }
  }

  // Group comparison (ANOVA-like between/within decomposition)
  if (categoricalCols.length > 0 && meaningfulNumericCols.length > 0 && methodAllowed(executableMethods, "group_comparison")) {
    let bestAnova: {
      catCol: string;
      numCol: string;
      groups: number;
      n: number;
      eta2: number;
    } | null = null;

    for (const catCol of categoricalCols.slice(0, 8)) {
      for (const numCol of meaningfulNumericCols.slice(0, 8)) {
        const groups = new Map<string, number[]>();
        for (const row of ds.data) {
          const cat = String(row[catCol] ?? "").trim();
          const value = Number(row[numCol]);
          if (!cat || isNaN(value)) continue;
          const bucket = groups.get(cat) || [];
          bucket.push(value);
          groups.set(cat, bucket);
        }
        const validGroups = Array.from(groups.values()).filter(v => v.length >= 3);
        const n = validGroups.reduce((sum, v) => sum + v.length, 0);
        if (validGroups.length < 2 || n < 20) continue;

        const allValues = validGroups.flat();
        const grandMean = allValues.reduce((a, b) => a + b, 0) / allValues.length;
        let ssBetween = 0;
        let ssTotal = 0;
        for (const groupVals of validGroups) {
          const mean = groupVals.reduce((a, b) => a + b, 0) / groupVals.length;
          ssBetween += groupVals.length * (mean - grandMean) ** 2;
        }
        for (const v of allValues) {
          ssTotal += (v - grandMean) ** 2;
        }
        if (ssTotal <= 0) continue;
        const eta2 = ssBetween / ssTotal;
        if (!bestAnova || eta2 > bestAnova.eta2) {
          bestAnova = { catCol, numCol, groups: validGroups.length, n, eta2 };
        }
      }
    }

    if (bestAnova) {
      const catKey = metricKeyPart(bestAnova.catCol, 16);
      const numKey = metricKeyPart(bestAnova.numCol, 16);
      metrics[`anova_eta2_${numKey}_by_${catKey}`] = Math.round(bestAnova.eta2 * 1000) / 1000;
      metrics[`anova_groups_${numKey}_by_${catKey}`] = bestAnova.groups;
      metrics[`anova_sample_size_${numKey}_by_${catKey}`] = bestAnova.n;
      // Add F-statistic and p-value
      const dfBetween = bestAnova.groups - 1;
      const dfWithin = bestAnova.n - bestAnova.groups;
      const fStat = dfWithin > 0 && dfBetween > 0 && bestAnova.eta2 < 1
        ? (bestAnova.eta2 / dfBetween) / ((1 - bestAnova.eta2) / dfWithin)
        : 0;
      metrics[`anova_f_stat_${numKey}_by_${catKey}`] = Math.round(fStat * 100) / 100;
      const fPValue = fStat > 6.63 ? "<0.001" : fStat > 3.84 ? "<0.05" : fStat > 2.71 ? "<0.10" : ">0.10";
      metrics[`anova_p_value_${numKey}_by_${catKey}`] = fPValue;
    }
  }

  // Time trend analysis
  const timeCols = ds.columns.filter(c => /(year|month|date|time|wave|period|quarter)/i.test(c));
  if (timeCols.length > 0 && meaningfulNumericCols.length > 0 && methodAllowed(executableMethods, "time_trend")) {
    let bestTrend: { timeCol: string; numCol: string; slope: number; r: number; p: number; n: number } | null = null;
    for (const timeCol of timeCols.slice(0, 4)) {
      for (const numCol of meaningfulNumericCols.slice(0, 8)) {
        const pairs: [number, number][] = [];
        for (const row of ds.data) {
          const t = parseTimeValue(row[timeCol]);
          const y = Number(row[numCol]);
          if (t === null || isNaN(y)) continue;
          pairs.push([t, y]);
        }
        if (pairs.length < 15) continue;
        const reg = regressionStatsFromPairs(pairs);
        if (!reg) continue;

        const n = pairs.length;
        const meanX = pairs.reduce((a, p) => a + p[0], 0) / n;
        const meanY = pairs.reduce((a, p) => a + p[1], 0) / n;
        let num = 0;
        let d1 = 0;
        let d2 = 0;
        for (const [x, y] of pairs) {
          num += (x - meanX) * (y - meanY);
          d1 += (x - meanX) ** 2;
          d2 += (y - meanY) ** 2;
        }
        const r = d1 > 0 && d2 > 0 ? num / Math.sqrt(d1 * d2) : 0;
        const p = approximateCorrelationPValue(r, n);

        if (!bestTrend || reg.r2 > (bestTrend.r * bestTrend.r)) {
          bestTrend = { timeCol, numCol, slope: reg.slope, r, p, n };
        }
      }
    }
    if (bestTrend) {
      const tKey = metricKeyPart(bestTrend.timeCol, 14);
      const yKey = metricKeyPart(bestTrend.numCol, 14);
      metrics[`time_trend_slope_${yKey}_over_${tKey}`] = Math.round(bestTrend.slope * 10000) / 10000;
      metrics[`time_trend_corr_${yKey}_over_${tKey}`] = Math.round(bestTrend.r * 1000) / 1000;
      metrics[`time_trend_p_value_${yKey}_over_${tKey}`] = Math.round(bestTrend.p * 10000) / 10000;
      metrics[`time_trend_sample_size_${yKey}_over_${tKey}`] = bestTrend.n;
    }
  }

  // Text feature analysis
  const textCols = detectTextColumns(ds);
  if (textCols.length > 0 && methodAllowed(executableMethods, "text_feature_analysis")) {
    const textCol = textCols[0];
    const texts = ds.data
      .map(r => (typeof r[textCol] === "string" ? String(r[textCol]).trim() : ""))
      .filter(s => s.length > 0)
      .slice(0, 4000);
    if (texts.length > 0) {
      const lengths = texts.map(t => t.length);
      const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const sorted = [...lengths].sort((a, b) => a - b);
      const medianLen = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

      metrics.text_documents_analysed = texts.length;
      metrics.text_mean_length_chars = Math.round(avgLen * 10) / 10;
      metrics.text_median_length_chars = Math.round(medianLen * 10) / 10;
      metrics.text_source_column = textCol;

      const top = topTerms(texts, 8);
      for (let i = 0; i < top.length; i++) {
        metrics[`top_term_${i + 1}`] = `${top[i][0]} (${top[i][1]})`;
      }
    }
  }

  return metrics;
}
