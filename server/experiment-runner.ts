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

const EXECUTION_TIMEOUT_MS = 90_000; // 90 seconds max
const MAX_OUTPUT_LENGTH = 50_000;
const CSV_ENCODING_SAMPLE_BYTES = 128 * 1024;

interface DatasetParseOptions {
  signal?: AbortSignal;
  onDtaProgress?: (progress: { rowsParsed: number; totalRows: number }) => void | Promise<void>;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatMemoryUsageSnapshot(): string {
  const usage = process.memoryUsage();
  return `rss=${formatMiB(usage.rss)}, heapUsed=${formatMiB(usage.heapUsed)}, heapTotal=${formatMiB(usage.heapTotal)}`;
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
  }[];
  tables: { name: string; url: string; data: string; description: string }[];
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
  delimiter: "," | "\t",
  encoding: string,
): Promise<{ records: Record<string, any>[]; columns: string[] }> {
  return new Promise((resolve, reject) => {
    const records: Record<string, any>[] = [];
    const readStream = fs.createReadStream(filePath);
    const decoder = iconv.decodeStream(encoding);
    const parser = csvParseStream({
      columns: true,
      skip_empty_lines: true,
      delimiter,
      relax_column_count: true,
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
      records.push(record as Record<string, any>);
    };

    const onEnd = () => {
      cleanup();
      readStream.destroy();
      const columns = records.length > 0 ? Object.keys(records[0]) : [];
      resolve({ records, columns });
    };

    readStream.on("error", onError);
    decoder.on("error", onError);
    parser.on("error", onError);
    parser.on("data", onData);
    parser.on("end", onEnd);

    readStream.pipe(decoder).pipe(parser);
  });
}

async function parseDelimitedFile(
  filePath: string,
  fileType: "csv" | "tsv",
  rowCountHint?: number,
): Promise<{ data: Record<string, any>[]; columns: string[]; totalRows: number; encoding?: string }> {
  const delimiter = fileType === "tsv" ? "\t" : ",";
  const detectedEncoding = detectDelimitedFileEncoding(filePath);
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
      const { records, columns } = await parseDelimitedFileWithEncoding(filePath, delimiter, enc);
      if (records.length === 0 && columns.length === 0) continue;
      if (hasGarbledColumns(columns) && enc.toLowerCase().startsWith("utf")) continue;
      const hintedTotal = rowCountHint && rowCountHint > 0 ? rowCountHint : 0;
      const totalRows = Math.max(hintedTotal, records.length);
      return {
        data: records,
        columns,
        totalRows,
        encoding: enc === detectedEncoding ? enc : `${enc} (retry)`,
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
  result: { data: Record<string, any>[]; columns: string[]; totalRows: number },
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
): Promise<{ data: Record<string, any>[]; columns: string[]; totalRows: number; encoding?: string }> {
  const hintedRows = rowCountHint && rowCountHint > 0 ? rowCountHint : undefined;

  if (fileType === "csv" || fileType === "tsv") {
    return parseDelimitedFile(filePath, fileType, hintedRows);
  }

  if (fileType === "dta") {
    let rawBuf: Buffer | null = await fs.promises.readFile(filePath);
    const result = await parseDtaFileAsync(rawBuf, {
      signal: options?.signal,
      yieldEveryRows: 1000,
      onProgress: options?.onDtaProgress,
    });
    // Release the large buffer immediately so GC can reclaim it
    rawBuf = null;
    try { global.gc?.(); } catch {}
    return {
      data: result.data,
      columns: result.columns,
      totalRows: Math.max(
        result.totalRows > 0 ? result.totalRows : result.data.length,
        hintedRows ?? 0
      ),
    };
  }

  if (fileType === "excel") {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const records: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet);
    const columns = records.length > 0 ? Object.keys(records[0]) : [];
    return {
      data: records,
      columns,
      totalRows: Math.max(hintedRows ?? 0, records.length),
    };
  }

  if (fileType === "json") {
    const raw = fs.readFileSync(filePath, "utf-8");
    let parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      for (const key of Object.keys(parsed)) {
        if (Array.isArray(parsed[key])) {
          parsed = parsed[key];
          break;
        }
      }
    }
    if (!Array.isArray(parsed)) {
      parsed = [parsed];
    }
    const columns = parsed.length > 0 ? Object.keys(parsed[0]) : [];
    return {
      data: parsed,
      columns,
      totalRows: Math.max(hintedRows ?? 0, parsed.length),
    };
  }

  throw new Error(`Unsupported file type: ${fileType}`);
}

/** Wrapper that parses and validates a data file */
async function parseAndValidateDataFile(
  filePath: string,
  fileType: string,
  rowCountHint?: number,
  options?: DatasetParseOptions,
): Promise<{ data: Record<string, any>[]; columns: string[]; totalRows: number; encoding?: string }> {
  const result = await parseDataFile(filePath, fileType, rowCountHint, options);
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

async function svgToPng(svgBuffer: Buffer, width: number, height: number): Promise<Buffer> {
  try {
    const sharp = (await import("sharp")).default;
    const pngBuffer = await sharp(sanitizeSvgForRasterization(svgBuffer))
      .resize(width, height)
      .png()
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

  // Strategy 1: Generate SVG and convert to PNG via sharp
  console.log(`[Chart] Falling back to SVG + sharp PNG conversion...`);
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
 * Generate an SVG chart as a fallback when chartjs-node-canvas is unavailable.
 * Supports bar/line/scatter/bubble/pie to avoid malformed placeholder visuals.
 * Returns SVG as buffer.
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

  // Transliterate non-ASCII labels to prevent □□□□ garbling
  config = transliterateChartConfigSync(config);

  const rawTitle = config.options?.plugins?.title?.text;
  let title = Array.isArray(rawTitle)
    ? String(rawTitle.join(" "))
    : String(rawTitle || config.type || "Chart");
  // Strip non-ASCII from title for safe SVG rendering
  title = title.replace(/[^\x20-\x7E]/g, "").trim() || "Chart";
  const chartType = String(config.type || "bar").toLowerCase();
  const datasets: any[] = Array.isArray(config.data?.datasets) ? config.data.datasets : [];
  const labels: string[] = Array.isArray(config.data?.labels)
    ? config.data.labels.map((l: any) => String(l))
    : [];

  const asNumber = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const normaliseRange = (min: number, max: number): [number, number] => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    if (min === max) {
      const delta = Math.abs(min) > 1 ? Math.abs(min) * 0.1 : 1;
      return [min - delta, max + delta];
    }
    return [min, max];
  };
  const shortLabel = (value: unknown, maxLen = 30): string => {
    let text = String(value ?? "");
    // Strip non-ASCII characters as a safety net (labels should already be transliterated)
    text = text.replace(/[^\x20-\x7E]/g, "").trim();
    if (!text) text = "N/A";
    return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
  };
  const readRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const readArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  type PieSlice = { value: number; label: string; color: string };
  type BubblePoint = { x: number; y: number; r: number };
  type LinePoint = { x: number; y: number };
  type RenderSeries<T> = { label: string; color: string; points: T[] };

  // CRITICAL: Use ONLY the generic CSS keyword 'sans-serif' without quotes.
  // Named fonts like 'DejaVu Sans', 'Arial' etc. cause sharp/librsvg to render ALL text
  // as □□□□ replacement characters when those specific fonts aren't installed.
  // The unquoted generic keyword 'sans-serif' always has a system fallback in librsvg.
  const fontFamily = `sans-serif`;

  const padding = { top: 56, right: 36, bottom: 84, left: 64 };
  const plotX = padding.left;
  const plotY = padding.top;
  const plotWidth = Math.max(160, width - padding.left - padding.right);
  const plotHeight = Math.max(140, height - padding.top - padding.bottom);
  const plotBottomY = plotY + plotHeight;

  const palette = [
    "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc949",
    "#af7aa1", "#ff9da7", "#9c755f", "#bab0ab",
  ];
  const pickColor = (dsIndex: number, colorValue: unknown): string => {
    if (typeof colorValue === "string" && colorValue.trim().length > 0) return colorValue;
    if (Array.isArray(colorValue) && typeof colorValue[0] === "string") return colorValue[0];
    return palette[dsIndex % palette.length];
  };
  const mapLinear = (value: number, min: number, max: number, outMin: number, outMax: number): number => {
    const [safeMin, safeMax] = normaliseRange(min, max);
    const t = (value - safeMin) / (safeMax - safeMin);
    return outMin + t * (outMax - outMin);
  };
  const formatTick = (value: number): string => {
    const abs = Math.abs(value);
    if (abs >= 1000) return value.toFixed(0);
    if (abs >= 100) return value.toFixed(1);
    if (abs >= 10) return value.toFixed(2);
    return value.toFixed(3);
  };

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<style>text { font-family: sans-serif; font-size: 12px; }</style>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${width / 2}" y="30" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">${escapeXml(shortLabel(title, 90))}</text>`);

  const drawNoDataMessage = (message: string) => {
    parts.push(`<text x="${width / 2}" y="${plotY + plotHeight / 2}" text-anchor="middle" font-size="12" fill="#999">${escapeXml(message)}</text>`);
  };
  const drawCartesianFrame = (minY: number, maxY: number) => {
    const [safeMinY, safeMaxY] = normaliseRange(minY, maxY);
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const y = plotY + t * plotHeight;
      const value = safeMaxY - t * (safeMaxY - safeMinY);
      parts.push(`<line x1="${plotX}" y1="${y}" x2="${plotX + plotWidth}" y2="${y}" stroke="#ececec" stroke-width="1"/>`);
      parts.push(`<text x="${plotX - 8}" y="${y + 3}" text-anchor="end" font-size="9" fill="#666">${escapeXml(formatTick(value))}</text>`);
    }
    parts.push(`<line x1="${plotX}" y1="${plotBottomY}" x2="${plotX + plotWidth}" y2="${plotBottomY}" stroke="#999" stroke-width="1"/>`);
    parts.push(`<line x1="${plotX}" y1="${plotY}" x2="${plotX}" y2="${plotBottomY}" stroke="#999" stroke-width="1"/>`);
    return [safeMinY, safeMaxY] as [number, number];
  };

  if (chartType === "pie" || chartType === "doughnut") {
    const pieDataset = readRecord(datasets[0]);
    const rawValues = readArray(pieDataset.data);
    const backgroundColors = readArray(pieDataset.backgroundColor);
    const slices: PieSlice[] = rawValues
      .map((value: unknown, i: number) => {
        const n = asNumber(value);
        return {
          value: n === null ? 0 : Math.max(0, n),
          label: shortLabel(labels[i] || `Category ${i + 1}`, 22),
          color: pickColor(i, backgroundColors.length > 0 ? backgroundColors[i] : pieDataset.backgroundColor),
        };
      })
      .filter((s: PieSlice) => s.value > 0);

    const total = slices.reduce((sum: number, s: PieSlice) => sum + s.value, 0);
    if (total <= 0) {
      drawNoDataMessage("No positive values available for pie chart.");
    } else {
      const cx = plotX + plotWidth * 0.35;
      const cy = plotY + plotHeight * 0.5;
      const r = Math.max(40, Math.min(plotWidth * 0.24, plotHeight * 0.42));
      let startAngle = -Math.PI / 2;
      for (const slice of slices) {
        const sweep = (slice.value / total) * Math.PI * 2;
        const endAngle = startAngle + sweep;
        const sx = cx + r * Math.cos(startAngle);
        const sy = cy + r * Math.sin(startAngle);
        const ex = cx + r * Math.cos(endAngle);
        const ey = cy + r * Math.sin(endAngle);
        const largeArc = sweep > Math.PI ? 1 : 0;
        parts.push(
          `<path d="M ${cx} ${cy} L ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey} Z" fill="${slice.color}" stroke="#ffffff" stroke-width="1"/>`
        );
        startAngle = endAngle;
      }
      if (chartType === "doughnut") {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.52}" fill="#ffffff"/>`);
      }
      const legendX = plotX + plotWidth * 0.62;
      let legendY = plotY + 12;
      const maxLegend = Math.min(slices.length, 10);
      for (let i = 0; i < maxLegend; i++) {
        const slice = slices[i];
        const pct = ((slice.value / total) * 100).toFixed(1);
        parts.push(`<rect x="${legendX}" y="${legendY - 8}" width="10" height="10" fill="${slice.color}"/>`);
        parts.push(`<text x="${legendX + 14}" y="${legendY}" font-size="10" fill="#666">${escapeXml(`${slice.label} (${pct}%)`)}</text>`);
        legendY += 16;
      }
      if (slices.length > maxLegend) {
        parts.push(`<text x="${legendX}" y="${legendY}" font-size="10" fill="#888">${escapeXml(`... ${slices.length - maxLegend} more categories`)}</text>`);
      }
    }
  } else if (chartType === "scatter" || chartType === "bubble") {
    const allSeries: RenderSeries<BubblePoint>[] = datasets.map((ds, dsIndex) => {
      const dsRecord = readRecord(ds);
      const dsData = readArray(dsRecord.data);
      const points = dsData
        .map((raw: any, idx: number) => {
          if (raw && typeof raw === "object") {
            const pointRecord = raw as Record<string, unknown>;
            const x = asNumber(pointRecord.x);
            const y = asNumber(pointRecord.y);
            const r = asNumber(pointRecord.r);
            if (x === null || y === null) return null;
            return { x, y, r: r === null ? 4 : clamp(r, 2, 16) };
          }
          const y = asNumber(raw);
          if (y === null) return null;
          return { x: idx, y, r: 4 };
        })
        .filter((p): p is { x: number; y: number; r: number } => p !== null);
      return {
        label: shortLabel(dsRecord.label || `Dataset ${dsIndex + 1}`, 28),
        color: pickColor(dsIndex, dsRecord.backgroundColor || dsRecord.borderColor),
        points,
      };
    }).filter((s: RenderSeries<BubblePoint>) => s.points.length > 0);

    if (allSeries.length === 0) {
      drawNoDataMessage("No numeric points available for scatter chart.");
    } else {
      const xs = allSeries.flatMap((s) => s.points.map((p: BubblePoint) => p.x));
      const ys = allSeries.flatMap((s) => s.points.map((p: BubblePoint) => p.y));
      const [minX, maxX] = normaliseRange(Math.min(...xs), Math.max(...xs));
      const [minY, maxY] = drawCartesianFrame(Math.min(...ys), Math.max(...ys));
      const mapX = (x: number): number => mapLinear(x, minX, maxX, plotX, plotX + plotWidth);
      const mapY = (y: number): number => mapLinear(y, minY, maxY, plotBottomY, plotY);

      for (const series of allSeries) {
        // Limit scatter points in SVG to avoid visual noise
        const maxScatterPoints = 200;
        const renderPoints = series.points.length > maxScatterPoints
          ? series.points.filter((_, i) => i % Math.ceil(series.points.length / maxScatterPoints) === 0)
          : series.points;
        for (const point of renderPoints) {
          const cx = mapX(point.x);
          const cy = mapY(point.y);
          const radius = chartType === "bubble" ? point.r : 3;
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
          parts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${series.color}" fill-opacity="0.65" stroke="${series.color}" stroke-width="1"/>`);
        }
      }

      // X-axis tick labels for scatter/bubble
      const xTickCount = 5;
      for (let i = 0; i <= xTickCount; i++) {
        const t = i / xTickCount;
        const value = minX + t * (maxX - minX);
        const x = plotX + t * plotWidth;
        parts.push(`<text x="${x}" y="${plotBottomY + 16}" text-anchor="middle" font-size="9" fill="#666">${escapeXml(formatTick(value))}</text>`);
      }
    }
  } else if (chartType === "line") {
    const series: RenderSeries<LinePoint>[] = datasets.map((ds, dsIndex) => {
      const dsRecord = readRecord(ds);
      const dsData = readArray(dsRecord.data);
      const points = dsData
        .map((raw: any, idx: number) => {
          const value = raw && typeof raw === "object" ? asNumber(raw.y) : asNumber(raw);
          if (value === null) return null;
          return { x: idx, y: value };
        })
        .filter((p): p is LinePoint => p !== null);
      return {
        label: shortLabel(dsRecord.label || `Dataset ${dsIndex + 1}`, 28),
        color: pickColor(dsIndex, dsRecord.borderColor || dsRecord.backgroundColor),
        points,
      };
    }).filter((s: RenderSeries<LinePoint>) => s.points.length > 1);

    if (series.length === 0) {
      drawNoDataMessage("No line-series values available.");
    } else {
      const yValues = series.flatMap((s) => s.points.map((p: LinePoint) => p.y));
      const maxPoints = Math.max(...series.map((s) => s.points.length));
      const [minY, maxY] = drawCartesianFrame(Math.min(...yValues), Math.max(...yValues));
      const [minX, maxX] = normaliseRange(0, Math.max(1, maxPoints - 1));
      const mapX = (x: number): number => mapLinear(x, minX, maxX, plotX, plotX + plotWidth);
      const mapY = (y: number): number => mapLinear(y, minY, maxY, plotBottomY, plotY);

      for (const s of series) {
        const path = s.points
          .map((p: LinePoint, i: number) => `${i === 0 ? "M" : "L"} ${mapX(p.x).toFixed(2)} ${mapY(p.y).toFixed(2)}`)
          .join(" ");
        parts.push(`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2"/>`);
        for (const p of s.points) {
          parts.push(`<circle cx="${mapX(p.x)}" cy="${mapY(p.y)}" r="2.3" fill="${s.color}"/>`);
        }
      }

      const lineTickMax = 12;
      const lineTickStep = Math.max(1, Math.ceil(Math.max(labels.length, maxPoints) / lineTickMax));
      const lineLabelCount = Math.max(labels.length, maxPoints);
      const lineUseRotation = lineLabelCount / lineTickStep > 8;
      for (let i = 0; i < lineLabelCount; i += lineTickStep) {
        const x = mapX(i);
        const text = shortLabel(labels[i] || `${i + 1}`, lineUseRotation ? 18 : 14);
        if (lineUseRotation) {
          parts.push(`<text x="${x}" y="${plotBottomY + 12}" text-anchor="end" font-size="8" fill="#666" transform="rotate(-35, ${x}, ${plotBottomY + 12})">${escapeXml(text)}</text>`);
        } else {
          parts.push(`<text x="${x}" y="${plotBottomY + 16}" text-anchor="middle" font-size="9" fill="#666">${escapeXml(text)}</text>`);
        }
      }
    }
  } else if (chartType === "heatmap") {
    // Custom heatmap rendering for correlation matrices and similar grid data
    const heatmapLabels: string[] = labels.length > 0 ? labels : [];
    const heatmapData: { x: number; y: number; v: number }[] = [];
    if (datasets.length > 0 && Array.isArray(datasets[0]?.data)) {
      for (const d of datasets[0].data) {
        if (d && typeof d === "object" && "x" in d && "y" in d && "v" in d) {
          const x = asNumber(d.x), y = asNumber(d.y), v = asNumber(d.v);
          if (x !== null && y !== null && v !== null) heatmapData.push({ x, y, v });
        }
      }
    }
    const gridSize = heatmapLabels.length;
    if (gridSize < 2 || heatmapData.length === 0) {
      drawNoDataMessage("No heatmap data available.");
    } else {
      // Reserve space for axis labels
      const labelSpace = 80;
      const gridX = plotX + labelSpace;
      const gridY = plotY + 8;
      const gridWidth = plotWidth - labelSpace;
      const gridHeight = plotHeight - 30;
      const cellW = gridWidth / gridSize;
      const cellH = gridHeight / gridSize;

      // Color interpolation: blue (positive) to white (zero) to red (negative)
      const heatColor = (v: number): string => {
        const clamped = Math.max(-1, Math.min(1, v));
        const abs = Math.abs(clamped);
        if (clamped >= 0) {
          // White to blue
          const r = Math.round(255 * (1 - abs * 0.7));
          const g = Math.round(255 * (1 - abs * 0.5));
          const b = 255;
          return `rgb(${r},${g},${b})`;
        } else {
          // White to red
          const r = 255;
          const g = Math.round(255 * (1 - abs * 0.6));
          const b = Math.round(255 * (1 - abs * 0.7));
          return `rgb(${r},${g},${b})`;
        }
      };

      // Draw cells
      for (const cell of heatmapData) {
        const cx = gridX + cell.x * cellW;
        const cy = gridY + cell.y * cellH;
        parts.push(`<rect x="${cx}" y="${cy}" width="${cellW}" height="${cellH}" fill="${heatColor(cell.v)}" stroke="#fff" stroke-width="1"/>`);
        // Show correlation value in cell
        if (cellW >= 20 && cellH >= 16) {
          const textColor = Math.abs(cell.v) > 0.6 ? "#fff" : "#333";
          const fontSize = Math.min(10, Math.max(7, cellW / 4));
          parts.push(`<text x="${cx + cellW / 2}" y="${cy + cellH / 2 + fontSize / 3}" text-anchor="middle" font-size="${fontSize}" fill="${textColor}">${cell.v.toFixed(2)}</text>`);
        }
      }

      // Y-axis labels (left side)
      for (let i = 0; i < gridSize; i++) {
        const y = gridY + i * cellH + cellH / 2 + 3;
        const lbl = shortLabel(heatmapLabels[i] || `${i}`, 14);
        parts.push(`<text x="${gridX - 6}" y="${y}" text-anchor="end" font-size="9" fill="#444">${escapeXml(lbl)}</text>`);
      }

      // X-axis labels (bottom, rotated)
      for (let i = 0; i < gridSize; i++) {
        const x = gridX + i * cellW + cellW / 2;
        const y = gridY + gridHeight + 10;
        const lbl = shortLabel(heatmapLabels[i] || `${i}`, 14);
        parts.push(`<text x="${x}" y="${y}" text-anchor="end" font-size="9" fill="#444" transform="rotate(-45, ${x}, ${y})">${escapeXml(lbl)}</text>`);
      }

      // Color legend
      const legendW = 120, legendH = 10;
      const legendX = gridX + gridWidth / 2 - legendW / 2;
      const legendY = plotBottomY + 42;
      const gradSteps = 20;
      for (let i = 0; i < gradSteps; i++) {
        const v = -1 + (2 * i) / (gradSteps - 1);
        const sx = legendX + (i / gradSteps) * legendW;
        parts.push(`<rect x="${sx}" y="${legendY}" width="${legendW / gradSteps + 1}" height="${legendH}" fill="${heatColor(v)}"/>`);
      }
      parts.push(`<text x="${legendX}" y="${legendY + legendH + 12}" text-anchor="middle" font-size="8" fill="#666">-1</text>`);
      parts.push(`<text x="${legendX + legendW / 2}" y="${legendY + legendH + 12}" text-anchor="middle" font-size="8" fill="#666">0</text>`);
      parts.push(`<text x="${legendX + legendW}" y="${legendY + legendH + 12}" text-anchor="middle" font-size="8" fill="#666">+1</text>`);
    }
  } else {
    // Default to bar-like rendering for bar and unknown cartesian types.
    const isHorizontal = config.options?.indexAxis === "y";
    const isStacked = !!(config.options?.scales?.x?.stacked || config.options?.scales?.y?.stacked);
    const categoryCount = labels.length > 0
      ? labels.length
      : Math.max(0, ...datasets.map((d) => Array.isArray(d?.data) ? d.data.length : 0));

    if (categoryCount === 0 || datasets.length === 0) {
      drawNoDataMessage("No categorical values available for bar chart.");
    } else {
      // Parse numeric values per dataset per category
      const numericValues = datasets.map((ds) => Array.from({ length: categoryCount }, (_, i) => {
        const raw = Array.isArray(ds?.data) ? ds.data[i] : null;
        if (Array.isArray(raw) && raw.length >= 2) {
          const low = asNumber(raw[0]);
          const high = asNumber(raw[1]);
          if (low !== null && high !== null) return Math.max(low, high);
          return null;
        }
        const n = raw && typeof raw === "object" ? asNumber(raw.y) : asNumber(raw);
        return n;
      }));

      if (isHorizontal) {
        // --- Horizontal bar rendering (indexAxis: "y") ---
        // Value axis is X (horizontal), category axis is Y (vertical)
        const allVals = numericValues.flatMap(row => row.filter((v): v is number => v !== null));
        if (allVals.length === 0) {
          drawNoDataMessage("No numeric bar values available.");
        } else {
          const minVal = Math.min(0, ...allVals);
          const maxVal = Math.max(...allVals);
          const [safeMin, safeMax] = normaliseRange(minVal, maxVal);
          // Draw horizontal grid lines and value axis labels along bottom
          for (let i = 0; i <= 4; i++) {
            const t = i / 4;
            const x = plotX + t * plotWidth;
            const value = safeMin + t * (safeMax - safeMin);
            parts.push(`<line x1="${x}" y1="${plotY}" x2="${x}" y2="${plotBottomY}" stroke="#ececec" stroke-width="1"/>`);
            parts.push(`<text x="${x}" y="${plotBottomY + 16}" text-anchor="middle" font-size="9" fill="#666">${escapeXml(formatTick(value))}</text>`);
          }
          parts.push(`<line x1="${plotX}" y1="${plotBottomY}" x2="${plotX + plotWidth}" y2="${plotBottomY}" stroke="#999" stroke-width="1"/>`);
          parts.push(`<line x1="${plotX}" y1="${plotY}" x2="${plotX}" y2="${plotBottomY}" stroke="#999" stroke-width="1"/>`);

          const groupHeight = plotHeight / categoryCount;
          const innerPadding = Math.min(8, groupHeight * 0.18);
          const barSlotH = Math.max(groupHeight - innerPadding, 2);
          const barH = Math.max(1.6, Math.min(28, barSlotH / Math.max(datasets.length, 1)));
          const mapX = (v: number): number => mapLinear(v, safeMin, safeMax, plotX, plotX + plotWidth);
          const baselineX = mapX(0);

          for (let i = 0; i < categoryCount; i++) {
            const yStart = plotY + i * groupHeight + innerPadding / 2;
            for (let dsIndex = 0; dsIndex < datasets.length; dsIndex++) {
              const val = numericValues[dsIndex][i];
              if (val === null) continue;
              const xEnd = mapX(val);
              const rectX = Math.min(baselineX, xEnd);
              const rectW = Math.max(1, Math.abs(xEnd - baselineX));
              const y = yStart + dsIndex * barH;
              const fill = pickColor(dsIndex, datasets[dsIndex]?.backgroundColor);
              parts.push(`<rect x="${rectX}" y="${y}" width="${rectW}" height="${Math.max(1, barH - 1)}" fill="${fill}" fill-opacity="0.78" rx="1.4"/>`);
            }
          }

          // Category labels on Y axis
          const maxTickLabels = 20;
          const tickStep = Math.max(1, Math.ceil(categoryCount / maxTickLabels));
          for (let i = 0; i < categoryCount; i += tickStep) {
            const y = plotY + i * groupHeight + groupHeight / 2 + 3;
            const text = shortLabel(labels[i] || `${i + 1}`, 18);
            parts.push(`<text x="${plotX - 6}" y="${y}" text-anchor="end" font-size="9" fill="#666">${escapeXml(text)}</text>`);
          }
        }
      } else if (isStacked) {
        // --- Stacked bar rendering ---
        // Compute cumulative sums per category for stacking
        const stackSums = Array.from({ length: categoryCount }, (_, i) => {
          let sum = 0;
          for (let dsIndex = 0; dsIndex < datasets.length; dsIndex++) {
            const val = numericValues[dsIndex][i];
            if (val !== null && val > 0) sum += val;
          }
          return sum;
        });
        const maxStack = Math.max(...stackSums, 0);
        if (maxStack <= 0) {
          drawNoDataMessage("No positive stacked values available.");
        } else {
          const [minY, maxY] = drawCartesianFrame(0, maxStack);
          const mapY = (y: number): number => mapLinear(y, minY, maxY, plotBottomY, plotY);
          const baselineY = mapY(0);
          parts.push(`<line x1="${plotX}" y1="${baselineY}" x2="${plotX + plotWidth}" y2="${baselineY}" stroke="#c9c9c9" stroke-width="1"/>`);

          const groupWidth = plotWidth / categoryCount;
          const innerPadding = Math.min(10, groupWidth * 0.18);
          const barWidth = Math.max(2, groupWidth - innerPadding);

          for (let i = 0; i < categoryCount; i++) {
            let cumY = 0;
            const xStart = plotX + i * groupWidth + innerPadding / 2;
            for (let dsIndex = 0; dsIndex < datasets.length; dsIndex++) {
              const val = numericValues[dsIndex][i];
              if (val === null || val <= 0) continue;
              const yBottom = mapY(cumY);
              const yTop = mapY(cumY + val);
              const rectY = Math.min(yTop, yBottom);
              const rectH = Math.max(1, Math.abs(yBottom - yTop));
              const fill = pickColor(dsIndex, datasets[dsIndex]?.backgroundColor);
              parts.push(`<rect x="${xStart}" y="${rectY}" width="${Math.max(1, barWidth - 1)}" height="${rectH}" fill="${fill}" fill-opacity="0.78" rx="1.4"/>`);
              cumY += val;
            }
          }

          const maxTickLabels = 15;
          const tickStep = Math.max(1, Math.ceil(categoryCount / maxTickLabels));
          const useRotation = categoryCount > 8;
          for (let i = 0; i < categoryCount; i += tickStep) {
            const x = plotX + i * groupWidth + groupWidth / 2;
            const text = shortLabel(labels[i] || `${i + 1}`, useRotation ? 18 : 14);
            if (useRotation) {
              parts.push(`<text x="${x}" y="${plotBottomY + 12}" text-anchor="end" font-size="8" fill="#666" transform="rotate(-35, ${x}, ${plotBottomY + 12})">${escapeXml(text)}</text>`);
            } else {
              parts.push(`<text x="${x}" y="${plotBottomY + 16}" text-anchor="middle" font-size="9" fill="#666">${escapeXml(text)}</text>`);
            }
          }
        }
      } else {
        // --- Default grouped bar rendering ---
        const valueRanges = datasets.map((ds) => Array.from({ length: categoryCount }, (_, i) => {
          const raw = Array.isArray(ds?.data) ? ds.data[i] : null;
          if (Array.isArray(raw) && raw.length >= 2) {
            const low = asNumber(raw[0]);
            const high = asNumber(raw[1]);
            if (low !== null && high !== null) {
              return { low: Math.min(low, high), high: Math.max(low, high) };
            }
            return null;
          }
          const n = raw && typeof raw === "object" ? asNumber(raw.y) : asNumber(raw);
          if (n === null) return null;
          return { low: Math.min(0, n), high: Math.max(0, n) };
        }));
        const allLow = valueRanges.flatMap((row) => row.map((v) => v?.low).filter((v): v is number => typeof v === "number"));
        const allHigh = valueRanges.flatMap((row) => row.map((v) => v?.high).filter((v): v is number => typeof v === "number"));
        if (allLow.length === 0 || allHigh.length === 0) {
          drawNoDataMessage("No numeric bar values available.");
        } else {
          const [minY, maxY] = drawCartesianFrame(Math.min(...allLow), Math.max(...allHigh));
          const mapY = (y: number): number => mapLinear(y, minY, maxY, plotBottomY, plotY);
          const baselineY = mapY(0);
          parts.push(`<line x1="${plotX}" y1="${baselineY}" x2="${plotX + plotWidth}" y2="${baselineY}" stroke="#c9c9c9" stroke-width="1"/>`);

          const groupWidth = plotWidth / categoryCount;
          const innerPadding = Math.min(10, groupWidth * 0.18);
          const barSlotWidth = Math.max(groupWidth - innerPadding, 2);
          const barWidth = Math.max(1.6, Math.min(36, barSlotWidth / Math.max(datasets.length, 1)));

          for (let i = 0; i < categoryCount; i++) {
            const xStart = plotX + i * groupWidth + innerPadding / 2;
            for (let dsIndex = 0; dsIndex < datasets.length; dsIndex++) {
              const range = valueRanges[dsIndex][i];
              if (!range) continue;
              const yTop = mapY(range.high);
              const yBottom = mapY(range.low);
              const rectY = Math.min(yTop, yBottom);
              const rectH = Math.max(1, Math.abs(yBottom - yTop));
              const x = xStart + dsIndex * barWidth;
              const fill = pickColor(dsIndex, datasets[dsIndex]?.backgroundColor);
              parts.push(`<rect x="${x}" y="${rectY}" width="${Math.max(1, barWidth - 1)}" height="${rectH}" fill="${fill}" fill-opacity="0.78" rx="1.4"/>`);
            }
          }

          const maxTickLabels = 15;
          const tickStep = Math.max(1, Math.ceil(categoryCount / maxTickLabels));
          const useRotation = categoryCount > 8;
          for (let i = 0; i < categoryCount; i += tickStep) {
            const x = plotX + i * groupWidth + groupWidth / 2;
            const text = shortLabel(labels[i] || `${i + 1}`, useRotation ? 18 : 14);
            if (useRotation) {
              parts.push(`<text x="${x}" y="${plotBottomY + 12}" text-anchor="end" font-size="8" fill="#666" transform="rotate(-35, ${x}, ${plotBottomY + 12})">${escapeXml(text)}</text>`);
            } else {
              parts.push(`<text x="${x}" y="${plotBottomY + 16}" text-anchor="middle" font-size="9" fill="#666">${escapeXml(text)}</text>`);
            }
          }
        }
      }
    }
  }

  // Render axis titles from config (applies to all cartesian chart types)
  if (chartType !== "pie" && chartType !== "doughnut" && chartType !== "heatmap") {
    const xTitle = config.options?.scales?.x?.title;
    if (xTitle?.display && xTitle?.text) {
      const axisLabel = shortLabel(xTitle.text, 50);
      parts.push(`<text x="${plotX + plotWidth / 2}" y="${plotBottomY + 52}" text-anchor="middle" font-size="11" fill="#444" font-weight="500">${escapeXml(axisLabel)}</text>`);
    }
    const yTitle = config.options?.scales?.y?.title;
    if (yTitle?.display && yTitle?.text) {
      const axisLabel = shortLabel(yTitle.text, 50);
      parts.push(`<text x="${plotX - 46}" y="${plotY + plotHeight / 2}" text-anchor="middle" font-size="11" fill="#444" font-weight="500" transform="rotate(-90, ${plotX - 46}, ${plotY + plotHeight / 2})">${escapeXml(axisLabel)}</text>`);
    }
  }

  // Shared legend for non-pie charts
  if (chartType !== "pie" && chartType !== "doughnut" && chartType !== "heatmap" && datasets.length > 0) {
    const legendCount = Math.min(datasets.length, 6);
    const legendColumns = Math.min(3, legendCount);
    const legendRows = Math.ceil(legendCount / legendColumns);
    const legendStartY = height - 18 - (legendRows - 1) * 14;
    const legendCellW = plotWidth / legendColumns;
    for (let i = 0; i < legendCount; i++) {
      const row = Math.floor(i / legendColumns);
      const col = i % legendColumns;
      const x = plotX + col * legendCellW;
      const y = legendStartY + row * 14;
      const color = pickColor(i, datasets[i]?.backgroundColor || datasets[i]?.borderColor);
      const label = shortLabel(datasets[i]?.label || `Dataset ${i + 1}`, 28);
      parts.push(`<rect x="${x}" y="${y - 8}" width="9" height="9" fill="${color}"/>`);
      parts.push(`<text x="${x + 13}" y="${y}" font-size="9" fill="#666">${escapeXml(label)}</text>`);
    }
  }

  parts.push(`</svg>`);
  return Buffer.from(parts.join(""), "utf-8");
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
  // Strip non-ASCII characters that would render as garbled text in SVG→PNG conversion
  const ascii = str.replace(/[^\x20-\x7E]/g, "").trim();
  return ascii.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  const analysisInputs = deterministicPlan?.analysisInputs;
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
    const allData: { name: string; data: Record<string, any>[]; columns: string[]; totalRows: number }[] = [];

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
          onDtaProgress: async ({ rowsParsed, totalRows }) => {
            if (ds.fileType !== "dta") return;
            const now = Date.now();
            const isFinal = totalRows > 0 && rowsParsed >= totalRows;
            if (!isFinal && now - lastDtaProgressLogAt < 5_000) return;
            lastDtaProgressLogAt = now;
            await publishProgress(
              `[INFO] DTA parse progress ${ds.originalName}: ${rowsParsed.toLocaleString()}/${totalRows.toLocaleString()} rows (${formatMemoryUsageSnapshot()})`,
              {
                phase: "parsing_datasets",
                persist: false,
              },
            );
          },
        });
        // Remove the local file immediately after parsing to free disk space
        // and avoid keeping both on-disk and in-memory copies
        try { fs.unlinkSync(localPath); } catch {}
        try { global.gc?.(); } catch {}
        allData.push({ name: ds.originalName, ...parsed });
        await publishProgress(
          `[INFO] Parsed ${ds.originalName}: ${parsed.totalRows} rows, ${parsed.columns.length} columns (encoding: ${parsed.encoding || "native"}, ${formatMemoryUsageSnapshot()})`,
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
        for (const ds of allData) {
          applyColumnRenameMap(ds, buildAsciiColumnRenameMap(ds.columns, colTranslations));
        }
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
      for (const ds of allData) {
        applyColumnRenameMap(ds, buildAsciiColumnRenameMap(ds.columns));
      }
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
    const analysisBundle = buildAnalysisComputationBundle(allData, analysisTopic, analysisInputs, executableMethods);
    await publishProgress("[INFO] Shared estimator bundle ready.", {
      phase: "building_analysis_bundle",
      persist: true,
    });
    await publishProgress("[INFO] Computing chart definitions from real data...", {
      phase: "computing_chart_definitions",
      persist: true,
    });
    const chartDefinitions = generateDefaultCharts(allData, executableMethods, analysisTopic, analysisInputs, analysisBundle);
    await publishProgress(`[INFO] Chart definitions ready: ${chartDefinitions.length}`, {
      phase: "computing_chart_definitions",
      persist: true,
    });
    await publishProgress("[INFO] Computing table definitions from real data...", {
      phase: "computing_table_definitions",
      persist: true,
    });
    const tableDefinitions = generateDefaultTables(allData, executableMethods, analysisTopic, analysisInputs, analysisBundle);
    await publishProgress(`[INFO] Table definitions ready: ${tableDefinitions.length}`, {
      phase: "computing_table_definitions",
      persist: true,
    });
    await publishProgress("[INFO] Computing analytical metrics from real data...", {
      phase: "computing_metrics",
      persist: true,
    });
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
      }
      for (const key of Object.keys(metrics)) {
        if (/[^\x00-\x7F]/.test(key)) nonAsciiSet.add(key);
      }
      for (const cd of chartDefinitions) {
        if (/[^\x00-\x7F]/.test(cd.description)) nonAsciiSet.add(cd.description);
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
      }
      const fallbackMetrics: Record<string, number | string> = {};
      for (const [key, val] of Object.entries(metrics)) {
        fallbackMetrics[tr(key)] = val;
      }
      for (const key of Object.keys(metrics)) delete metrics[key];
      Object.assign(metrics, fallbackMetrics);
      for (const cd of chartDefinitions) {
        cd.description = tr(cd.description);
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
          (chartDef as any).width || 800,
          (chartDef as any).height || 500
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
        const headerRow = tableDef.headers.join(",");
        const dataRows = tableDef.rows.map((r: (string | number)[]) => r.join(",")).join("\n");
        const csvContent = `${headerRow}\n${dataRows}`;

        const tableKey = `experiments/${runId}/${tableDef.name}.csv`;
        const { url } = await storagePut(tableKey, csvContent, "text/csv");
        tables.push({
          name: tableDef.name,
          url,
          description: tableDef.description || tableDef.name,
          data: `${headerRow}\n${dataRows.split("\n").slice(0, 20).join("\n")}`,
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
    const x = Number(row[xCol]);
    const y = Number(row[yCol]);
    if (!isNaN(x) && !isNaN(y)) pairs.push([x, y]);
  }
  return pairs;
}

function getFiniteNumericValues(ds: ParsedDataset, col: string, limit = 2500): number[] {
  const values: number[] = [];
  for (const row of ds.data) {
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

/**
 * Approximate two-tailed p-value for a t-statistic with given degrees of freedom.
 * For df > 30, uses a normal approximation via the Abramowitz & Stegun formula.
 * For smaller df, uses conservative threshold-based estimation.
 */
function approxTwoTailPValue(t: number, df: number): number {
  const absT = Math.abs(t);
  if (df > 30) {
    // Normal approximation: P(Z > |t|) using A&S 26.2.17
    const z = absT;
    const p = 0.2316419;
    const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
    const tVal = 1 / (1 + p * z);
    const phi = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    const oneTail = phi * (b1 * tVal + b2 * tVal ** 2 + b3 * tVal ** 3 + b4 * tVal ** 4 + b5 * tVal ** 5);
    return Math.min(1, Math.max(0, 2 * oneTail));
  }
  // Small sample: conservative thresholds
  if (absT > 3.291) return 0.005;
  if (absT > 2.576) return 0.01;
  if (absT > 1.96) return 0.05;
  if (absT > 1.645) return 0.1;
  if (absT > 1.282) return 0.2;
  return 0.5;
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
  return ds.columns.filter(c => /(year|month|date|time|wave|period|quarter)/i.test(c));
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
    let score = 0;
    if (/(treat|treatment|intervention|policy|program|exposure|assignment|eligible)/i.test(col)) score += 5;
    if (/(post|after)/i.test(col)) score += 1;
    if (isBinaryLikeColumn(ds, col)) score += 3;
    if (score > 0) scored.set(col, Math.max(score, scored.get(col) || 0));
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
    if (normalized.includes(keyword)) score += keyword.length >= 7 ? 3 : 2;
    if (keyword.startsWith("mental") && /(mental|depress|anxiety|stress|distress|wellbeing|well being|health|happiness|satisfaction|ghq|phq|gad|k6|k10|cesd|who5|sf12|sf36)/i.test(normalized)) score += 3;
    if (keyword.startsWith("health") && /(health|ghq|phq|gad|k6|k10|cesd|who5|sf12|sf36)/i.test(normalized)) score += 3;
    if (/(labou?r|employment|job|wage|income|earnings|salary|hours|unemployment)/i.test(keyword) && /(employment|job|wage|income|earnings|salary|hours|unemployment|labou?r)/i.test(normalized)) score += 3;
  }
  return score;
}

function detectOutcomeColumns(ds: ParsedDataset, numericCols: string[], topic?: string): string[] {
  const topicKeywords = extractTopicKeywords(topic);
  const scored = new Map<string, number>();
  for (const col of numericCols) {
    let score = 1;
    if (/(outcome|target|response|score|rate|risk|income|wage|price|cost|value|metric|performance|sales|earnings|mortality|health|mental|depress|anxiety|stress|wellbeing|happiness|satisfaction|employment|unemployment|hours|productivity|ghq|phq|gad|k6|k10|cesd|who5|sf12|sf36)/i.test(col)) score += 5;
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
  const primaryOutcomeCol = outcomeCols[0] || numericCols[0];
  const primaryInstrumentCol = instrumentCols[0];
  const primaryTreatmentCol =
    treatmentCols.find(col => col !== primaryOutcomeCol && col !== primaryInstrumentCol) ||
    treatmentCols.find(col => col !== primaryOutcomeCol) ||
    treatmentCols[0];
  const primaryRegressorCol =
    (primaryTreatmentCol && primaryTreatmentCol !== primaryOutcomeCol ? primaryTreatmentCol : undefined) ||
    numericCols.find(col => col !== primaryOutcomeCol);

  return mergeAnalysisInputsIntoDesignHints(ds, {
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
    primaryEntityCol: entityCols[0],
    primaryTreatmentCol,
    primaryOutcomeCol,
    primaryRegressorCol,
    primaryInstrumentCol,
    primaryRunningCol: runningCols[0],
  }, analysisInputs);
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
  const primaryRegressorCol = hints.primaryRegressorCol && hints.primaryRegressorCol !== yCol
    ? hints.primaryRegressorCol
    : undefined;
  const candidateControls = uniqueColumns(hints.controlCols)
    .filter(column => column !== yCol && column !== primaryRegressorCol);
  const controlCols = candidateControls.filter(column => isRegressionCompatibleColumn(ds, column));
  const omittedControlCols = candidateControls.filter(column => !controlCols.includes(column));
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
      .map(row => coerceRegressionValue(row[column]))
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
      let value = coerceRegressionValue(row[column]);
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
      let value = coerceRegressionValue(row[column]);
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
  const ciLower = coefficients.map((coefficient, index) => coefficient - 1.96 * standardErrors[index]);
  const ciUpper = coefficients.map((coefficient, index) => coefficient + 1.96 * standardErrors[index]);

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

export function generateDefaultCharts(
  allData: { name: string; data: Record<string, any>[]; columns: string[]; totalRows: number }[],
  executableMethods: Set<string> | null,
  analysisTopic = "",
  analysisInputs?: AnalysisInputs,
  analysisBundle?: AnalysisComputationBundle | null,
): { name: string; description: string; config: any }[] {
  const charts: { name: string; description: string; config: any }[] = [];
  const bundle = resolveAnalysisComputationBundle(allData, analysisTopic, analysisInputs, executableMethods, analysisBundle);
  const ds = bundle?.ds || getPrimaryDataset(allData);
  if (!ds || ds.data.length === 0) return charts;

  const numericCols = bundle?.meaningfulNumericCols || [];
  const categoricalCols = bundle?.categoricalCols || [];
  const designHints = bundle?.designHints;
  const primaryDescriptiveCol = bundle?.primaryDescriptiveCol;
  const secondaryDescriptiveCol = bundle?.secondaryDescriptiveCol;
  const robustOls = bundle?.robustOls || null;
  const panelFixedEffects = bundle?.panelFixedEffects || null;
  const diffInDiff = bundle?.diffInDiff || null;
  const syntheticControl = bundle?.syntheticControl || null;
  const syntheticControlPlacebos = bundle?.syntheticControlPlacebos || null;
  const iv2Sls = bundle?.iv2Sls || null;
  const rdd = bundle?.rdd || null;
  const propensityScore = bundle?.propensityScore || null;
  const quantileRegression = bundle?.quantileRegression || null;
  if (!designHints) return charts;

  // Chart 1: Distribution of first numeric column (histogram-like bar chart)
  if (primaryDescriptiveCol && methodAllowed(executableMethods, "descriptive_statistics")) {
    const col = primaryDescriptiveCol;
    const values = ds.data.map(r => Number(r[col])).filter(v => !isNaN(v));
    if (values.length > 0) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const binCount = Math.min(10, Math.ceil(Math.sqrt(values.length)));
      const binWidth = (max - min) / binCount || 1;
      const bins = Array(binCount).fill(0);
      const labels: string[] = [];

      for (let i = 0; i < binCount; i++) {
        const mid = min + (i + 0.5) * binWidth;
        // Use short midpoint labels to prevent overlap in SVG fallback
        const isInteger = Number.isInteger(min) && Number.isInteger(max) && binWidth >= 1;
        labels.push(isInteger ? Math.round(mid).toString() : mid.toFixed(1));
      }
      for (const v of values) {
        const idx = Math.min(Math.floor((v - min) / binWidth), binCount - 1);
        bins[idx]++;
      }

      // Truncate column name for display
      const displayCol = col.length > 40 ? col.slice(0, 37) + "..." : col;

      charts.push({
        name: "distribution_histogram",
        description: `Distribution of ${displayCol} (n=${values.length})`,
        config: {
          type: "bar",
          data: {
            labels,
            datasets: [{
              label: displayCol,
              data: bins,
              backgroundColor: "rgba(78, 121, 167, 0.7)",
              borderColor: "rgba(78, 121, 167, 1)",
              borderWidth: 1,
            }],
          },
          options: {
            plugins: { title: { display: true, text: `Distribution of ${displayCol}`, font: { size: 16 } } },
            scales: { y: { title: { display: true, text: "Frequency" } }, x: { title: { display: true, text: displayCol } } },
          },
        },
      });
    }
  }

  // Chart 2: Scatter plot of best-correlated numeric pair (with regression line if applicable)
  if (numericCols.length >= 2 && methodAllowed(executableMethods, "correlation")) {
    // Find the pair with highest absolute correlation (scan up to 15 pairs)
    let bestAbsCorr = -1;
    let xCol = secondaryDescriptiveCol || numericCols[0];
    let yCol = primaryDescriptiveCol || numericCols[1];
    const pairLimit = Math.min(numericCols.length, 6); // up to C(6,2)=15 pairs
    for (let ai = 0; ai < pairLimit; ai++) {
      for (let bi = ai + 1; bi < pairLimit; bi++) {
        const pairs = parseNumericPairs(ds, numericCols[ai], numericCols[bi]);
        if (pairs.length < 5) continue;
        const reg = regressionStatsFromPairs(pairs);
        const absCorr = reg ? Math.sqrt(reg.r2) : 0;
        if (absCorr > bestAbsCorr) {
          bestAbsCorr = absCorr;
          xCol = numericCols[ai];
          yCol = numericCols[bi];
        }
      }
    }
    const points = ds.data
      .map(r => ({ x: Number(r[xCol]), y: Number(r[yCol]) }))
      .filter(p => !isNaN(p.x) && !isNaN(p.y) && isFinite(p.x) && isFinite(p.y))
      .slice(0, 200);

    if (points.length >= 5) {
      const displayXCol = xCol.length > 30 ? xCol.slice(0, 27) + "..." : xCol;
      const displayYCol = yCol.length > 30 ? yCol.slice(0, 27) + "..." : yCol;

      const datasets: any[] = [{
        label: `${displayXCol} vs ${displayYCol}`,
        data: points,
        backgroundColor: "rgba(242, 142, 43, 0.6)",
        borderColor: "rgba(242, 142, 43, 1)",
        pointRadius: 3,
        type: "scatter",
      }];

      // Add regression line if linear_regression is executable
      let titleSuffix = "";
      if (methodAllowed(executableMethods, "linear_regression") && points.length >= 10) {
        const pairs: [number, number][] = points.map(p => [p.x, p.y]);
        const reg = regressionStatsFromPairs(pairs);
        if (reg && reg.r2 > 0) {
          const xMin = Math.min(...points.map(p => p.x));
          const xMax = Math.max(...points.map(p => p.x));
          const linePoints = [
            { x: xMin, y: reg.intercept + reg.slope * xMin },
            { x: xMax, y: reg.intercept + reg.slope * xMax },
          ];
          datasets.push({
            label: `y = ${reg.slope.toFixed(3)}x + ${reg.intercept.toFixed(3)} (R²=${reg.r2.toFixed(3)})`,
            data: linePoints,
            type: "scatter",
            showLine: true,
            pointRadius: 0,
            borderColor: "rgba(225, 87, 89, 1)",
            borderWidth: 2,
            borderDash: [6, 3],
            fill: false,
          });
          titleSuffix = ` (R²=${reg.r2.toFixed(3)})`;
        }
      }

      charts.push({
        name: "scatter_plot",
        description: `Scatter plot: ${displayXCol} vs ${displayYCol}${titleSuffix}`,
        config: {
          type: "scatter",
          data: { datasets },
          options: {
            plugins: { title: { display: true, text: `${displayXCol} vs ${displayYCol}${titleSuffix}`, font: { size: 16 } } },
            scales: {
              x: { title: { display: true, text: displayXCol } },
              y: { title: { display: true, text: displayYCol } },
            },
          },
        },
      });
    }
  }

  // Chart 3: Bar chart by categorical column (if available)
  if (categoricalCols.length > 0 && primaryDescriptiveCol && methodAllowed(executableMethods, "group_comparison")) {
    const catCol = categoricalCols[0];
    const numCol = primaryDescriptiveCol;
    const groups: Record<string, number[]> = {};
    for (const row of ds.data) {
      const key = String(row[catCol] ?? "N/A").slice(0, 30);
      if (!groups[key]) groups[key] = [];
      groups[key].push(Number(row[numCol]));
    }
    const sortedKeys = Object.keys(groups).sort().slice(0, 20);
    const means = sortedKeys.map(k => {
      const vals = groups[k].filter(v => !isNaN(v));
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    });

    const displayCatCol = catCol.length > 30 ? catCol.slice(0, 27) + "..." : catCol;
    const displayNumCol = numCol.length > 30 ? numCol.slice(0, 27) + "..." : numCol;

    charts.push({
      name: "category_comparison",
      description: `Mean ${displayNumCol} by ${displayCatCol}`,
      config: {
        type: "bar",
        data: {
          labels: sortedKeys,
          datasets: [{
            label: `Mean ${displayNumCol}`,
            data: means.map(m => Math.round(m * 100) / 100),
            backgroundColor: "rgba(225, 87, 89, 0.7)",
            borderColor: "rgba(225, 87, 89, 1)",
            borderWidth: 1,
          }],
        },
        options: {
          plugins: { title: { display: true, text: `Mean ${displayNumCol} by ${displayCatCol}`, font: { size: 16 } } },
          scales: { y: { title: { display: true, text: `Mean ${displayNumCol}` } } },
        },
      },
    });
  }

  // Chart 4: Correlation heatmap (if multiple numeric cols)
  if (numericCols.length >= 3 && methodAllowed(executableMethods, "correlation")) {
    const cols = numericCols.slice(0, 8);
    const displayCols = cols.map(c => c.length > 15 ? c.slice(0, 12) + "..." : c);
    const heatmapData: { x: number; y: number; v: number }[] = [];
    for (let ci = 0; ci < cols.length; ci++) {
      for (let cj = 0; cj < cols.length; cj++) {
        const pairs = parseNumericPairs(ds, cols[ci], cols[cj]);
        const n = pairs.length;
        let corr = ci === cj ? 1 : 0;
        if (ci !== cj && n >= 3) {
          const m1 = pairs.reduce((s, p) => s + p[0], 0) / n;
          const m2 = pairs.reduce((s, p) => s + p[1], 0) / n;
          let num = 0, d1 = 0, d2 = 0;
          for (const [a, b] of pairs) {
            num += (a - m1) * (b - m2);
            d1 += (a - m1) ** 2;
            d2 += (b - m2) ** 2;
          }
          corr = d1 > 0 && d2 > 0 ? num / Math.sqrt(d1 * d2) : 0;
        }
        corr = Math.round(corr * 100) / 100;
        heatmapData.push({ x: ci, y: cj, v: corr });
      }
    }

    charts.push({
      name: "correlation_matrix",
      description: `Correlation heatmap of numeric variables`,
      config: {
        type: "heatmap",
        data: {
          labels: displayCols,
          datasets: [{ data: heatmapData }],
        },
        options: {
          plugins: {
            title: { display: true, text: "Correlation Matrix", font: { size: 16 } },
          },
        },
      },
    });
  }

  // Chart 5: Pie chart of first categorical column (if available)
  if (categoricalCols.length > 0 && methodAllowed(executableMethods, "descriptive_statistics")) {
    const catCol = categoricalCols[0];
    const counts: Record<string, number> = {};
    for (const row of ds.data) {
      const key = String(row[catCol] ?? "N/A").slice(0, 30);
      counts[key] = (counts[key] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const topN = sorted.slice(0, 10);
    const otherCount = sorted.slice(10).reduce((sum, [, c]) => sum + c, 0);
    if (otherCount > 0) topN.push(["Other", otherCount]);

    const displayCatCol = catCol.length > 30 ? catCol.slice(0, 27) + "..." : catCol;
    const pieColors = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc949", "#af7aa1", "#ff9da7", "#9c755f", "#bab0ab", "#86bcb6"];

    charts.push({
      name: "category_distribution",
      description: `Distribution of ${displayCatCol}`,
      config: {
        type: "pie",
        data: {
          labels: topN.map(([k]) => k),
          datasets: [{
            data: topN.map(([, v]) => v),
            backgroundColor: pieColors.slice(0, topN.length),
          }],
        },
        options: {
          plugins: { title: { display: true, text: `Distribution of ${displayCatCol}`, font: { size: 16 } } },
        },
      },
    });
  }

  // Chart 6: Time trend line chart (if time-like columns exist)
  const timeCols = ds.columns.filter(c => /(year|month|date|time|wave|period|quarter)/i.test(c));
  if (timeCols.length > 0 && primaryDescriptiveCol && methodAllowed(executableMethods, "time_trend")) {
    const timeCol = timeCols[0];
    const numCol = primaryDescriptiveCol;

    // Aggregate by time value (mean of numeric col per time point)
    const timeGroups: Record<string, number[]> = {};
    for (const row of ds.data) {
      const tRaw = row[timeCol];
      const val = Number(row[numCol]);
      if (tRaw === null || tRaw === undefined || tRaw === "" || isNaN(val)) continue;
      const tKey = String(tRaw);
      if (!timeGroups[tKey]) timeGroups[tKey] = [];
      timeGroups[tKey].push(val);
    }
    const sortedTimeKeys = Object.keys(timeGroups).sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    }).slice(0, 50);
    const timeMeans = sortedTimeKeys.map(k => {
      const vals = timeGroups[k];
      return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
    });

    if (sortedTimeKeys.length >= 3) {
      const displayTimeCol = timeCol.length > 30 ? timeCol.slice(0, 27) + "..." : timeCol;
      const displayNumCol = numCol.length > 30 ? numCol.slice(0, 27) + "..." : numCol;

      // Compute linear trend line
      const trendDatasets: any[] = [{
        label: `Mean ${displayNumCol}`,
        data: timeMeans,
        borderColor: "#4e79a7",
        backgroundColor: "rgba(78, 121, 167, 0.1)",
        tension: 0.1,
        fill: true,
      }];

      // Add linear trend line
      if (sortedTimeKeys.length >= 5) {
        const xVals = sortedTimeKeys.map((_, i) => i);
        const trendPairs: [number, number][] = xVals.map((x, i) => [x, timeMeans[i]]);
        const trendReg = regressionStatsFromPairs(trendPairs);
        if (trendReg) {
          const trendLine = xVals.map(x => Math.round((trendReg.intercept + trendReg.slope * x) * 1000) / 1000);
          trendDatasets.push({
            label: `Trend (slope=${trendReg.slope.toFixed(3)})`,
            data: trendLine,
            borderColor: "rgba(225, 87, 89, 0.8)",
            borderWidth: 2,
            borderDash: [6, 3],
            pointRadius: 0,
            fill: false,
          });
        }
      }

      charts.push({
        name: "time_trend",
        description: `Trend of ${displayNumCol} over ${displayTimeCol}`,
        config: {
          type: "line",
          data: {
            labels: sortedTimeKeys,
            datasets: trendDatasets,
          },
          options: {
            plugins: { title: { display: true, text: `Trend of ${displayNumCol} over ${displayTimeCol}`, font: { size: 16 } } },
            scales: {
              x: { title: { display: true, text: displayTimeCol } },
              y: { title: { display: true, text: `Mean ${displayNumCol}` } },
            },
          },
        },
      });
    }
  }

  // Chart 7: Box plot approximation (floating bar showing Q1–Q3 with median marker)
  if (categoricalCols.length > 0 && primaryDescriptiveCol && methodAllowed(executableMethods, "group_comparison")) {
    const catCol = categoricalCols[0];
    const numCol = primaryDescriptiveCol;
    const groups: Record<string, number[]> = {};
    for (const row of ds.data) {
      const key = String(row[catCol] ?? "N/A").slice(0, 30);
      const val = Number(row[numCol]);
      if (isNaN(val)) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push(val);
    }
    const sortedKeys = Object.keys(groups).sort().slice(0, 15);
    const boxStats = sortedKeys.map(k => {
      const vals = groups[k].sort((a, b) => a - b);
      const q1Idx = Math.floor(vals.length * 0.25);
      const medIdx = Math.floor(vals.length * 0.5);
      const q3Idx = Math.floor(vals.length * 0.75);
      return {
        q1: vals[q1Idx] ?? 0,
        median: vals[medIdx] ?? 0,
        q3: vals[q3Idx] ?? 0,
        min: vals[0] ?? 0,
        max: vals[vals.length - 1] ?? 0,
      };
    });

    if (boxStats.length >= 2) {
      const displayCatCol = catCol.length > 30 ? catCol.slice(0, 27) + "..." : catCol;
      const displayNumCol = numCol.length > 30 ? numCol.slice(0, 27) + "..." : numCol;

      charts.push({
        name: "box_plot_approx",
        description: `Box plot of ${displayNumCol} by ${displayCatCol}`,
        config: {
          type: "bar",
          data: {
            labels: sortedKeys,
            datasets: [
              {
                label: "Q1–Q3 range",
                data: boxStats.map(s => [s.q1, s.q3]),
                backgroundColor: "rgba(78, 121, 167, 0.5)",
                borderColor: "rgba(78, 121, 167, 1)",
                borderWidth: 1,
                borderSkipped: false,
              },
              {
                label: "Median",
                data: boxStats.map(s => s.median),
                type: "line",
                borderColor: "rgba(225, 87, 89, 1)",
                backgroundColor: "rgba(225, 87, 89, 0.8)",
                pointRadius: 5,
                pointStyle: "rectRot",
                showLine: false,
              },
            ],
          },
          options: {
            plugins: { title: { display: true, text: `Box Plot: ${displayNumCol} by ${displayCatCol}`, font: { size: 16 } } },
            scales: {
              y: { title: { display: true, text: displayNumCol } },
              x: { title: { display: true, text: displayCatCol } },
            },
          },
        },
      });
    }
  }

  // Chart 8: Grouped bar chart (multiple numeric variables by category)
  if (categoricalCols.length > 0 && numericCols.length >= 2 && methodAllowed(executableMethods, "group_comparison")) {
    const catCol = categoricalCols[0];
    const useCols = Array.from(new Set([primaryDescriptiveCol, secondaryDescriptiveCol, ...numericCols].filter(Boolean) as string[])).slice(0, 4);
    const groups: Record<string, Record<string, number[]>> = {};
    for (const row of ds.data) {
      const key = String(row[catCol] ?? "N/A").slice(0, 30);
      if (!groups[key]) groups[key] = {};
      for (const nc of useCols) {
        if (!groups[key][nc]) groups[key][nc] = [];
        const val = Number(row[nc]);
        if (!isNaN(val)) groups[key][nc].push(val);
      }
    }
    const sortedKeys = Object.keys(groups).sort().slice(0, 15);
    const barColors = ["rgba(78, 121, 167, 0.7)", "rgba(242, 142, 43, 0.7)", "rgba(225, 87, 89, 0.7)", "rgba(118, 183, 178, 0.7)"];
    const borderColors = ["rgba(78, 121, 167, 1)", "rgba(242, 142, 43, 1)", "rgba(225, 87, 89, 1)", "rgba(118, 183, 178, 1)"];

    if (sortedKeys.length >= 2) {
      const displayCatCol = catCol.length > 30 ? catCol.slice(0, 27) + "..." : catCol;

      charts.push({
        name: "grouped_bar_multivar",
        description: `Grouped comparison of ${useCols.length} variables by ${displayCatCol}`,
        config: {
          type: "bar",
          data: {
            labels: sortedKeys,
            datasets: useCols.map((nc, idx) => {
              const displayNc = nc.length > 20 ? nc.slice(0, 17) + "..." : nc;
              return {
                label: `Mean ${displayNc}`,
                data: sortedKeys.map(k => {
                  const vals = (groups[k]?.[nc] || []).filter(v => !isNaN(v));
                  return vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : 0;
                }),
                backgroundColor: barColors[idx % barColors.length],
                borderColor: borderColors[idx % borderColors.length],
                borderWidth: 1,
              };
            }),
          },
          options: {
            plugins: { title: { display: true, text: `Comparison by ${displayCatCol}`, font: { size: 16 } } },
            scales: { y: { title: { display: true, text: "Mean value" } }, x: { title: { display: true, text: displayCatCol } } },
          },
        },
      });
    }
  }

  // Chart 9: Density plot (KDE approximation) for first numeric column
  if (primaryDescriptiveCol && methodAllowed(executableMethods, "descriptive_statistics")) {
    const col = primaryDescriptiveCol;
    const values = ds.data.map(r => Number(r[col])).filter(v => !isNaN(v));
    if (values.length >= 20) {
      const sorted = [...values].sort((a, b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const range = max - min || 1;
      // Silverman's rule of thumb for bandwidth
      const std = Math.sqrt(values.reduce((s, v) => s + (v - values.reduce((a, b) => a + b, 0) / values.length) ** 2, 0) / values.length);
      const bandwidth = 1.06 * std * Math.pow(values.length, -0.2) || range / 20;
      const gridSize = 50;
      const step = range / gridSize;
      const xPoints: number[] = [];
      const yPoints: number[] = [];
      for (let i = 0; i <= gridSize; i++) {
        const x = min + i * step;
        xPoints.push(Math.round(x * 100) / 100);
        // Gaussian KDE
        let density = 0;
        for (const v of values) {
          const u = (x - v) / bandwidth;
          density += Math.exp(-0.5 * u * u) / (bandwidth * Math.sqrt(2 * Math.PI));
        }
        density /= values.length;
        yPoints.push(Math.round(density * 10000) / 10000);
      }

      const displayCol = col.length > 40 ? col.slice(0, 37) + "..." : col;
      charts.push({
        name: "density_plot",
        description: `Density estimate of ${displayCol} (KDE, n=${values.length})`,
        config: {
          type: "line",
          data: {
            labels: xPoints.map(String),
            datasets: [{
              label: `Density of ${displayCol}`,
              data: yPoints,
              borderColor: "rgba(118, 183, 178, 1)",
              backgroundColor: "rgba(118, 183, 178, 0.3)",
              fill: true,
              tension: 0.4,
              pointRadius: 0,
            }],
          },
          options: {
            plugins: { title: { display: true, text: `Density Estimate: ${displayCol}`, font: { size: 16 } } },
            scales: {
              x: { title: { display: true, text: displayCol } },
              y: { title: { display: true, text: "Density" } },
            },
          },
        },
      });
    }
  }

  // Chart 10: Pairwise scatter matrix (top correlated pairs beyond the main scatter)
  if (numericCols.length >= 3 && methodAllowed(executableMethods, "correlation")) {
    // Collect all pairwise correlations
    const pairCorrs: { a: string; b: string; absCorr: number; corr: number }[] = [];
    const pairLimit = Math.min(numericCols.length, 8);
    for (let ai = 0; ai < pairLimit; ai++) {
      for (let bi = ai + 1; bi < pairLimit; bi++) {
        const pairs = parseNumericPairs(ds, numericCols[ai], numericCols[bi]);
        if (pairs.length < 5) continue;
        const reg = regressionStatsFromPairs(pairs);
        if (!reg) continue;
        const sign = reg.slope >= 0 ? 1 : -1;
        const corr = sign * Math.sqrt(reg.r2);
        pairCorrs.push({ a: numericCols[ai], b: numericCols[bi], absCorr: Math.abs(corr), corr: Math.round(corr * 100) / 100 });
      }
    }
    // Sort by absolute correlation, take top 4 (skip first since Chart 2 already shows it)
    pairCorrs.sort((a, b) => b.absCorr - a.absCorr);
    const topPairs = pairCorrs.slice(1, 5); // skip the #1 pair already shown in Chart 2

    if (topPairs.length >= 2) {
      // Create a multi-scatter with up to 4 sub-series
      const scatterColors = ["rgba(78, 121, 167, 0.5)", "rgba(242, 142, 43, 0.5)", "rgba(225, 87, 89, 0.5)", "rgba(118, 183, 178, 0.5)"];
      const scatterBorders = ["rgba(78, 121, 167, 1)", "rgba(242, 142, 43, 1)", "rgba(225, 87, 89, 1)", "rgba(118, 183, 178, 1)"];
      const scatterDatasets = topPairs.map((pc, idx) => {
        const points = parseNumericPairs(ds, pc.a, pc.b).slice(0, 200).map(([x, y]) => ({ x, y }));
        const da = pc.a.length > 12 ? pc.a.slice(0, 10) + ".." : pc.a;
        const db = pc.b.length > 12 ? pc.b.slice(0, 10) + ".." : pc.b;
        return {
          label: `${da} vs ${db} (r=${pc.corr})`,
          data: points,
          backgroundColor: scatterColors[idx],
          borderColor: scatterBorders[idx],
          pointRadius: 2,
        };
      });

      charts.push({
        name: "pairwise_scatter",
        description: `Pairwise scatter of top correlated variable pairs`,
        config: {
          type: "scatter",
          data: { datasets: scatterDatasets },
          options: {
            plugins: { title: { display: true, text: "Pairwise Scatter (Top Correlations)", font: { size: 16 } } },
          },
        },
      });
    }
  }

  // Chart 11: Methodology applicability/readiness overview
  if (methodAllowed(executableMethods, "data_visualisation")) {
    const applicability = buildMethodApplicabilityAssessment(ds, numericCols, categoricalCols);
    if (applicability.length > 0) {
      const topMethods = applicability
        .slice()
        .sort((a, b) => b.readinessScore - a.readinessScore)
        .slice(0, 10);
      const labels = topMethods.map(item => item.label.length > 22 ? `${item.label.slice(0, 19)}...` : item.label);
      const scores = topMethods.map(item => item.readinessScore);
      const colors = topMethods.map(item => {
        if (item.status === "executable_now") return "rgba(89, 161, 79, 0.75)";
        if (item.status === "partially_ready") return "rgba(237, 201, 73, 0.8)";
        return "rgba(225, 87, 89, 0.75)";
      });

      charts.push({
        name: "method_applicability_overview",
        description: "Readiness profile of major statistical methodologies (0-100 scale)",
        config: {
          type: "bar",
          data: {
            labels,
            datasets: [{
              label: "Method readiness (0-100)",
              data: scores,
              backgroundColor: colors,
              borderColor: "rgba(68, 68, 68, 0.9)",
              borderWidth: 1,
            }],
          },
          options: {
            plugins: {
              title: {
                display: true,
                text: "Methodology Applicability Overview",
                font: { size: 16 },
              },
            },
            scales: {
              y: {
                min: 0,
                max: 100,
                title: { display: true, text: "Readiness score (0-100)" },
              },
              x: {
                title: { display: true, text: "Methodology" },
              },
            },
          },
        },
      });
    }
  }

  // Chart 12: Stacked bar chart (proportional composition per category)
  if (categoricalCols.length > 0 && numericCols.length >= 2 && methodAllowed(executableMethods, "group_comparison")) {
    const catCol = categoricalCols[0];
    const useCols = numericCols.slice(0, 4);
    const groups: Record<string, Record<string, number[]>> = {};
    for (const row of ds.data) {
      const key = String(row[catCol] ?? "N/A").slice(0, 30);
      if (!groups[key]) groups[key] = {};
      for (const nc of useCols) {
        if (!groups[key][nc]) groups[key][nc] = [];
        const val = Number(row[nc]);
        if (!isNaN(val)) groups[key][nc].push(val);
      }
    }
    const sortedKeys = Object.keys(groups).sort().slice(0, 15);
    const stackColors = ["rgba(78, 121, 167, 0.7)", "rgba(242, 142, 43, 0.7)", "rgba(225, 87, 89, 0.7)", "rgba(118, 183, 178, 0.7)"];
    const stackBorders = ["rgba(78, 121, 167, 1)", "rgba(242, 142, 43, 1)", "rgba(225, 87, 89, 1)", "rgba(118, 183, 178, 1)"];

    if (sortedKeys.length >= 2) {
      const displayCatCol = catCol.length > 30 ? catCol.slice(0, 27) + "..." : catCol;

      charts.push({
        name: "stacked_bar",
        description: `Stacked composition of ${useCols.length} variables by ${displayCatCol}`,
        config: {
          type: "bar",
          data: {
            labels: sortedKeys,
            datasets: useCols.map((nc, idx) => {
              const displayNc = nc.length > 20 ? nc.slice(0, 17) + "..." : nc;
              return {
                label: `${displayNc}`,
                data: sortedKeys.map(k => {
                  const vals = (groups[k]?.[nc] || []).filter(v => !isNaN(v));
                  return vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : 0;
                }),
                backgroundColor: stackColors[idx % stackColors.length],
                borderColor: stackBorders[idx % stackBorders.length],
                borderWidth: 1,
              };
            }),
          },
          options: {
            plugins: { title: { display: true, text: `Stacked Composition by ${displayCatCol}`, font: { size: 16 } } },
            scales: {
              x: { stacked: true, title: { display: true, text: displayCatCol } },
              y: { stacked: true, title: { display: true, text: "Mean value" } },
            },
          },
        },
      });
    }
  }

  // Chart 13: Horizontal bar chart (better readability for many categories)
  if (categoricalCols.length > 0 && numericCols.length > 0 && methodAllowed(executableMethods, "descriptive_statistics")) {
    // Try to pick different columns from Chart 3 (category frequency); use second categorical or second numeric
    const catCol = categoricalCols.length > 1 ? categoricalCols[1] : categoricalCols[0];
    const numCol = numericCols.length > 1 ? numericCols[1] : numericCols[0];
    const catGroups: Record<string, number[]> = {};
    for (const row of ds.data) {
      const key = String(row[catCol] ?? "N/A").slice(0, 30);
      if (!catGroups[key]) catGroups[key] = [];
      const val = Number(row[numCol]);
      if (!isNaN(val)) catGroups[key].push(val);
    }
    const sortedEntries = Object.entries(catGroups)
      .map(([k, vals]) => ({ label: k, mean: vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0 }))
      .sort((a, b) => b.mean - a.mean)
      .slice(0, 20);

    if (sortedEntries.length >= 5) {
      const displayCatCol = catCol.length > 30 ? catCol.slice(0, 27) + "..." : catCol;
      const displayNumCol = numCol.length > 30 ? numCol.slice(0, 27) + "..." : numCol;

      charts.push({
        name: "horizontal_bar",
        description: `Horizontal bar: mean ${displayNumCol} by ${displayCatCol}`,
        config: {
          type: "bar",
          data: {
            labels: sortedEntries.map(e => e.label),
            datasets: [{
              label: `Mean ${displayNumCol}`,
              data: sortedEntries.map(e => Math.round(e.mean * 100) / 100),
              backgroundColor: "rgba(89, 161, 79, 0.7)",
              borderColor: "rgba(89, 161, 79, 1)",
              borderWidth: 1,
            }],
          },
          options: {
            indexAxis: "y" as const,
            plugins: { title: { display: true, text: `${displayNumCol} by ${displayCatCol}`, font: { size: 16 } } },
            scales: {
              x: { title: { display: true, text: displayNumCol } },
              y: { title: { display: true, text: displayCatCol } },
            },
          },
        },
      });
    }
  }

  if (methodAllowed(executableMethods, "data_visualisation")) {
    const coefficientRows: Array<{ label: string; low: number; high: number }> = [];
    if (robustOls && methodAllowed(executableMethods, "robust_ols")) {
      coefficientRows.push({
        label: `Robust OLS: ${robustOls.yCol.length > 12 ? `${robustOls.yCol.slice(0, 10)}..` : robustOls.yCol}`,
        low: Math.round(robustOls.ciLower * 1000) / 1000,
        high: Math.round(robustOls.ciUpper * 1000) / 1000,
      });
    }
    if (panelFixedEffects && methodAllowed(executableMethods, "panel_fixed_effects")) {
      coefficientRows.push({
        label: `Panel FE: ${panelFixedEffects.yCol.length > 12 ? `${panelFixedEffects.yCol.slice(0, 10)}..` : panelFixedEffects.yCol}`,
        low: Math.round((panelFixedEffects.beta - 1.96 * panelFixedEffects.se) * 1000) / 1000,
        high: Math.round((panelFixedEffects.beta + 1.96 * panelFixedEffects.se) * 1000) / 1000,
      });
    }
    if (iv2Sls && methodAllowed(executableMethods, "iv_2sls")) {
      coefficientRows.push({
        label: `IV 2SLS: ${iv2Sls.yCol.length > 12 ? `${iv2Sls.yCol.slice(0, 10)}..` : iv2Sls.yCol}`,
        low: Math.round(iv2Sls.ciLower * 1000) / 1000,
        high: Math.round(iv2Sls.ciUpper * 1000) / 1000,
      });
    }
    if (rdd && methodAllowed(executableMethods, "regression_discontinuity")) {
      coefficientRows.push({
        label: `RDD jump: ${rdd.outcomeCol.length > 12 ? `${rdd.outcomeCol.slice(0, 10)}..` : rdd.outcomeCol}`,
        low: Math.round((rdd.estimate - 1.96 * rdd.se) * 1000) / 1000,
        high: Math.round((rdd.estimate + 1.96 * rdd.se) * 1000) / 1000,
      });
    }
    if (propensityScore && methodAllowed(executableMethods, "propensity_score")) {
      coefficientRows.push({
        label: `IPW ATE: ${propensityScore.outcomeCol.length > 12 ? `${propensityScore.outcomeCol.slice(0, 10)}..` : propensityScore.outcomeCol}`,
        low: Math.round(propensityScore.ciLower * 1000) / 1000,
        high: Math.round(propensityScore.ciUpper * 1000) / 1000,
      });
    }
    if (coefficientRows.length > 0) {
      charts.push({
        name: "coefficient_interval_plot",
        description: "Coefficient interval plot for econometric estimators with 95% confidence intervals",
        config: {
          type: "bar",
          data: {
            labels: coefficientRows.map(row => row.label),
            datasets: [{
              label: "95% confidence interval",
              data: coefficientRows.map(row => [row.low, row.high]),
              backgroundColor: "rgba(78, 121, 167, 0.45)",
              borderColor: "rgba(78, 121, 167, 1)",
              borderWidth: 1,
            }],
          },
          options: {
            indexAxis: "y" as const,
            plugins: { title: { display: true, text: "Econometric Coefficient Intervals", font: { size: 16 } } },
            scales: {
              x: { title: { display: true, text: "Coefficient range" } },
              y: { title: { display: true, text: "Estimator" } },
            },
          },
        },
      });
    }
  }

  if (robustOls && methodAllowed(executableMethods, "robust_ols")) {
    const residualPoints = robustOls.fittedResiduals.slice(0, 200).map(point => ({
      x: Math.round(point.fitted * 1000) / 1000,
      y: Math.round(point.residual * 1000) / 1000,
    }));
    if (residualPoints.length >= 12) {
      const fittedValues = residualPoints.map(point => point.x);
      charts.push({
        name: "residual_fitted_plot",
        description: `Residual-versus-fitted diagnostic for robust OLS (${robustOls.yCol} on ${robustOls.xCol})`,
        config: {
          type: "scatter",
          data: {
            datasets: [
              {
                label: "Residuals",
                data: residualPoints,
                backgroundColor: "rgba(225, 87, 89, 0.55)",
                borderColor: "rgba(225, 87, 89, 1)",
                pointRadius: 3,
              },
              {
                label: "Zero line",
                data: [
                  { x: Math.min(...fittedValues), y: 0 },
                  { x: Math.max(...fittedValues), y: 0 },
                ],
                showLine: true,
                pointRadius: 0,
                borderColor: "rgba(68, 68, 68, 0.9)",
                borderWidth: 1.5,
                borderDash: [5, 3],
              },
            ],
          },
          options: {
            plugins: { title: { display: true, text: "Residual vs Fitted Diagnostic", font: { size: 16 } } },
            scales: {
              x: { title: { display: true, text: "Fitted value" } },
              y: { title: { display: true, text: "Residual" } },
            },
          },
        },
      });
    }
  }

  if (diffInDiff && methodAllowed(executableMethods, "diff_in_diff")) {
    charts.push({
      name: "parallel_trends_plot",
      description: `Parallel-trends style group means for ${diffInDiff.outcomeCol} around the treatment window`,
      config: {
        type: "line",
        data: {
          labels: diffInDiff.series.map(point => point.label),
          datasets: [
            {
              label: "Treated mean",
              data: diffInDiff.series.map(point => Math.round(point.treatedMean * 1000) / 1000),
              borderColor: "rgba(78, 121, 167, 1)",
              backgroundColor: "rgba(78, 121, 167, 0.12)",
              tension: 0.15,
            },
            {
              label: "Control mean",
              data: diffInDiff.series.map(point => Math.round(point.controlMean * 1000) / 1000),
              borderColor: "rgba(242, 142, 43, 1)",
              backgroundColor: "rgba(242, 142, 43, 0.12)",
              tension: 0.15,
            },
          ],
        },
        options: {
          plugins: { title: { display: true, text: "Parallel Trends Diagnostic", font: { size: 16 } } },
          scales: {
            x: { title: { display: true, text: diffInDiff.timeCol } },
            y: { title: { display: true, text: diffInDiff.outcomeCol } },
          },
        },
      },
    });
  }

  if (diffInDiff && methodAllowed(executableMethods, "event_study")) {
    charts.push({
      name: "event_study_plot",
      description: `Event-study profile for ${diffInDiff.outcomeCol} relative to the pre-treatment baseline`,
      config: {
        type: "line",
        data: {
          labels: diffInDiff.series.map(point => String(point.relIndex)),
          datasets: [
            {
              label: "Relative effect",
              data: diffInDiff.series.map(point => Math.round(point.effect * 1000) / 1000),
              borderColor: "rgba(89, 161, 79, 1)",
              backgroundColor: "rgba(89, 161, 79, 0.14)",
              tension: 0.12,
            },
            {
              label: "Zero line",
              data: diffInDiff.series.map(() => 0),
              borderColor: "rgba(68, 68, 68, 0.9)",
              borderWidth: 1.2,
              borderDash: [5, 3],
              pointRadius: 0,
            },
          ],
        },
        options: {
          plugins: { title: { display: true, text: "Event Study Profile", font: { size: 16 } } },
          scales: {
            x: { title: { display: true, text: "Relative period" } },
            y: { title: { display: true, text: "Effect vs baseline" } },
          },
        },
      },
    });
  }

  if (syntheticControl && methodAllowed(executableMethods, "synthetic_control")) {
    charts.push({
      name: "synthetic_control_path",
      description: `Observed versus synthetic trajectory for ${syntheticControl.treatedUnit}`,
      config: {
        type: "line",
        data: {
          labels: syntheticControl.series.map(point => point.label),
          datasets: [
            {
              label: `Observed: ${syntheticControl.treatedUnit}`,
              data: syntheticControl.series.map(point => Math.round(point.treated * 1000) / 1000),
              borderColor: "rgba(78, 121, 167, 1)",
              backgroundColor: "rgba(78, 121, 167, 0.1)",
              tension: 0.12,
            },
            {
              label: "Synthetic control",
              data: syntheticControl.series.map(point => Math.round(point.synthetic * 1000) / 1000),
              borderColor: "rgba(225, 87, 89, 1)",
              backgroundColor: "rgba(225, 87, 89, 0.08)",
              tension: 0.12,
            },
          ],
        },
        options: {
          plugins: { title: { display: true, text: "Synthetic Control Trajectory", font: { size: 16 } } },
          scales: {
            x: { title: { display: true, text: syntheticControl.timeCol } },
            y: { title: { display: true, text: syntheticControl.outcomeCol } },
          },
        },
      },
    });

    charts.push({
      name: "synthetic_control_gap",
      description: `Gap plot for ${syntheticControl.treatedUnit} minus its synthetic control`,
      config: {
        type: "line",
        data: {
          labels: syntheticControl.series.map(point => point.label),
          datasets: [
            {
              label: "Gap",
              data: syntheticControl.series.map(point => Math.round(point.gap * 1000) / 1000),
              borderColor: "rgba(118, 183, 178, 1)",
              backgroundColor: "rgba(118, 183, 178, 0.14)",
              tension: 0.12,
            },
            {
              label: "Zero line",
              data: syntheticControl.series.map(() => 0),
              borderColor: "rgba(68, 68, 68, 0.9)",
              borderWidth: 1.2,
              borderDash: [5, 3],
              pointRadius: 0,
            },
          ],
        },
        options: {
          plugins: { title: { display: true, text: "Synthetic Control Gap Plot", font: { size: 16 } } },
          scales: {
            x: { title: { display: true, text: syntheticControl.timeCol } },
            y: { title: { display: true, text: "Observed - synthetic" } },
          },
        },
      },
    });

    const topWeights = syntheticControl.weights.slice(0, 8);
    if (topWeights.length > 0) {
      charts.push({
        name: "synthetic_control_weights",
        description: `Donor weights for the synthetic control of ${syntheticControl.treatedUnit}`,
        config: {
          type: "bar",
          data: {
            labels: topWeights.map(item => item.unit.length > 16 ? `${item.unit.slice(0, 13)}...` : item.unit),
            datasets: [{
              label: "Weight",
              data: topWeights.map(item => Math.round(item.weight * 1000) / 1000),
              backgroundColor: "rgba(237, 201, 73, 0.75)",
              borderColor: "rgba(237, 201, 73, 1)",
              borderWidth: 1,
            }],
          },
          options: {
            indexAxis: "y" as const,
            plugins: { title: { display: true, text: "Synthetic Control Donor Weights", font: { size: 16 } } },
            scales: {
              x: { title: { display: true, text: "Weight" } },
              y: { title: { display: true, text: "Donor unit" } },
            },
          },
        },
      });
    }
  }

  if (syntheticControlPlacebos && methodAllowed(executableMethods, "synthetic_control")) {
    const placeboBars = syntheticControlPlacebos.ratios.slice(0, 10);
    charts.push({
      name: "synthetic_control_placebo_rmspe",
      description: `Placebo RMSPE ratios for synthetic control around ${syntheticControlPlacebos.treatedUnit}`,
      config: {
        type: "bar",
        data: {
          labels: placeboBars.map(item => item.unit.length > 16 ? `${item.unit.slice(0, 13)}...` : item.unit),
          datasets: [{
            label: "Post / pre RMSPE",
            data: placeboBars.map(item => Math.round(item.ratio * 1000) / 1000),
            backgroundColor: placeboBars.map(item => item.isActual ? "rgba(225, 87, 89, 0.8)" : "rgba(78, 121, 167, 0.65)"),
            borderColor: placeboBars.map(item => item.isActual ? "rgba(225, 87, 89, 1)" : "rgba(78, 121, 167, 1)"),
            borderWidth: 1,
          }],
        },
        options: {
          plugins: { title: { display: true, text: "Synthetic Control Placebo RMSPE Ratios", font: { size: 16 } } },
          scales: {
            x: { title: { display: true, text: "Pseudo-treated unit" } },
            y: { title: { display: true, text: "Post / pre RMSPE" } },
          },
        },
      },
    });
  }

  if (iv2Sls && methodAllowed(executableMethods, "iv_2sls")) {
    const firstStageLine = regressionStatsFromPairs(iv2Sls.firstStagePoints.map(point => [point.x, point.y] as [number, number]));
    if (firstStageLine) {
      const xMin = Math.min(...iv2Sls.firstStagePoints.map(point => point.x));
      const xMax = Math.max(...iv2Sls.firstStagePoints.map(point => point.x));
      charts.push({
        name: "iv_first_stage_plot",
        description: `First-stage relevance plot for instrument ${iv2Sls.zCol} and treatment ${iv2Sls.xCol}`,
        config: {
          type: "scatter",
          data: {
            datasets: [
              {
                label: "Observed first stage",
                data: iv2Sls.firstStagePoints.slice(0, 200),
                backgroundColor: "rgba(78, 121, 167, 0.55)",
                borderColor: "rgba(78, 121, 167, 1)",
                pointRadius: 3,
              },
              {
                label: "First-stage fit",
                data: [
                  { x: xMin, y: firstStageLine.intercept + firstStageLine.slope * xMin },
                  { x: xMax, y: firstStageLine.intercept + firstStageLine.slope * xMax },
                ],
                showLine: true,
                pointRadius: 0,
                borderColor: "rgba(225, 87, 89, 1)",
                borderWidth: 2,
              },
            ],
          },
          options: {
            plugins: { title: { display: true, text: "IV First-Stage Relevance", font: { size: 16 } } },
            scales: {
              x: { title: { display: true, text: iv2Sls.zCol } },
              y: { title: { display: true, text: iv2Sls.xCol } },
            },
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
    const yValues = rdd.bins.map(point => point.y);
    charts.push({
      name: "rdd_plot",
      description: `RDD local-linear plot for ${rdd.outcomeCol} around cutoff ${Math.round(rdd.cutoff * 1000) / 1000}`,
      config: {
        type: "scatter",
        data: {
          datasets: [
            {
              label: "Left-of-cutoff bins",
              data: leftBins,
              backgroundColor: "rgba(78, 121, 167, 0.7)",
              borderColor: "rgba(78, 121, 167, 1)",
              pointRadius: 4,
            },
            {
              label: "Right-of-cutoff bins",
              data: rightBins,
              backgroundColor: "rgba(225, 87, 89, 0.7)",
              borderColor: "rgba(225, 87, 89, 1)",
              pointRadius: 4,
            },
            {
              label: "Left fit",
              data: fitLeft,
              showLine: true,
              pointRadius: 0,
              borderColor: "rgba(78, 121, 167, 1)",
              borderWidth: 2,
            },
            {
              label: "Right fit",
              data: fitRight,
              showLine: true,
              pointRadius: 0,
              borderColor: "rgba(225, 87, 89, 1)",
              borderWidth: 2,
            },
            {
              label: "Cutoff",
              data: [
                { x: rdd.cutoff, y: Math.min(...yValues) },
                { x: rdd.cutoff, y: Math.max(...yValues) },
              ],
              showLine: true,
              pointRadius: 0,
              borderColor: "rgba(68, 68, 68, 0.9)",
              borderWidth: 1.2,
              borderDash: [5, 3],
            },
          ],
        },
        options: {
          plugins: { title: { display: true, text: "Regression Discontinuity Plot", font: { size: 16 } } },
          scales: {
            x: { title: { display: true, text: rdd.runningCol } },
            y: { title: { display: true, text: rdd.outcomeCol } },
          },
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
    const labels = Array.from({ length: binCount }, (_, index) => `${(index / binCount).toFixed(1)}-${((index + 1) / binCount).toFixed(1)}`);
    charts.push({
      name: "propensity_overlap_plot",
      description: `Propensity-score overlap diagnostic for ${propensityScore.treatmentCol}`,
      config: {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Treated",
              data: treatedBins,
              backgroundColor: "rgba(78, 121, 167, 0.65)",
              borderColor: "rgba(78, 121, 167, 1)",
              borderWidth: 1,
            },
            {
              label: "Control",
              data: controlBins,
              backgroundColor: "rgba(242, 142, 43, 0.65)",
              borderColor: "rgba(242, 142, 43, 1)",
              borderWidth: 1,
            },
          ],
        },
        options: {
          plugins: { title: { display: true, text: "Propensity Score Overlap", font: { size: 16 } } },
          scales: {
            x: { title: { display: true, text: "Propensity-score bin" } },
            y: { title: { display: true, text: "Count" } },
          },
        },
      },
    });

    const topBalance = propensityScore.balance
      .slice()
      .sort((a, b) => Math.abs(b.smdBefore) - Math.abs(a.smdBefore))
      .slice(0, 8);
    charts.push({
      name: "love_plot",
      description: `Love plot of absolute standardised mean differences before and after weighting`,
      config: {
        type: "line",
        data: {
          labels: topBalance.map(item => item.covariate.length > 18 ? `${item.covariate.slice(0, 15)}...` : item.covariate),
          datasets: [
            {
              label: "Before weighting",
              data: topBalance.map(item => Math.round(Math.abs(item.smdBefore) * 1000) / 1000),
              borderColor: "rgba(225, 87, 89, 1)",
              backgroundColor: "rgba(225, 87, 89, 0.15)",
              pointRadius: 4,
              tension: 0,
            },
            {
              label: "After weighting",
              data: topBalance.map(item => Math.round(Math.abs(item.smdAfter) * 1000) / 1000),
              borderColor: "rgba(89, 161, 79, 1)",
              backgroundColor: "rgba(89, 161, 79, 0.15)",
              pointRadius: 4,
              tension: 0,
            },
          ],
        },
        options: {
          plugins: { title: { display: true, text: "Covariate Balance Love Plot", font: { size: 16 } } },
          scales: {
            x: { title: { display: true, text: "Covariate" } },
            y: { title: { display: true, text: "|Standardised mean difference|" } },
          },
        },
      },
    });
  }

  if (quantileRegression && methodAllowed(executableMethods, "quantile_regression")) {
    charts.push({
      name: "quantile_regression_profile",
      description: `Slope profile across conditional quantiles for ${quantileRegression.yCol}`,
      config: {
        type: "line",
        data: {
          labels: quantileRegression.estimates.map(estimate => estimate.tau.toFixed(2)),
          datasets: [{
            label: `Slope of ${quantileRegression.yCol} on ${quantileRegression.xCol}`,
            data: quantileRegression.estimates.map(estimate => Math.round(estimate.slope * 1000) / 1000),
            borderColor: "rgba(118, 183, 178, 1)",
            backgroundColor: "rgba(118, 183, 178, 0.15)",
            pointRadius: 4,
            tension: 0,
          }],
        },
        options: {
          plugins: { title: { display: true, text: "Quantile Regression Coefficient Profile", font: { size: 16 } } },
          scales: {
            x: { title: { display: true, text: "Quantile (tau)" } },
            y: { title: { display: true, text: "Slope" } },
          },
        },
      },
    });
  }

  return charts;
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

function generateDefaultTables(
  allData: { name: string; data: Record<string, any>[]; columns: string[]; totalRows: number }[],
  executableMethods: Set<string> | null,
  analysisTopic = "",
  analysisInputs?: AnalysisInputs,
  analysisBundle?: AnalysisComputationBundle | null,
): { name: string; description: string; headers: string[]; rows: (string | number)[][] }[] {
  const tables: { name: string; description: string; headers: string[]; rows: (string | number)[][] }[] = [];
  const bundle = resolveAnalysisComputationBundle(allData, analysisTopic, analysisInputs, executableMethods, analysisBundle);
  const ds = bundle?.ds || getPrimaryDataset(allData);
  if (!ds || ds.data.length === 0) return tables;

  const numericCols = bundle?.meaningfulNumericCols || [];
  const categoricalCols = bundle?.categoricalCols || [];
  const primaryDescriptiveCol = bundle?.primaryDescriptiveCol;
  const methodAssessments = bundle?.methodAssessments || [];
  const robustOls = bundle?.robustOls || null;
  const panelFixedEffects = bundle?.panelFixedEffects || null;
  const diffInDiff = bundle?.diffInDiff || null;
  const syntheticControl = bundle?.syntheticControl || null;
  const iv2Sls = bundle?.iv2Sls || null;
  const rdd = bundle?.rdd || null;
  const propensityScore = bundle?.propensityScore || null;
  const quantileRegression = bundle?.quantileRegression || null;

  // Table 1: Descriptive statistics of numeric variables
  if (numericCols.length > 0 && methodAllowed(executableMethods, "descriptive_statistics")) {
    const headers = ["Variable", "N", "Mean", "Std Dev", "Min", "Q1", "Median", "Q3", "Max", "Skewness"];
    const rows: (string | number)[][] = [];

    for (const col of numericCols.slice(0, 20)) {
      const values = ds.data.map(r => Number(r[col])).filter(v => !isNaN(v));
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      const n = values.length;
      const mean = values.reduce((a, b) => a + b, 0) / n;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1 || 1);
      const std = Math.sqrt(variance);
      const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
      const q1 = sorted[Math.floor(n * 0.25)];
      const q3 = sorted[Math.floor(n * 0.75)];

      // Skewness
      let skewness = 0;
      if (std > 0 && n > 2) {
        const m3 = values.reduce((a, b) => a + ((b - mean) / std) ** 3, 0) / n;
        skewness = m3;
      }

      const displayCol = col.length > 30 ? col.slice(0, 27) + "..." : col;

      rows.push([
        displayCol,
        n,
        Math.round(mean * 1000) / 1000,
        Math.round(std * 1000) / 1000,
        Math.round(sorted[0] * 1000) / 1000,
        Math.round(q1 * 1000) / 1000,
        Math.round(median * 1000) / 1000,
        Math.round(q3 * 1000) / 1000,
        Math.round(sorted[n - 1] * 1000) / 1000,
        Math.round(skewness * 1000) / 1000,
      ]);
    }

    if (rows.length > 0) {
      tables.push({
        name: "descriptive_statistics",
        description: "Descriptive statistics of numeric variables",
        headers,
        rows,
      });
    }
  }

  // Table 2: Cross-tabulation / frequency table of categorical columns
  if (categoricalCols.length > 0 && methodAllowed(executableMethods, "group_comparison")) {
    const catCol = categoricalCols[0];
    const counts: Record<string, number> = {};
    for (const row of ds.data) {
      const key = String(row[catCol] ?? "N/A").slice(0, 50);
      counts[key] = (counts[key] || 0) + 1;
    }
    const sortedKeys = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30);
    const total = ds.data.length;

    const displayCatCol = catCol.length > 30 ? catCol.slice(0, 27) + "..." : catCol;

    tables.push({
      name: "frequency_table",
      description: `Frequency distribution of ${displayCatCol}`,
      headers: [displayCatCol, "Count", "Percentage", "Cumulative %"],
      rows: (() => {
        let cumPct = 0;
        return sortedKeys.map(([key, count]) => {
          const pct = (count / total) * 100;
          cumPct += pct;
          return [
            key,
            count,
            `${pct.toFixed(1)}%`,
            `${cumPct.toFixed(1)}%`,
          ];
        });
      })(),
    });
  }

  // Table 3: Correlation matrix (if enough numeric columns)
  if (numericCols.length >= 2 && methodAllowed(executableMethods, "correlation")) {
    const cols = numericCols.slice(0, 10);
    const displayCols = cols.map(c => c.length > 15 ? c.slice(0, 12) + "..." : c);
    const headers = ["Variable", ...displayCols];
    const rows: (string | number)[][] = [];

    for (let i = 0; i < cols.length; i++) {
      const row: (string | number)[] = [displayCols[i]];
      for (let j = 0; j < cols.length; j++) {
        const v1 = ds.data.map(r => Number(r[cols[i]])).filter(v => !isNaN(v));
        const v2 = ds.data.map(r => Number(r[cols[j]])).filter(v => !isNaN(v));
        const n = Math.min(v1.length, v2.length);
        if (n < 3) { row.push(0); continue; }
        const m1 = v1.slice(0, n).reduce((a, b) => a + b, 0) / n;
        const m2 = v2.slice(0, n).reduce((a, b) => a + b, 0) / n;
        let num = 0, d1 = 0, d2 = 0;
        for (let k = 0; k < n; k++) {
          num += (v1[k] - m1) * (v2[k] - m2);
          d1 += (v1[k] - m1) ** 2;
          d2 += (v2[k] - m2) ** 2;
        }
        const corr = d1 > 0 && d2 > 0 ? num / Math.sqrt(d1 * d2) : 0;
        row.push(Math.round(corr * 1000) / 1000);
      }
      rows.push(row);
    }

    tables.push({
      name: "correlation_matrix",
      description: "Pearson correlation matrix of numeric variables",
      headers,
      rows,
    });
  }

  // Table 4: Regression results (if linear_regression is executable)
  if (numericCols.length >= 2 && methodAllowed(executableMethods, "linear_regression")) {
    const regressionHeaders = ["Dep. Var", "Indep. Var", "Coeff (beta)", "Std. Error", "t-stat", "p-value", "R²", "Adj. R²", "N"];
    const regressionRows: (string | number)[][] = [];

    const pairsEvaluated: { xCol: string; yCol: string; reg: { slope: number; intercept: number; r2: number; n: number }; se: number; tStat: number; pValue: number }[] = [];

    for (let i = 0; i < Math.min(numericCols.length, 6); i++) {
      for (let j = i + 1; j < Math.min(numericCols.length, 6); j++) {
        const xCol = numericCols[i];
        const yCol = numericCols[j];
        const pairs = parseNumericPairs(ds, xCol, yCol);
        const reg = regressionStatsFromPairs(pairs);
        if (!reg || reg.n < 10) continue;

        // Compute standard error, t-statistic, p-value
        let ssRes = 0;
        let ssX = 0;
        const meanX = pairs.reduce((a, p) => a + p[0], 0) / reg.n;
        for (const [x, y] of pairs) {
          const pred = reg.intercept + reg.slope * x;
          ssRes += (y - pred) ** 2;
          ssX += (x - meanX) ** 2;
        }
        const mse = ssRes / (reg.n - 2);
        const se = ssX > 0 ? Math.sqrt(mse / ssX) : 0;
        const tStat = se > 0 ? reg.slope / se : 0;
        const pValue = approximateCorrelationPValue(Math.sqrt(reg.r2) * Math.sign(reg.slope), reg.n);

        pairsEvaluated.push({ xCol, yCol, reg, se, tStat, pValue });
      }
    }

    // Sort by R² descending, take top 5
    pairsEvaluated.sort((a, b) => b.reg.r2 - a.reg.r2);
    for (const pe of pairsEvaluated.slice(0, 5)) {
      const displayX = pe.xCol.length > 15 ? pe.xCol.slice(0, 12) + "..." : pe.xCol;
      const displayY = pe.yCol.length > 15 ? pe.yCol.slice(0, 12) + "..." : pe.yCol;
      const adjR2 = 1 - (1 - pe.reg.r2) * (pe.reg.n - 1) / (pe.reg.n - 2);
      const pStr = pe.pValue < 0.001 ? "<0.001" : pe.pValue.toFixed(4);

      regressionRows.push([
        displayY,
        displayX,
        Math.round(pe.reg.slope * 10000) / 10000,
        Math.round(pe.se * 10000) / 10000,
        Math.round(pe.tStat * 1000) / 1000,
        pStr,
        Math.round(pe.reg.r2 * 1000) / 1000,
        Math.round(adjR2 * 1000) / 1000,
        pe.reg.n,
      ]);
    }

    if (regressionRows.length > 0) {
      tables.push({
        name: "regression_results",
        description: "OLS regression results (top models by R²)",
        headers: regressionHeaders,
        rows: regressionRows,
      });
    }
  }

  // Table 5: Group comparison with significance (if group_comparison is executable)
  if (categoricalCols.length > 0 && primaryDescriptiveCol && methodAllowed(executableMethods, "group_comparison")) {
    const catCol = categoricalCols[0];
    const numCol = primaryDescriptiveCol;

    const groups: Record<string, number[]> = {};
    for (const row of ds.data) {
      const key = String(row[catCol] ?? "").trim();
      const val = Number(row[numCol]);
      if (!key || isNaN(val)) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push(val);
    }

    const validGroupEntries = Object.entries(groups).filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 15);

    if (validGroupEntries.length >= 2) {
      const displayCatCol = catCol.length > 20 ? catCol.slice(0, 17) + "..." : catCol;
      const displayNumCol = numCol.length > 20 ? numCol.slice(0, 17) + "..." : numCol;

      const compHeaders = [displayCatCol, "N", `Mean ${displayNumCol}`, "Std Dev", "Min", "Max"];
      const compRows: (string | number)[][] = [];

      // Compute grand stats
      const allVals = validGroupEntries.flatMap(([, v]) => v);
      const grandMean = allVals.reduce((a, b) => a + b, 0) / allVals.length;

      for (const [key, vals] of validGroupEntries) {
        const n = vals.length;
        const mean = vals.reduce((a, b) => a + b, 0) / n;
        const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1 || 1));
        const sorted = [...vals].sort((a, b) => a - b);
        const displayKey = key.length > 20 ? key.slice(0, 17) + "..." : key;

        compRows.push([
          displayKey,
          n,
          Math.round(mean * 1000) / 1000,
          Math.round(std * 1000) / 1000,
          Math.round(sorted[0] * 1000) / 1000,
          Math.round(sorted[n - 1] * 1000) / 1000,
        ]);
      }

      // Add ANOVA F-test summary row
      let ssBetween = 0;
      let ssWithin = 0;
      const totalN = allVals.length;
      const k = validGroupEntries.length;
      for (const [, vals] of validGroupEntries) {
        const groupMean = vals.reduce((a, b) => a + b, 0) / vals.length;
        ssBetween += vals.length * (groupMean - grandMean) ** 2;
        for (const v of vals) ssWithin += (v - groupMean) ** 2;
      }
      const dfBetween = k - 1;
      const dfWithin = totalN - k;
      const fStat = dfWithin > 0 && dfBetween > 0 ? (ssBetween / dfBetween) / (ssWithin / dfWithin) : 0;
      const eta2 = ssBetween / (ssBetween + ssWithin);

      // Approximate F-test p-value
      const fPValue = fStat > 6.63 ? "<0.001" : fStat > 3.84 ? "<0.05" : fStat > 2.71 ? "<0.10" : ">0.10";

      compRows.push([
        `F(${dfBetween},${dfWithin})=${Math.round(fStat * 100) / 100}, p${fPValue}, eta²=${Math.round(eta2 * 1000) / 1000}`,
        totalN, "", "", "", "",
      ]);

      tables.push({
        name: "group_comparison",
        description: `Group comparison: ${displayNumCol} by ${displayCatCol} (ANOVA)`,
        headers: compHeaders,
        rows: compRows,
      });
    }
  }

  // Table 6: Missing data summary
  {
    const headers = ["Variable", "N Total", "N Missing", "Missing %", "N Valid", "Data Type"];
    const rows: (string | number)[][] = [];

    for (const col of ds.columns.slice(0, 30)) {
      let missing = 0;
      let numericCount = 0;
      let totalNonNull = 0;

      for (const row of ds.data) {
        const val = row[col];
        if (isMissingValue(val)) {
          missing++;
        } else {
          totalNonNull++;
          if (typeof val === "number" || (typeof val === "string" && !isNaN(Number(val)) && val.trim() !== "")) {
            numericCount++;
          }
        }
      }

      const dataType = totalNonNull > 0 && numericCount / totalNonNull > 0.7 ? "Numeric" : "Categorical";
      const displayCol = col.length > 30 ? col.slice(0, 27) + "..." : col;

      rows.push([
        displayCol,
        ds.data.length,
        missing,
        `${((missing / ds.data.length) * 100).toFixed(1)}%`,
        ds.data.length - missing,
        dataType,
      ]);
    }

    tables.push({
      name: "missing_data_summary",
      description: "Missing data summary by variable",
      headers,
      rows,
    });
  }

  // Table 7: Methodology applicability matrix
  if (methodAssessments.length > 0) {
    tables.push({
      name: "method_applicability_matrix",
      description: "Applicability matrix for major statistical methodologies on the current dataset",
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

  if (robustOls && methodAllowed(executableMethods, "robust_ols")) {
    tables.push({
      name: "robust_ols_results",
      description: `Multivariate OLS results for ${robustOls.yCol} on ${robustOls.xCol}${robustOls.controlCols.length > 0 ? ` with controls ${robustOls.controlCols.join(", ")}` : ""}`,
      headers: ["Outcome", "Primary regressor", "Controls", "Coeff", "SE", "SE type", "Clusters", "p-value", "95% CI", "R2", "Adj R2", "N", "Missing-data"],
      rows: [[
        robustOls.yCol.length > 18 ? `${robustOls.yCol.slice(0, 15)}...` : robustOls.yCol,
        robustOls.xCol.length > 18 ? `${robustOls.xCol.slice(0, 15)}...` : robustOls.xCol,
        robustOls.controlCols.join(", ") || "none",
        Math.round(robustOls.slope * 10000) / 10000,
        Math.round(robustOls.seSlope * 10000) / 10000,
        robustOls.vcovType,
        robustOls.clusterCount || 0,
        robustOls.pValue < 0.001 ? "<0.001" : robustOls.pValue.toFixed(4),
        `[${(Math.round(robustOls.ciLower * 1000) / 1000).toFixed(3)}, ${(Math.round(robustOls.ciUpper * 1000) / 1000).toFixed(3)}]`,
        Math.round(robustOls.r2 * 1000) / 1000,
        Math.round(robustOls.adjR2 * 1000) / 1000,
        robustOls.n,
        robustOls.missingDataMode,
      ]],
    });
  }

  if (panelFixedEffects && methodAllowed(executableMethods, "panel_fixed_effects")) {
    tables.push({
      name: "panel_fixed_effects_results",
      description: `Two-way fixed-effects regression for ${panelFixedEffects.yCol} on ${panelFixedEffects.xCol}${panelFixedEffects.controlCols.length > 0 ? ` with controls ${panelFixedEffects.controlCols.join(", ")}` : ""}`,
      headers: ["Outcome", "Primary regressor", "Controls", "Beta", "SE", "SE type", "Clusters", "p-value", "Within R2", "Entities", "Periods", "N", "Missing-data"],
      rows: [[
        panelFixedEffects.yCol.length > 18 ? `${panelFixedEffects.yCol.slice(0, 15)}...` : panelFixedEffects.yCol,
        panelFixedEffects.xCol.length > 18 ? `${panelFixedEffects.xCol.slice(0, 15)}...` : panelFixedEffects.xCol,
        panelFixedEffects.controlCols.join(", ") || "none",
        Math.round(panelFixedEffects.beta * 10000) / 10000,
        Math.round(panelFixedEffects.se * 10000) / 10000,
        panelFixedEffects.vcovType,
        panelFixedEffects.clusterCount || 0,
        panelFixedEffects.pValue < 0.001 ? "<0.001" : panelFixedEffects.pValue.toFixed(4),
        Math.round(panelFixedEffects.r2Within * 1000) / 1000,
        panelFixedEffects.entities,
        panelFixedEffects.periods,
        panelFixedEffects.n,
        panelFixedEffects.missingDataMode,
      ]],
    });
  }

  if (diffInDiff && methodAllowed(executableMethods, "diff_in_diff")) {
    tables.push({
      name: "difference_in_differences",
      description: `Difference-in-differences summary for ${diffInDiff.outcomeCol}`,
      headers: ["Outcome", "Treatment", "Pre T", "Post T", "Pre C", "Post C", "DiD", "Pre-trend delta", "N"],
      rows: [[
        diffInDiff.outcomeCol.length > 18 ? `${diffInDiff.outcomeCol.slice(0, 15)}...` : diffInDiff.outcomeCol,
        diffInDiff.treatmentCol.length > 18 ? `${diffInDiff.treatmentCol.slice(0, 15)}...` : diffInDiff.treatmentCol,
        Math.round(diffInDiff.treatedPre * 1000) / 1000,
        Math.round(diffInDiff.treatedPost * 1000) / 1000,
        Math.round(diffInDiff.controlPre * 1000) / 1000,
        Math.round(diffInDiff.controlPost * 1000) / 1000,
        Math.round(diffInDiff.estimate * 1000) / 1000,
        Math.round(diffInDiff.preTrendDelta * 1000) / 1000,
        diffInDiff.n,
      ]],
    });
  }

  if (syntheticControl && methodAllowed(executableMethods, "synthetic_control")) {
    tables.push({
      name: "synthetic_control_weights",
      description: `Synthetic-control donor weights for ${syntheticControl.treatedUnit}`,
      headers: ["Treated Unit", "Donor Unit", "Weight", "Pre RMSE", "Post RMSE", "Mean Gap Post"],
      rows: syntheticControl.weights.slice(0, 10).map(item => ([
        syntheticControl.treatedUnit.length > 18 ? `${syntheticControl.treatedUnit.slice(0, 15)}...` : syntheticControl.treatedUnit,
        item.unit.length > 18 ? `${item.unit.slice(0, 15)}...` : item.unit,
        Math.round(item.weight * 1000) / 1000,
        Math.round(syntheticControl.preRmse * 1000) / 1000,
        Math.round(syntheticControl.postRmse * 1000) / 1000,
        Math.round(syntheticControl.attPostMean * 1000) / 1000,
      ])),
    });
  }

  if (iv2Sls && methodAllowed(executableMethods, "iv_2sls")) {
    tables.push({
      name: "iv_2sls_results",
      description: `Baseline just-identified 2SLS results for ${iv2Sls.yCol} on ${iv2Sls.xCol} using ${iv2Sls.zCol}`,
      headers: ["Outcome", "Endogenous Var", "Instrument", "2SLS Beta", "SE", "t-stat", "p-value", "95% CI", "1st-stage F", "N"],
      rows: [[
        iv2Sls.yCol.length > 18 ? `${iv2Sls.yCol.slice(0, 15)}...` : iv2Sls.yCol,
        iv2Sls.xCol.length > 18 ? `${iv2Sls.xCol.slice(0, 15)}...` : iv2Sls.xCol,
        iv2Sls.zCol.length > 18 ? `${iv2Sls.zCol.slice(0, 15)}...` : iv2Sls.zCol,
        Math.round(iv2Sls.beta * 10000) / 10000,
        Math.round(iv2Sls.se * 10000) / 10000,
        Math.round(iv2Sls.tStat * 1000) / 1000,
        iv2Sls.pValue < 0.001 ? "<0.001" : iv2Sls.pValue.toFixed(4),
        `[${(Math.round(iv2Sls.ciLower * 1000) / 1000).toFixed(3)}, ${(Math.round(iv2Sls.ciUpper * 1000) / 1000).toFixed(3)}]`,
        Math.round(iv2Sls.firstStageF * 1000) / 1000,
        iv2Sls.n,
      ]],
    });
  }

  if (rdd && methodAllowed(executableMethods, "regression_discontinuity")) {
    tables.push({
      name: "regression_discontinuity_results",
      description: `Local-linear regression discontinuity summary for ${rdd.outcomeCol}`,
      headers: ["Outcome", "Running Var", "Treatment Var", "Cutoff", "Bandwidth", "Jump", "SE", "p-value", "N local", "Left/Right N"],
      rows: [[
        rdd.outcomeCol.length > 18 ? `${rdd.outcomeCol.slice(0, 15)}...` : rdd.outcomeCol,
        rdd.runningCol.length > 18 ? `${rdd.runningCol.slice(0, 15)}...` : rdd.runningCol,
        rdd.treatmentCol.length > 18 ? `${rdd.treatmentCol.slice(0, 15)}...` : rdd.treatmentCol,
        Math.round(rdd.cutoff * 1000) / 1000,
        Math.round(rdd.bandwidth * 1000) / 1000,
        Math.round(rdd.estimate * 1000) / 1000,
        Math.round(rdd.se * 1000) / 1000,
        rdd.pValue < 0.001 ? "<0.001" : rdd.pValue.toFixed(4),
        rdd.nLocal,
        `${rdd.leftN}/${rdd.rightN}`,
      ]],
    });
  }

  if (propensityScore && methodAllowed(executableMethods, "propensity_score")) {
    tables.push({
      name: "propensity_score_balance",
      description: `Propensity-score balance diagnostics for ${propensityScore.treatmentCol}`,
      headers: ["Covariate", "Mean T", "Mean C", "Weighted T", "Weighted C", "SMD Before", "SMD After"],
      rows: propensityScore.balance.map(item => ([
        item.covariate.length > 18 ? `${item.covariate.slice(0, 15)}...` : item.covariate,
        Math.round(item.meanTreated * 1000) / 1000,
        Math.round(item.meanControl * 1000) / 1000,
        Math.round(item.weightedTreated * 1000) / 1000,
        Math.round(item.weightedControl * 1000) / 1000,
        Math.round(item.smdBefore * 1000) / 1000,
        Math.round(item.smdAfter * 1000) / 1000,
      ])),
    });
  }

  if (quantileRegression && methodAllowed(executableMethods, "quantile_regression")) {
    tables.push({
      name: "quantile_regression_results",
      description: `Conditional quantile-regression profile for ${quantileRegression.yCol} on ${quantileRegression.xCol}${quantileRegression.controlCols.length > 0 ? ` with controls ${quantileRegression.controlCols.join(", ")}` : ""}`,
      headers: ["Outcome", "Primary regressor", "Controls", "Tau", "Slope", "Bootstrap SE", "p-value", "95% CI", "Pseudo R1", "Bootstraps", "N", "Missing-data"],
      rows: quantileRegression.estimates.map(estimate => ([
        quantileRegression.yCol.length > 18 ? `${quantileRegression.yCol.slice(0, 15)}...` : quantileRegression.yCol,
        quantileRegression.xCol.length > 18 ? `${quantileRegression.xCol.slice(0, 15)}...` : quantileRegression.xCol,
        quantileRegression.controlCols.join(", ") || "none",
        estimate.tau,
        Math.round(estimate.slope * 1000) / 1000,
        Math.round(estimate.slopeSe * 1000) / 1000,
        estimate.pValue < 0.001 ? "<0.001" : estimate.pValue.toFixed(4),
        `[${(Math.round(estimate.ciLower * 1000) / 1000).toFixed(3)}, ${(Math.round(estimate.ciUpper * 1000) / 1000).toFixed(3)}]`,
        Math.round(estimate.pseudoR1 * 1000) / 1000,
        estimate.bootstrapReplicates,
        quantileRegression.n,
        quantileRegression.missingDataMode,
      ])),
    });
  }

  return tables;
}

export function generateDefaultMetrics(
  allData: { name: string; data: Record<string, any>[]; columns: string[]; totalRows: number }[],
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

  if (methodAllowed(executableMethods, "descriptive_statistics")) {
    for (const col of meaningfulNumericCols.slice(0, 5)) {
      const values = ds.data.map(r => Number(r[col])).filter(v => !isNaN(v));
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
