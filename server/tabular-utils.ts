/**
 * Shared helpers for turning heterogeneous uploaded files (CSV/TSV with any common
 * delimiter, Excel workbooks with title rows or several sheets, nested JSON or
 * JSON Lines) into clean rectangular records.
 */

export type Delimiter = "," | ";" | "\t" | "|";

const DELIMITER_CANDIDATES: Delimiter[] = [",", ";", "\t", "|"];

/** Splits one delimited line, honouring double-quoted fields. */
export function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(current);
      current = "";
    } else current += ch;
  }
  cells.push(current);
  return cells.map(cell => cell.trim());
}

/**
 * Picks the delimiter that splits the sample into the most consistent number of
 * fields (>1) across lines. Falls back to the extension's default.
 */
export function detectDelimiter(sample: string, fallback: Delimiter = ","): Delimiter {
  const lines = sample.split(/\r?\n/).filter(line => line.trim().length > 0).slice(0, 25);
  if (lines.length === 0) return fallback;
  let best: { delimiter: Delimiter; score: number } | null = null;
  for (const delimiter of DELIMITER_CANDIDATES) {
    const counts = lines.map(line => splitDelimitedLine(line, delimiter).length);
    const header = counts[0];
    if (header < 2) continue;
    const consistent = counts.filter(count => count === header).length / counts.length;
    const score = consistent * 10 + Math.min(header, 50) / 50;
    if (!best || score > best.score) best = { delimiter, score };
  }
  return best && best.score >= 6 ? best.delimiter : fallback;
}

/** Makes header names unique and non-empty ("", "x", "x" -> "column_1", "x", "x_2"). */
export function dedupeHeaders(headers: unknown[]): string[] {
  const used = new Map<string, number>();
  return headers.map((raw, index) => {
    let base = String(raw ?? "").replace(/^﻿/, "").replace(/\s+/g, " ").trim();
    if (!base) base = `column_${index + 1}`;
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}_${seen + 1}`;
  });
}

/** Codes that mean "missing" in any column. */
const MISSING_TOKENS = new Set([
  "", "na", "n/a", "nan", "null", "#n/a", "#na", "#value!", "#div/0!", "#null!", ".", "欠損",
]);

/**
 * Codes that statistical tables use for "not available / suppressed / nil" inside
 * numeric columns (e.g. e-Stat uses "…", "x", "-"). They are only treated as missing
 * when the rest of the column is numeric, because in a categorical column they may
 * be legitimate values.
 */
const NUMERIC_CONTEXT_MISSING = new Set(["…", "...", "***", "**", "*", "x", "X", "-", "－", "―", "‐", "—", "–"]);

/** Canonical missing-value test used during normalisation. */
export function isMissingToken(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return !Number.isFinite(value);
  if (typeof value !== "string") return false;
  return MISSING_TOKENS.has(value.trim().toLowerCase());
}

function isNumericContextMissing(value: unknown): boolean {
  return typeof value === "string" && NUMERIC_CONTEXT_MISSING.has(value.normalize("NFKC").trim());
}

const NUMERIC_TEXT = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/;

function parseNumericText(value: string): number | null {
  const text = value.normalize("NFKC").trim().replace(/[−－]/g, "-");
  if (!text || !NUMERIC_TEXT.test(text) || !/\d/.test(text)) return null;
  const n = Number(text.replace(/,/g, "").replace(/%$/, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Cleans records in place:
 *  - trims strings and maps common missing codes (NA, "…", "－", "#N/A", ...) to null;
 *  - converts columns that are numbers stored as text ("1,234", "12.5%", full-width
 *    digits) into real numbers when at least 90% of non-missing values parse.
 * Returns the names of columns converted to numeric.
 */
export function normaliseRecords(records: Record<string, any>[], columns: string[]): string[] {
  const converted: string[] = [];
  if (records.length === 0) return converted;
  for (const col of columns) {
    let textCount = 0;
    let numericTextCount = 0;
    let nonMissing = 0;
    const sampleLimit = Math.min(records.length, 5000);
    for (let i = 0; i < sampleLimit; i++) {
      const value = records[i][col];
      if (isMissingToken(value)) continue;
      if (isNumericContextMissing(value)) continue;
      nonMissing++;
      if (typeof value === "string") {
        textCount++;
        if (parseNumericText(value) !== null) numericTextCount++;
      } else if (typeof value === "number") {
        numericTextCount++;
      }
    }
    const numericColumn = nonMissing > 0 && numericTextCount / nonMissing >= 0.9;
    const convertNumeric = textCount > 0 && numericColumn;
    for (const record of records) {
      const value = record[col];
      if (value === undefined || isMissingToken(value)) {
        record[col] = null;
        continue;
      }
      if (numericColumn && isNumericContextMissing(value)) {
        record[col] = null;
        continue;
      }
      if (typeof value === "string") {
        if (convertNumeric) {
          record[col] = parseNumericText(value);
        } else {
          record[col] = value.trim();
        }
      }
    }
    if (convertNumeric) converted.push(col);
  }
  return converted;
}

/** Flattens nested objects to dotted keys (depth-limited); arrays become JSON text. */
export function flattenRecord(value: unknown, prefix = "", depth = 0, out: Record<string, any> = {}): Record<string, any> {
  if (value === null || value === undefined || typeof value !== "object") {
    out[prefix || "value"] = value ?? null;
    return out;
  }
  if (Array.isArray(value)) {
    const primitive = value.every(item => item === null || typeof item !== "object");
    out[prefix || "value"] = primitive && value.length <= 20 ? value.join("; ") : JSON.stringify(value).slice(0, 500);
    return out;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (nested && typeof nested === "object" && !Array.isArray(nested) && depth < 3) {
      flattenRecord(nested, name, depth + 1, out);
    } else if (Array.isArray(nested)) {
      const primitive = nested.every(item => item === null || typeof item !== "object");
      out[name] = primitive && nested.length <= 20 ? nested.join("; ") : JSON.stringify(nested).slice(0, 500);
    } else {
      out[name] = nested ?? null;
    }
  }
  return out;
}

/** Union of keys across records, in first-seen order. */
export function collectColumns(records: Record<string, any>[], sampleLimit = 5000): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (let i = 0; i < Math.min(records.length, sampleLimit); i++) {
    for (const key of Object.keys(records[i] || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

/**
 * Parses JSON text into flat records. Handles top-level arrays, objects wrapping an
 * array (e.g. {"data": [...]}), column-oriented objects ({"a": [..], "b": [..]}),
 * single objects, and JSON Lines / NDJSON.
 */
export function parseJsonRecords(text: string): Record<string, any>[] {
  const trimmed = text.replace(/^﻿/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // JSON Lines: one JSON value per line
    const rows: Record<string, any>[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        rows.push(flattenRecord(JSON.parse(candidate)));
      } catch {
        // skip malformed line
      }
    }
    if (rows.length > 0) return rows;
    throw new Error("File is neither valid JSON nor JSON Lines");
  }
  if (Array.isArray(parsed)) return parsed.map(item => flattenRecord(item));
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const arrayEntries = Object.entries(record).filter(([, v]) => Array.isArray(v)) as Array<[string, unknown[]]>;
    const objectArray = arrayEntries
      .filter(([, v]) => v.length > 0 && v.every(item => item && typeof item === "object" && !Array.isArray(item)))
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (objectArray) return objectArray[1].map(item => flattenRecord(item));
    // Column-oriented: every value is an array of equal length.
    if (arrayEntries.length >= 2 && arrayEntries.length === Object.keys(record).length) {
      const length = arrayEntries[0][1].length;
      if (length > 0 && arrayEntries.every(([, v]) => v.length === length)) {
        return Array.from({ length }, (_, i) => Object.fromEntries(arrayEntries.map(([k, v]) => [k, v[i] ?? null])));
      }
    }
    return [flattenRecord(record)];
  }
  return [{ value: parsed as any }];
}

/**
 * Converts a sheet given as a 2-D array into records. The header row is the first of
 * the top rows that is mostly non-numeric text and spans most of the table width,
 * which skips title/notes rows that statistical agencies often place above tables.
 */
export function sheetRowsToRecords(rows: unknown[][]): { records: Record<string, any>[]; columns: string[]; headerRowIndex: number } {
  const nonEmpty = (row: unknown[]) => row.filter(cell => cell !== null && cell !== undefined && String(cell).trim() !== "");
  const dataRows = rows.filter(row => Array.isArray(row) && nonEmpty(row).length > 0);
  if (dataRows.length === 0) return { records: [], columns: [], headerRowIndex: -1 };
  const width = Math.max(...dataRows.slice(0, 200).map(row => row.length));
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(dataRows.length, 15); i++) {
    const cells = nonEmpty(dataRows[i]);
    const textual = cells.filter(cell => typeof cell === "string" && parseNumericText(cell) === null).length;
    if (cells.length >= Math.max(2, Math.ceil(width * 0.5)) && textual / cells.length >= 0.6) {
      headerRowIndex = i;
      break;
    }
  }
  const headerRow = dataRows[headerRowIndex];
  const headers = dedupeHeaders(Array.from({ length: width }, (_, i) => headerRow[i]));
  const records: Record<string, any>[] = [];
  for (const row of dataRows.slice(headerRowIndex + 1)) {
    const record: Record<string, any> = {};
    let filled = 0;
    headers.forEach((header, i) => {
      const cell = row[i];
      const value = cell === undefined || (typeof cell === "string" && cell.trim() === "") ? null : cell;
      if (value !== null) filled++;
      record[header] = value instanceof Date ? value.toISOString().slice(0, 10) : value;
    });
    if (filled > 0) records.push(record);
  }
  // Drop columns that are entirely empty (formatting artefacts).
  const columns = headers.filter(header => records.some(record => record[header] !== null && record[header] !== undefined));
  if (columns.length < headers.length) {
    for (const record of records) {
      for (const header of headers) if (!columns.includes(header)) delete record[header];
    }
  }
  return { records, columns, headerRowIndex };
}

/** Deterministic reservoir sampler that keeps rows in their original order. */
export class OrderedReservoir<T> {
  private readonly items: Array<{ index: number; value: T }> = [];
  private seen = 0;
  private state: number;
  constructor(private readonly capacity: number, seed = 20240601) {
    this.state = seed >>> 0 || 1;
  }
  private random(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
  add(value: T): void {
    const index = this.seen++;
    if (this.items.length < this.capacity) {
      this.items.push({ index, value });
      return;
    }
    const slot = Math.floor(this.random() * (index + 1));
    if (slot < this.capacity) this.items[slot] = { index, value };
  }
  get total(): number {
    return this.seen;
  }
  values(): T[] {
    return this.items.slice().sort((a, b) => a.index - b.index).map(item => item.value);
  }
}
