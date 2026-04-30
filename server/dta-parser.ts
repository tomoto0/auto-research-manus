/**
 * Pure JavaScript Stata .dta file parser.
 * Supports DTA format versions 114, 115 (Stata 10-12) and 117-119 (Stata 13-16).
 * No native dependencies required.
 *
 * Based on the Stata DTA file format specification and StataDtaJS reference implementation.
 */

export interface DtaResult {
  data: Record<string, any>[];
  columns: string[];
  totalRows: number;
  variableLabels?: Record<string, string>;
  valueLabels?: Record<string, Record<string, string>>;
}

export interface DtaParseOptions {
  /** Only parse header + first N rows for preview. When omitted, parse all rows. */
  previewRows?: number;
}

export interface DtaAsyncParseOptions extends DtaParseOptions {
  /**
   * Yield back to the event loop every N rows so long-running parses do not
   * block heartbeats or timeout checks. Defaults to 1000.
   */
  yieldEveryRows?: number;
  onProgress?: (progress: { rowsParsed: number; totalRows: number }) => void | Promise<void>;
  signal?: AbortSignal;
}

interface OldFormatPrelude {
  littleEndian: boolean;
  nvar: number;
  nobs: number;
  typlist: number[];
  varlist: string[];
  variableLabels: Record<string, string>;
  dataOffset: number;
}

interface NewFormatPrelude {
  release: number;
  littleEndian: boolean;
  nvar: number;
  nobs: number;
  typlist: number[];
  varlist: string[];
  variableLabels: Record<string, string>;
  dataOffset: number;
}

interface DtaParseTarget {
  kind: "old" | "new";
  buf: Buffer;
}

/* ------------------------------------------------------------------ */
/*  Helper: read null-terminated string from buffer                    */
/* ------------------------------------------------------------------ */

function readString(buf: Buffer, offset: number, maxLen: number): string {
  let end = offset;
  const limit = offset + maxLen;
  while (end < limit && buf[end] !== 0) end++;
  return buf.subarray(offset, end).toString("utf-8");
}

function readFixedString(buf: Buffer, offset: number, len: number): string {
  return readString(buf, offset, len);
}

function abortError(signal?: AbortSignal): Error | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "DTA parse aborted");
}

function waitForTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function maybeYieldRows(
  rowIndex: number,
  totalRows: number,
  options?: DtaAsyncParseOptions,
): Promise<void> {
  const every = Math.max(1, options?.yieldEveryRows ?? 1000);
  if (rowIndex > 0 && rowIndex % every === 0) {
    const err = abortError(options?.signal);
    if (err) throw err;
    await options?.onProgress?.({ rowsParsed: rowIndex, totalRows });
    await waitForTurn();
  }
}

/* ------------------------------------------------------------------ */
/*  Missing value detection                                            */
/* ------------------------------------------------------------------ */

// Stata missing values for numeric types
const MISSING_BYTE_MIN = 101;
const MISSING_INT16_MIN = 32741;
const MISSING_INT32_MIN = 2147483621;

function isMissingFloat32(buf: Buffer, offset: number, le: boolean): boolean {
  const byte0 = le ? buf[offset + 3] : buf[offset];
  // Missing float32 values start with 0x7F800000 pattern (byte 0x7F or higher)
  return (byte0 & 0x7f) === 0x7f && (buf[le ? offset + 2 : offset + 1] & 0x80) !== 0;
}

function isMissingFloat64(buf: Buffer, offset: number, le: boolean): boolean {
  const byte0 = le ? buf[offset + 7] : buf[offset];
  // Missing float64 values start with 0x7FF pattern
  return (byte0 & 0x7f) === 0x7f && (buf[le ? offset + 6 : offset + 1] & 0xf0) >= 0xe0;
}

function parseOldFormatPrelude(buf: Buffer): OldFormatPrelude {
  let offset = 0;

  offset += 1; // dsFormat
  const byteOrder = buf.readUInt8(offset); offset += 1;
  const littleEndian = byteOrder === 2;

  offset += 2; // filetype + unused

  const nvar = littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
  offset += 2;
  const nobs = littleEndian ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
  offset += 4;

  offset += 81 + 18;

  const typlist: number[] = [];
  for (let i = 0; i < nvar; i++) {
    typlist.push(buf.readUInt8(offset));
    offset += 1;
  }

  const varlist: string[] = [];
  for (let i = 0; i < nvar; i++) {
    varlist.push(readFixedString(buf, offset, 33));
    offset += 33;
  }

  offset += (nvar + 1) * 2;
  offset += nvar * 49;
  offset += nvar * 33;

  const variableLabels: Record<string, string> = {};
  for (let i = 0; i < nvar; i++) {
    const label = readFixedString(buf, offset, 81);
    if (label) variableLabels[varlist[i]] = label;
    offset += 81;
  }

  while (offset + 5 <= buf.length) {
    const dataType = buf.readUInt8(offset); offset += 1;
    const dataLen = littleEndian ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
    offset += 4;
    if (dataType === 0 && dataLen === 0) break;
    offset += dataLen;
  }

  return {
    littleEndian,
    nvar,
    nobs,
    typlist,
    varlist,
    variableLabels,
    dataOffset: offset,
  };
}

function parseNewFormatPrelude(buf: Buffer): NewFormatPrelude {
  let offset = 0;

  const openTag = readFixedString(buf, 0, 11);
  if (openTag !== "<stata_dta>") {
    throw new Error(`Not a valid DTA 117+ file: expected <stata_dta>, got "${openTag}"`);
  }
  offset += 11;

  const headerIdx = findTag(buf, "<header>", offset);
  if (headerIdx < 0) throw new Error("Missing <header> tag");
  offset = headerIdx + 8;

  const releaseIdx = findTag(buf, "<release>", offset);
  if (releaseIdx < 0) throw new Error("Missing <release> tag");
  offset = releaseIdx + 9;
  const releaseStr = readFixedString(buf, offset, 3);
  const release = parseInt(releaseStr, 10);
  offset += 3;
  offset = findTag(buf, "</release>", offset) + 10;

  const boIdx = findTag(buf, "<byteorder>", offset);
  offset = boIdx + 11;
  const boStr = readFixedString(buf, offset, 3);
  const littleEndian = boStr === "LSF";
  offset += 3;
  offset = findTag(buf, "</byteorder>", offset) + 12;

  const kIdx = findTag(buf, "<K>", offset);
  offset = kIdx + 3;
  const nvar = littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
  offset += 2;
  offset = findTag(buf, "</K>", offset) + 4;

  const nIdx = findTag(buf, "<N>", offset);
  offset = nIdx + 3;
  let nobs: number;
  if (release >= 118) {
    if (littleEndian) {
      nobs = buf.readUInt32LE(offset);
    } else {
      nobs = buf.readUInt32BE(offset + 4);
    }
    offset += 8;
  } else {
    nobs = littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
    offset += 4;
  }
  offset = findTag(buf, "</N>", offset) + 4;

  offset = findTag(buf, "</header>", offset) + 9;

  const mapIdx = findTag(buf, "<map>", offset);
  offset = findTag(buf, "</map>", mapIdx) + 6;

  const vtIdx = findTag(buf, "<variable_types>", offset);
  offset = vtIdx + 16;
  const typlist: number[] = [];
  for (let i = 0; i < nvar; i++) {
    typlist.push(littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset));
    offset += 2;
  }
  offset = findTag(buf, "</variable_types>", offset) + 17;

  const vnIdx = findTag(buf, "<varnames>", offset);
  offset = vnIdx + 10;
  const varlist: string[] = [];
  const varNameLen = release >= 118 ? 129 : 33;
  for (let i = 0; i < nvar; i++) {
    varlist.push(readFixedString(buf, offset, varNameLen));
    offset += varNameLen;
  }
  offset = findTag(buf, "</varnames>", offset) + 11;

  offset = findTag(buf, "</sortlist>", offset) + 11;
  offset = findTag(buf, "</formats>", offset) + 10;
  offset = findTag(buf, "</value_label_names>", offset) + 20;

  const vlIdx = findTag(buf, "<variable_labels>", offset);
  offset = vlIdx + 17;
  const variableLabels: Record<string, string> = {};
  const varLabelLen = release >= 118 ? 321 : 81;
  for (let i = 0; i < nvar; i++) {
    const label = readFixedString(buf, offset, varLabelLen);
    if (label) variableLabels[varlist[i]] = label;
    offset += varLabelLen;
  }
  offset = findTag(buf, "</variable_labels>", offset) + 18;

  offset = findTag(buf, "</characteristics>", offset) + 18;

  const dataIdx = findTag(buf, "<data>", offset);
  offset = dataIdx + 6;

  return {
    release,
    littleEndian,
    nvar,
    nobs,
    typlist,
    varlist,
    variableLabels,
    dataOffset: offset,
  };
}

function typeWidth117Plus(typ: number): number {
  if (typ >= 1 && typ <= 2045) return typ;
  if (typ === 32768) return 8;
  if (typ === 65530) return 1;
  if (typ === 65529) return 2;
  if (typ === 65528) return 4;
  if (typ === 65527) return 4;
  if (typ === 65526) return 8;
  return 1;
}

function resolveDtaParseTarget(buf: Buffer): DtaParseTarget {
  if (buf.length < 20) {
    throw new Error("File too small to be a valid DTA file");
  }

  const firstByte = buf.readUInt8(0);
  if (firstByte === 0x3c) {
    const tag = readFixedString(buf, 0, 11);
    if (tag === "<stata_dta>") {
      return { kind: "new", buf };
    }
  }

  if (firstByte >= 102 && firstByte <= 115) {
    return { kind: "old", buf };
  }

  const headerStr = buf.subarray(0, 20).toString("utf-8");
  if (headerStr.includes("<stata_dta>")) {
    const tagOffset = headerStr.indexOf("<stata_dta>");
    return { kind: "new", buf: buf.subarray(tagOffset) };
  }

  throw new Error(
    `Unsupported DTA format. First byte: 0x${firstByte.toString(16)}. ` +
    `Supported: Stata 10-16 (format versions 102-119).`
  );
}

/* ------------------------------------------------------------------ */
/*  Format 114/115 parser (Stata 10-12)                                */
/* ------------------------------------------------------------------ */

function parseOldFormat(buf: Buffer, previewMaxRows?: number): DtaResult {
  const prelude = parseOldFormatPrelude(buf);
  let offset = prelude.dataOffset;
  const data: Record<string, any>[] = [];
  const iterRows = previewMaxRows != null ? Math.min(prelude.nobs, previewMaxRows) : prelude.nobs;

  for (let i = 0; i < iterRows; i++) {
    const row: Record<string, any> = {};
    for (let j = 0; j < prelude.nvar; j++) {
      const typ = prelude.typlist[j];
      if (typ <= 244) {
        row[prelude.varlist[j]] = readFixedString(buf, offset, typ);
        offset += typ;
      } else if (typ === 251) {
        const val = buf.readInt8(offset); offset += 1;
        row[prelude.varlist[j]] = val >= MISSING_BYTE_MIN ? null : val;
      } else if (typ === 252) {
        const val = prelude.littleEndian ? buf.readInt16LE(offset) : buf.readInt16BE(offset);
        offset += 2;
        row[prelude.varlist[j]] = val >= MISSING_INT16_MIN ? null : val;
      } else if (typ === 253) {
        const val = prelude.littleEndian ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
        offset += 4;
        row[prelude.varlist[j]] = val >= MISSING_INT32_MIN ? null : val;
      } else if (typ === 254) {
        if (isMissingFloat32(buf, offset, prelude.littleEndian)) {
          row[prelude.varlist[j]] = null;
        } else {
          row[prelude.varlist[j]] = prelude.littleEndian ? buf.readFloatLE(offset) : buf.readFloatBE(offset);
        }
        offset += 4;
      } else if (typ === 255) {
        if (isMissingFloat64(buf, offset, prelude.littleEndian)) {
          row[prelude.varlist[j]] = null;
        } else {
          row[prelude.varlist[j]] = prelude.littleEndian ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
        }
        offset += 8;
      } else {
        row[prelude.varlist[j]] = null;
        offset += 1;
      }
    }
    data.push(row);
  }

  return {
    data,
    columns: prelude.varlist,
    totalRows: prelude.nobs,
    variableLabels: prelude.variableLabels,
  };
}

/* ------------------------------------------------------------------ */
/*  Format 117-119 parser (Stata 13-16, XML-tagged)                    */
/* ------------------------------------------------------------------ */

function findTag(buf: Buffer, tag: string, startFrom: number): number {
  const tagBuf = Buffer.from(tag, "utf-8");
  const idx = buf.indexOf(tagBuf, startFrom);
  return idx;
}

function parseNewFormat(buf: Buffer, previewMaxRows?: number): DtaResult {
  const prelude = parseNewFormatPrelude(buf);
  let offset = prelude.dataOffset;
  const data: Record<string, any>[] = [];
  const iterRows = previewMaxRows != null ? Math.min(prelude.nobs, previewMaxRows) : prelude.nobs;
  const strlRefs: { rowIdx: number; varIdx: number; v: number; o: number }[] = [];

  for (let i = 0; i < iterRows; i++) {
    if (offset + 1 > buf.length) break;
    const row: Record<string, any> = {};
    let rowOk = true;
    for (let j = 0; j < prelude.nvar; j++) {
      const typ = prelude.typlist[j];
      const bytesNeeded = typeWidth117Plus(typ);
      if (offset + bytesNeeded > buf.length) { rowOk = false; break; }

      if (typ >= 1 && typ <= 2045) {
        row[prelude.varlist[j]] = readFixedString(buf, offset, typ);
        offset += typ;
      } else if (typ === 32768) {
        const v = prelude.littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
        const o = prelude.littleEndian ? buf.readUInt32LE(offset + 4) : buf.readUInt32BE(offset + 4);
        offset += 8;
        if (v === 0 && o === 0) {
          row[prelude.varlist[j]] = "";
        } else {
          row[prelude.varlist[j]] = null;
          strlRefs.push({ rowIdx: i, varIdx: j, v, o });
        }
      } else if (typ === 65530) {
        const val = buf.readInt8(offset); offset += 1;
        row[prelude.varlist[j]] = val >= MISSING_BYTE_MIN ? null : val;
      } else if (typ === 65529) {
        const val = prelude.littleEndian ? buf.readInt16LE(offset) : buf.readInt16BE(offset);
        offset += 2;
        row[prelude.varlist[j]] = val >= MISSING_INT16_MIN ? null : val;
      } else if (typ === 65528) {
        const val = prelude.littleEndian ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
        offset += 4;
        row[prelude.varlist[j]] = val >= MISSING_INT32_MIN ? null : val;
      } else if (typ === 65527) {
        if (isMissingFloat32(buf, offset, prelude.littleEndian)) {
          row[prelude.varlist[j]] = null;
        } else {
          row[prelude.varlist[j]] = prelude.littleEndian ? buf.readFloatLE(offset) : buf.readFloatBE(offset);
        }
        offset += 4;
      } else if (typ === 65526) {
        if (isMissingFloat64(buf, offset, prelude.littleEndian)) {
          row[prelude.varlist[j]] = null;
        } else {
          row[prelude.varlist[j]] = prelude.littleEndian ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
        }
        offset += 8;
      } else {
        row[prelude.varlist[j]] = null;
        offset += 1;
      }
    }
    if (!rowOk) break;
    data.push(row);
  }

  const remainingBytes = buf.length - offset;
  const skipStrlResolution = previewMaxRows != null && iterRows < prelude.nobs && remainingBytes > 10 * 1024 * 1024;
  if (skipStrlResolution && strlRefs.length > 0) {
    for (const ref of strlRefs) {
      if (ref.rowIdx < data.length) {
        data[ref.rowIdx][prelude.varlist[ref.varIdx]] = "";
      }
    }
  } else if (strlRefs.length > 0) {
    const strlsIdx = findTag(buf, "<strls>", offset);
    if (strlsIdx >= 0) {
      const neededKeys = new Set<string>();
      for (const ref of strlRefs) {
        neededKeys.add(`${ref.v}:${ref.o}`);
      }

      const strls: Record<string, Record<string, string>> = {};
      let pos = strlsIdx + 7;
      let resolvedCount = 0;

      while (pos + 3 <= buf.length) {
        const marker = readFixedString(buf, pos, 3);
        if (marker !== "GSO") break;
        pos += 3;

        const v = prelude.littleEndian ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
        pos += 4;
        let o: number;
        if (prelude.release >= 118) {
          o = prelude.littleEndian ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
          pos += 8;
        } else {
          o = prelude.littleEndian ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
          pos += 4;
        }
        const t = buf.readUInt8(pos); pos += 1;
        const len = prelude.littleEndian ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
        pos += 4;

        if (neededKeys.has(`${v}:${o}`)) {
          if (!strls[v]) strls[v] = {};
          if (t === 130) {
            strls[v][o] = readFixedString(buf, pos, len);
          } else {
            strls[v][o] = `[binary ${len} bytes]`;
          }
          resolvedCount++;
          if (resolvedCount >= neededKeys.size) {
            pos += len;
            break;
          }
        }
        pos += len;
      }

      for (const ref of strlRefs) {
        if (ref.rowIdx < data.length && strls[ref.v] && strls[ref.v][ref.o] !== undefined) {
          data[ref.rowIdx][prelude.varlist[ref.varIdx]] = strls[ref.v][ref.o];
        } else if (ref.rowIdx < data.length) {
          data[ref.rowIdx][prelude.varlist[ref.varIdx]] = "";
        }
      }
    } else {
      for (const ref of strlRefs) {
        if (ref.rowIdx < data.length) {
          data[ref.rowIdx][prelude.varlist[ref.varIdx]] = "";
        }
      }
    }
  }

  return {
    data,
    columns: prelude.varlist,
    totalRows: prelude.nobs,
    variableLabels: prelude.variableLabels,
  };
}

async function parseOldFormatAsync(
  buf: Buffer,
  previewMaxRows?: number,
  options?: DtaAsyncParseOptions,
): Promise<DtaResult> {
  const prelude = parseOldFormatPrelude(buf);
  let offset = prelude.dataOffset;
  const data: Record<string, any>[] = [];
  const iterRows = previewMaxRows != null ? Math.min(prelude.nobs, previewMaxRows) : prelude.nobs;

  for (let i = 0; i < iterRows; i++) {
    await maybeYieldRows(i, prelude.nobs, options);
    const row: Record<string, any> = {};
    for (let j = 0; j < prelude.nvar; j++) {
      const typ = prelude.typlist[j];
      if (typ <= 244) {
        row[prelude.varlist[j]] = readFixedString(buf, offset, typ);
        offset += typ;
      } else if (typ === 251) {
        const val = buf.readInt8(offset); offset += 1;
        row[prelude.varlist[j]] = val >= MISSING_BYTE_MIN ? null : val;
      } else if (typ === 252) {
        const val = prelude.littleEndian ? buf.readInt16LE(offset) : buf.readInt16BE(offset);
        offset += 2;
        row[prelude.varlist[j]] = val >= MISSING_INT16_MIN ? null : val;
      } else if (typ === 253) {
        const val = prelude.littleEndian ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
        offset += 4;
        row[prelude.varlist[j]] = val >= MISSING_INT32_MIN ? null : val;
      } else if (typ === 254) {
        if (isMissingFloat32(buf, offset, prelude.littleEndian)) {
          row[prelude.varlist[j]] = null;
        } else {
          row[prelude.varlist[j]] = prelude.littleEndian ? buf.readFloatLE(offset) : buf.readFloatBE(offset);
        }
        offset += 4;
      } else if (typ === 255) {
        if (isMissingFloat64(buf, offset, prelude.littleEndian)) {
          row[prelude.varlist[j]] = null;
        } else {
          row[prelude.varlist[j]] = prelude.littleEndian ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
        }
        offset += 8;
      } else {
        row[prelude.varlist[j]] = null;
        offset += 1;
      }
    }
    data.push(row);
  }

  await options?.onProgress?.({ rowsParsed: data.length, totalRows: prelude.nobs });

  return {
    data,
    columns: prelude.varlist,
    totalRows: prelude.nobs,
    variableLabels: prelude.variableLabels,
  };
}

async function parseNewFormatAsync(
  buf: Buffer,
  previewMaxRows?: number,
  options?: DtaAsyncParseOptions,
): Promise<DtaResult> {
  const prelude = parseNewFormatPrelude(buf);
  let offset = prelude.dataOffset;
  const data: Record<string, any>[] = [];
  const iterRows = previewMaxRows != null ? Math.min(prelude.nobs, previewMaxRows) : prelude.nobs;
  const strlRefs: { rowIdx: number; varIdx: number; v: number; o: number }[] = [];

  for (let i = 0; i < iterRows; i++) {
    await maybeYieldRows(i, prelude.nobs, options);
    if (offset + 1 > buf.length) break;
    const row: Record<string, any> = {};
    let rowOk = true;
    for (let j = 0; j < prelude.nvar; j++) {
      const typ = prelude.typlist[j];
      const bytesNeeded = typeWidth117Plus(typ);
      if (offset + bytesNeeded > buf.length) { rowOk = false; break; }

      if (typ >= 1 && typ <= 2045) {
        row[prelude.varlist[j]] = readFixedString(buf, offset, typ);
        offset += typ;
      } else if (typ === 32768) {
        const v = prelude.littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
        const o = prelude.littleEndian ? buf.readUInt32LE(offset + 4) : buf.readUInt32BE(offset + 4);
        offset += 8;
        if (v === 0 && o === 0) {
          row[prelude.varlist[j]] = "";
        } else {
          row[prelude.varlist[j]] = null;
          strlRefs.push({ rowIdx: i, varIdx: j, v, o });
        }
      } else if (typ === 65530) {
        const val = buf.readInt8(offset); offset += 1;
        row[prelude.varlist[j]] = val >= MISSING_BYTE_MIN ? null : val;
      } else if (typ === 65529) {
        const val = prelude.littleEndian ? buf.readInt16LE(offset) : buf.readInt16BE(offset);
        offset += 2;
        row[prelude.varlist[j]] = val >= MISSING_INT16_MIN ? null : val;
      } else if (typ === 65528) {
        const val = prelude.littleEndian ? buf.readInt32LE(offset) : buf.readInt32BE(offset);
        offset += 4;
        row[prelude.varlist[j]] = val >= MISSING_INT32_MIN ? null : val;
      } else if (typ === 65527) {
        if (isMissingFloat32(buf, offset, prelude.littleEndian)) {
          row[prelude.varlist[j]] = null;
        } else {
          row[prelude.varlist[j]] = prelude.littleEndian ? buf.readFloatLE(offset) : buf.readFloatBE(offset);
        }
        offset += 4;
      } else if (typ === 65526) {
        if (isMissingFloat64(buf, offset, prelude.littleEndian)) {
          row[prelude.varlist[j]] = null;
        } else {
          row[prelude.varlist[j]] = prelude.littleEndian ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
        }
        offset += 8;
      } else {
        row[prelude.varlist[j]] = null;
        offset += 1;
      }
    }
    if (!rowOk) break;
    data.push(row);
  }

  const remainingBytes = buf.length - offset;
  const skipStrlResolution = previewMaxRows != null && iterRows < prelude.nobs && remainingBytes > 10 * 1024 * 1024;
  if (skipStrlResolution && strlRefs.length > 0) {
    for (const ref of strlRefs) {
      if (ref.rowIdx < data.length) {
        data[ref.rowIdx][prelude.varlist[ref.varIdx]] = "";
      }
    }
  } else if (strlRefs.length > 0) {
    const strlsIdx = findTag(buf, "<strls>", offset);
    if (strlsIdx >= 0) {
      const neededKeys = new Set<string>();
      for (const ref of strlRefs) {
        neededKeys.add(`${ref.v}:${ref.o}`);
      }

      const strls: Record<string, Record<string, string>> = {};
      let pos = strlsIdx + 7;
      let resolvedCount = 0;

      while (pos + 3 <= buf.length) {
        const marker = readFixedString(buf, pos, 3);
        if (marker !== "GSO") break;
        pos += 3;

        const v = prelude.littleEndian ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
        pos += 4;
        let o: number;
        if (prelude.release >= 118) {
          o = prelude.littleEndian ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
          pos += 8;
        } else {
          o = prelude.littleEndian ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
          pos += 4;
        }
        const t = buf.readUInt8(pos); pos += 1;
        const len = prelude.littleEndian ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
        pos += 4;

        if (neededKeys.has(`${v}:${o}`)) {
          if (!strls[v]) strls[v] = {};
          if (t === 130) {
            strls[v][o] = readFixedString(buf, pos, len);
          } else {
            strls[v][o] = `[binary ${len} bytes]`;
          }
          resolvedCount++;
          if (resolvedCount >= neededKeys.size) {
            pos += len;
            break;
          }
        }
        pos += len;
      }

      for (const ref of strlRefs) {
        if (ref.rowIdx < data.length && strls[ref.v] && strls[ref.v][ref.o] !== undefined) {
          data[ref.rowIdx][prelude.varlist[ref.varIdx]] = strls[ref.v][ref.o];
        } else if (ref.rowIdx < data.length) {
          data[ref.rowIdx][prelude.varlist[ref.varIdx]] = "";
        }
      }
    } else {
      for (const ref of strlRefs) {
        if (ref.rowIdx < data.length) {
          data[ref.rowIdx][prelude.varlist[ref.varIdx]] = "";
        }
      }
    }
  }

  await options?.onProgress?.({ rowsParsed: data.length, totalRows: prelude.nobs });

  return {
    data,
    columns: prelude.varlist,
    totalRows: prelude.nobs,
    variableLabels: prelude.variableLabels,
  };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Parse a Stata .dta file from a Buffer.
 * Automatically detects the format version (114/115 or 117+).
 */
export function parseDtaFile(buf: Buffer, options?: DtaParseOptions): DtaResult {
  const target = resolveDtaParseTarget(buf);
  return target.kind === "new"
    ? parseNewFormat(target.buf, options?.previewRows)
    : parseOldFormat(target.buf, options?.previewRows);
}

export async function parseDtaFileAsync(buf: Buffer, options?: DtaAsyncParseOptions): Promise<DtaResult> {
  const err = abortError(options?.signal);
  if (err) throw err;
  const target = resolveDtaParseTarget(buf);
  return target.kind === "new"
    ? parseNewFormatAsync(target.buf, options?.previewRows, options)
    : parseOldFormatAsync(target.buf, options?.previewRows, options);
}
