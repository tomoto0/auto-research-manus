/**
 * Publication-quality SVG chart renderer.
 *
 * Takes a Chart.js-style configuration object and produces a self-contained SVG
 * string that rasterises cleanly through sharp/librsvg (no browser, no canvas).
 *
 * The previous renderer placed every element at fixed offsets, which caused
 * overlapping tick labels, clipped category names, legends drawn on top of axis
 * titles, floating bars rendered from zero, and regression / reference lines that
 * silently disappeared. This module computes the layout from measured text
 * extents instead, so titles, legends, tick labels and axis titles each get their
 * own band and the plot area is whatever space remains.
 *
 * Supported `type` values:
 *   bar (vertical / horizontal via options.indexAxis = "y", grouped, stacked,
 *        floating [low, high] ranges, per-bar error bars, line overlays),
 *   line (category axis, CI bands via dataset.ciLower / ciUpper, dashed series),
 *   scatter / bubble (numeric axes, showLine datasets drawn as paths),
 *   histogram (contiguous numeric bins + density overlay),
 *   boxplot (five-number summaries + outliers),
 *   forest (point estimates with confidence intervals, one or more series),
 *   heatmap (diverging or sequential scale with colour bar),
 *   pie / doughnut.
 *
 * Extension options understood by every cartesian type:
 *   options.referenceLines: [{ axis: "x" | "y", value: number | string, label?: string }]
 *   options.plugins.subtitle.text: short subtitle under the title
 *   options.plugins.footnote.text: note printed under the plot (e.g. "Shaded band: 95% CI")
 */

export const CHART_PALETTE = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
];

const INK = "#0b0b0b";
const INK_SECONDARY = "#52514e";
const INK_MUTED = "#6f6e69";
const GRID = "#e6e5df";
const AXIS = "#b9b8b0";
const SURFACE = "#ffffff";
const REFERENCE = "#6f6e69";

const FONT_FAMILY = "sans-serif";

export interface ChartRenderOptions {
  /** Converts labels to renderable text (e.g. ASCII transliteration). */
  labelTransform?: (value: string) => string;
}

type AnyRecord = Record<string, any>;

interface LegendEntry {
  label: string;
  color: string;
  kind: "box" | "line" | "point";
  dash?: boolean;
}

interface LinearAxis {
  kind: "linear";
  min: number;
  max: number;
  ticks: number[];
  format: (value: number) => string;
  title?: string;
}

interface BandAxis {
  kind: "band";
  labels: string[];
  title?: string;
}

type Axis = LinearAxis | BandAxis;

interface PlotFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Maps a data value (linear) or category index (band) to a pixel x. */
  px: (value: number) => number;
  /** Maps a data value (linear) or category index (band) to a pixel y. */
  py: (value: number) => number;
  /** Band width for band axes (0 for linear). */
  bandX: number;
  bandY: number;
}

/* ------------------------------------------------------------------ */
/*  Text helpers                                                        */
/* ------------------------------------------------------------------ */

const NARROW = new Set("ijl.,:;|!'`".split(""));
const SEMI_NARROW = new Set("frt()[]{}-/\\\"".split(""));
const WIDE = new Set("mwMW@%".split(""));

/**
 * Conservative width estimate for the generic sans-serif face (DejaVu Sans
 * metrics are used as the upper bound because it is the librsvg fallback).
 */
export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let units = 0;
  for (const ch of text) {
    if (ch === " ") units += 0.32;
    else if (NARROW.has(ch)) units += 0.3;
    else if (SEMI_NARROW.has(ch)) units += 0.42;
    else if (WIDE.has(ch)) units += 0.92;
    else if (ch >= "0" && ch <= "9") units += 0.64;
    else if (ch >= "A" && ch <= "Z") units += 0.7;
    else units += 0.6;
  }
  return units * fontSize * (bold ? 1.14 : 1);
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateToWidth(text: string, maxWidth: number, fontSize: number, bold = false): string {
  if (estimateTextWidth(text, fontSize, bold) <= maxWidth) return text;
  const ellipsis = "...";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTextWidth(text.slice(0, mid).trimEnd() + ellipsis, fontSize, bold) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? ellipsis : `${text.slice(0, lo).trimEnd()}${ellipsis}`;
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function wrapText(text: string, maxWidth: number, fontSize: number, maxLines: number, bold = false): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < words.length; i++) {
    const candidate = current ? `${current} ${words[i]}` : words[i];
    if (estimateTextWidth(candidate, fontSize, bold) <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = words[i];
    if (lines.length === maxLines - 1) {
      const rest = [current, ...words.slice(i + 1)].join(" ");
      lines.push(truncateToWidth(rest, maxWidth, fontSize, bold));
      return lines;
    }
  }
  if (current) lines.push(truncateToWidth(current, maxWidth, fontSize, bold));
  return lines.slice(0, maxLines);
}

/* ------------------------------------------------------------------ */
/*  Number helpers                                                      */
/* ------------------------------------------------------------------ */

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Rounds pixel coordinates so the SVG stays compact and never prints NaN. */
function r(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function niceNumber(range: number, round: boolean): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let nice: number;
  if (round) {
    if (fraction < 1.5) nice = 1;
    else if (fraction < 3) nice = 2;
    else if (fraction < 7) nice = 5;
    else nice = 10;
  } else if (fraction <= 1) nice = 1;
  else if (fraction <= 2) nice = 2;
  else if (fraction <= 5) nice = 5;
  else nice = 10;
  return nice * Math.pow(10, exponent);
}

function decimalsForStep(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  let decimals = 0;
  while (decimals < 8) {
    const scaled = step * Math.pow(10, decimals);
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) break;
    decimals++;
  }
  return decimals;
}

function withThousands(text: string): string {
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [intPart, fracPart] = body.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fracPart !== undefined ? `.${fracPart}` : ""}`;
}

function makeTickFormatter(step: number, maxAbs: number): (value: number) => string {
  if (maxAbs >= 1e6) {
    const unit = maxAbs >= 1e12 ? 1e12 : maxAbs >= 1e9 ? 1e9 : 1e6;
    const suffix = unit === 1e12 ? "T" : unit === 1e9 ? "B" : "M";
    const decimals = Math.min(3, decimalsForStep(step / unit));
    return (value: number) => {
      const scaled = value / unit;
      const text = Math.abs(scaled) < 1e-12 ? "0" : scaled.toFixed(decimals);
      return `${text}${text === "0" ? "" : suffix}`;
    };
  }
  if (maxAbs > 0 && maxAbs < 1e-3) {
    return (value: number) => (Math.abs(value) < 1e-15 ? "0" : value.toExponential(1));
  }
  const decimals = Math.min(6, decimalsForStep(step));
  return (value: number) => {
    const text = Math.abs(value) < Math.pow(10, -decimals) / 2 ? (0).toFixed(decimals) : value.toFixed(decimals);
    return maxAbs >= 1e4 ? withThousands(text) : text;
  };
}

export function niceScale(
  rawMin: number,
  rawMax: number,
  options: { includeZero?: boolean; targetTicks?: number; fixedMin?: number | null; fixedMax?: number | null } = {},
): { min: number; max: number; ticks: number[]; step: number } {
  let min = Number.isFinite(rawMin) ? rawMin : 0;
  let max = Number.isFinite(rawMax) ? rawMax : 1;
  if (options.includeZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    const delta = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= delta;
    max += delta;
    if (options.includeZero && rawMin >= 0 && rawMax >= 0) min = Math.max(0, min);
  }
  const target = Math.max(3, options.targetTicks ?? 5);
  const range = niceNumber(max - min, false);
  const step = niceNumber(range / (target - 1), true);
  let niceMin = Math.floor(min / step) * step;
  let niceMax = Math.ceil(max / step) * step;
  if (options.fixedMin !== null && options.fixedMin !== undefined && Number.isFinite(options.fixedMin)) niceMin = options.fixedMin;
  if (options.fixedMax !== null && options.fixedMax !== undefined && Number.isFinite(options.fixedMax)) niceMax = options.fixedMax;
  if (niceMax <= niceMin) niceMax = niceMin + step;
  const ticks: number[] = [];
  const first = Math.ceil((niceMin - 1e-9 * step) / step) * step;
  for (let v = first; v <= niceMax + step * 1e-6 && ticks.length < 30; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  }
  return { min: niceMin, max: niceMax, ticks, step };
}

function linearAxis(values: number[], title: string | undefined, options: { includeZero?: boolean; fixedMin?: number | null; fixedMax?: number | null; targetTicks?: number } = {}): LinearAxis {
  const finite = values.filter(v => Number.isFinite(v));
  const lo = finite.length ? Math.min(...finite) : 0;
  const hi = finite.length ? Math.max(...finite) : 1;
  const scale = niceScale(lo, hi, options);
  const maxAbs = Math.max(Math.abs(scale.min), Math.abs(scale.max));
  return {
    kind: "linear",
    min: scale.min,
    max: scale.max,
    ticks: scale.ticks,
    format: makeTickFormatter(scale.step, maxAbs),
    title,
  };
}

/* ------------------------------------------------------------------ */
/*  Colour helpers                                                      */
/* ------------------------------------------------------------------ */

const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,20})$/i;

function safeColor(value: unknown, fallback: string): string {
  if (typeof value === "string" && COLOR_PATTERN.test(value.trim())) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && COLOR_PATTERN.test(value[0].trim())) return value[0].trim();
  return fallback;
}

function colorAt(value: unknown, index: number, fallback: string): string {
  if (Array.isArray(value)) return safeColor(value[index] ?? value[0], fallback);
  return safeColor(value, fallback);
}

/** Opaque version of a colour for strokes (drops rgba alpha). */
function opaque(color: string): string {
  const m = color.match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)$/i);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : color;
}

function mixRgb(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const DIVERGING_NEG: [number, number, number] = [196, 58, 58];
const DIVERGING_MID: [number, number, number] = [240, 239, 236];
const DIVERGING_POS: [number, number, number] = [28, 92, 171];
const SEQUENTIAL_LOW: [number, number, number] = [236, 243, 252];
const SEQUENTIAL_HIGH: [number, number, number] = [16, 66, 129];

/* ------------------------------------------------------------------ */
/*  SVG builder                                                         */
/* ------------------------------------------------------------------ */

class SvgBuilder {
  parts: string[] = [];
  constructor(private readonly transform: (value: string) => string) {}

  clean(value: unknown): string {
    const raw = value === null || value === undefined ? "" : String(value);
    return this.transform(raw).replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  }

  text(
    x: number,
    y: number,
    content: string,
    opts: { size?: number; anchor?: "start" | "middle" | "end"; weight?: string; fill?: string; rotate?: number; italic?: boolean; halo?: boolean } = {},
  ): void {
    const size = opts.size ?? 11;
    const attrs = [
      `x="${r(x)}"`,
      `y="${r(y)}"`,
      `font-size="${size}"`,
      `fill="${opts.fill ?? INK_SECONDARY}"`,
      `text-anchor="${opts.anchor ?? "start"}"`,
    ];
    if (opts.weight) attrs.push(`font-weight="${opts.weight}"`);
    if (opts.italic) attrs.push(`font-style="italic"`);
    if (opts.halo) attrs.push(`stroke="${SURFACE}" stroke-width="3" stroke-linejoin="round" paint-order="stroke"`);
    if (opts.rotate) attrs.push(`transform="rotate(${r(opts.rotate)}, ${r(x)}, ${r(y)})"`);
    this.parts.push(`<text ${attrs.join(" ")}>${escapeXmlText(content)}</text>`);
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1, dash?: string, opacity?: number): void {
    const extra = `${dash ? ` stroke-dasharray="${dash}"` : ""}${opacity !== undefined ? ` stroke-opacity="${r(opacity)}"` : ""}`;
    this.parts.push(`<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${stroke}" stroke-width="${r(width)}"${extra}/>`);
  }

  rect(x: number, y: number, w: number, h: number, fill: string, opts: { opacity?: number; rx?: number; stroke?: string; strokeWidth?: number } = {}): void {
    const extra = [
      opts.opacity !== undefined ? `fill-opacity="${r(opts.opacity)}"` : "",
      opts.rx ? `rx="${r(opts.rx)}"` : "",
      opts.stroke ? `stroke="${opts.stroke}" stroke-width="${r(opts.strokeWidth ?? 1)}"` : "",
    ].filter(Boolean).join(" ");
    this.parts.push(`<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(0, w))}" height="${r(Math.max(0, h))}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`);
  }

  circle(cx: number, cy: number, radius: number, fill: string, opts: { opacity?: number; stroke?: string; strokeWidth?: number } = {}): void {
    const extra = [
      opts.opacity !== undefined ? `fill-opacity="${r(opts.opacity)}"` : "",
      opts.stroke ? `stroke="${opts.stroke}" stroke-width="${r(opts.strokeWidth ?? 1)}"` : "",
    ].filter(Boolean).join(" ");
    this.parts.push(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(radius)}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`);
  }

  path(d: string, opts: { fill?: string; stroke?: string; strokeWidth?: number; dash?: string; opacity?: number; fillOpacity?: number; linejoin?: boolean } = {}): void {
    const attrs = [
      `d="${d}"`,
      `fill="${opts.fill ?? "none"}"`,
      opts.stroke ? `stroke="${opts.stroke}" stroke-width="${r(opts.strokeWidth ?? 1.5)}"` : "",
      opts.dash ? `stroke-dasharray="${opts.dash}"` : "",
      opts.opacity !== undefined ? `stroke-opacity="${r(opts.opacity)}"` : "",
      opts.fillOpacity !== undefined ? `fill-opacity="${r(opts.fillOpacity)}"` : "",
      opts.linejoin ? `stroke-linejoin="round" stroke-linecap="round"` : "",
    ].filter(Boolean).join(" ");
    this.parts.push(`<path ${attrs}/>`);
  }
}

/* ------------------------------------------------------------------ */
/*  Config normalisation                                                */
/* ------------------------------------------------------------------ */

function readTitle(config: AnyRecord): string {
  const title = config.options?.plugins?.title;
  if (!title || title.display === false) return "";
  const text = Array.isArray(title.text) ? title.text.join(" ") : title.text;
  return typeof text === "string" || typeof text === "number" ? String(text) : "";
}

function readOptionalText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as AnyRecord;
  if (record.display === false) return "";
  const text = Array.isArray(record.text) ? record.text.join(" ") : record.text;
  return typeof text === "string" || typeof text === "number" ? String(text) : "";
}

function axisTitle(config: AnyRecord, axis: "x" | "y"): string | undefined {
  const title = config.options?.scales?.[axis]?.title;
  if (!title || title.display === false || !title.text) return undefined;
  return Array.isArray(title.text) ? title.text.join(" ") : String(title.text);
}

function isDashed(dataset: AnyRecord): boolean {
  return Array.isArray(dataset.borderDash) && dataset.borderDash.length > 0;
}

function dashArray(dataset: AnyRecord): string | undefined {
  if (!isDashed(dataset)) return undefined;
  const values = (dataset.borderDash as unknown[]).map(v => num(v)).filter((v): v is number => v !== null && v >= 0);
  return values.length > 0 ? values.map(v => r(v)).join(",") : "6,4";
}

interface ReferenceLine {
  axis: "x" | "y";
  value: number | string;
  label?: string;
}

function readReferenceLines(config: AnyRecord): ReferenceLine[] {
  const raw = config.options?.referenceLines;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item: unknown): item is AnyRecord => !!item && typeof item === "object")
    .filter(item => item.axis === "x" || item.axis === "y")
    .map(item => ({ axis: item.axis, value: item.value, label: item.label ? String(item.label) : undefined }))
    .filter(item => typeof item.value === "string" || num(item.value) !== null);
}

/* ------------------------------------------------------------------ */
/*  Main entry                                                          */
/* ------------------------------------------------------------------ */

export function renderChartSvg(rawConfig: unknown, width = 900, height = 560, options: ChartRenderOptions = {}): string {
  const config: AnyRecord = rawConfig && typeof rawConfig === "object" ? (rawConfig as AnyRecord) : { type: "bar", data: { labels: [], datasets: [] } };
  const transform = options.labelTransform ?? ((value: string) => value);
  const svg = new SvgBuilder(transform);
  const W = Math.max(320, Math.round(width));
  const H = Math.max(220, Math.round(height));
  const type = String(config.type || "bar").toLowerCase();

  svg.parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT_FAMILY}">`);
  svg.rect(0, 0, W, H, SURFACE);

  // --- Title / subtitle band ------------------------------------------------
  let cursorY = 14;
  const title = svg.clean(readTitle(config));
  if (title) {
    const lines = wrapText(title, W - 48, 16, 2, true);
    for (const line of lines) {
      cursorY += 18;
      svg.text(W / 2, cursorY, line, { size: 16, anchor: "middle", weight: "bold", fill: INK });
    }
    cursorY += 4;
  }
  const subtitle = svg.clean(readOptionalText(config.options?.plugins?.subtitle));
  if (subtitle) {
    cursorY += 15;
    svg.text(W / 2, cursorY, truncateToWidth(subtitle, W - 48, 12), { size: 12, anchor: "middle", fill: INK_SECONDARY });
    cursorY += 2;
  }
  cursorY += 8;

  // --- Footnote band (reserved from the bottom) ----------------------------
  const footnote = svg.clean(readOptionalText(config.options?.plugins?.footnote));
  const footnoteLines = footnote ? wrapText(footnote, W - 40, 10.5, 2) : [];
  const footnoteHeight = footnoteLines.length > 0 ? footnoteLines.length * 13 + 6 : 0;
  footnoteLines.forEach((line, i) => {
    svg.text(20, H - 10 - (footnoteLines.length - 1 - i) * 13, line, { size: 10.5, fill: INK_MUTED, italic: true });
  });

  const area = { top: cursorY, bottom: H - 10 - footnoteHeight, left: 14, right: W - 18 };

  switch (type) {
    case "pie":
    case "doughnut":
      renderPie(svg, config, area, type === "doughnut");
      break;
    case "heatmap":
      renderHeatmap(svg, config, area);
      break;
    case "scatter":
    case "bubble":
      renderScatter(svg, config, area, type === "bubble");
      break;
    case "line":
      if (lineUsesNumericX(config)) renderScatter(svg, config, area, false, true);
      else renderLine(svg, config, area);
      break;
    case "histogram":
      renderHistogram(svg, config, area);
      break;
    case "boxplot":
      renderBoxplot(svg, config, area);
      break;
    case "forest":
      renderForest(svg, config, area);
      break;
    default:
      renderBar(svg, config, area);
  }

  svg.parts.push(`</svg>`);
  return svg.parts.join("");
}

interface Area {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function noData(svg: SvgBuilder, area: Area, message: string): void {
  svg.text((area.left + area.right) / 2, (area.top + area.bottom) / 2, message, { size: 13, anchor: "middle", fill: INK_MUTED });
}

/* ------------------------------------------------------------------ */
/*  Legend                                                              */
/* ------------------------------------------------------------------ */

function legendEntriesFromDatasets(svg: SvgBuilder, config: AnyRecord, datasets: AnyRecord[], defaultKind: LegendEntry["kind"]): LegendEntry[] {
  if (config.options?.plugins?.legend?.display === false) return [];
  const entries: LegendEntry[] = [];
  datasets.forEach((ds, index) => {
    if (ds.hideInLegend) return;
    const label = svg.clean(ds.label);
    if (!label) return;
    const isLine = ds.type === "line" || ds.showLine === true || defaultKind === "line";
    const pointsOnly = ds.type === "line" && ds.showLine === false;
    entries.push({
      label,
      color: opaque(colorAt(isLine ? ds.borderColor ?? ds.backgroundColor : ds.backgroundColor ?? ds.borderColor, 0, CHART_PALETTE[index % CHART_PALETTE.length])),
      kind: pointsOnly ? "point" : isLine ? "line" : defaultKind,
      dash: isDashed(ds),
    });
  });
  return entries.length >= 2 ? entries : [];
}

/** Draws a wrapped legend starting at `top`; returns the height consumed. */
function drawLegend(svg: SvgBuilder, entries: LegendEntry[], left: number, right: number, top: number): number {
  if (entries.length === 0) return 0;
  const fontSize = 11.5;
  const rowHeight = 18;
  const maxRows = 3;
  const maxWidth = right - left;
  const items = entries.map(entry => {
    const label = truncateToWidth(truncateChars(entry.label, 48), Math.min(maxWidth * 0.6, 300), fontSize);
    return { ...entry, label, width: 22 + estimateTextWidth(label, fontSize) + 16 };
  });
  const rows: Array<typeof items> = [];
  let current: typeof items = [];
  let currentWidth = 0;
  for (const item of items) {
    if (current.length > 0 && currentWidth + item.width > maxWidth) {
      rows.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push(item);
    currentWidth += item.width;
  }
  if (current.length) rows.push(current);
  const visibleRows = rows.slice(0, maxRows);
  const hidden = rows.slice(maxRows).reduce((sum, row) => sum + row.length, 0);
  visibleRows.forEach((row, rowIndex) => {
    const rowWidth = row.reduce((sum, item) => sum + item.width, 0);
    let x = left + Math.max(0, (maxWidth - rowWidth) / 2);
    const y = top + rowIndex * rowHeight + 12;
    for (const item of row) {
      if (item.kind === "line") {
        svg.line(x, y - 4, x + 16, y - 4, item.color, 2.2, item.dash ? "4,3" : undefined);
      } else if (item.kind === "point") {
        svg.circle(x + 8, y - 4, 4, item.color);
      } else {
        svg.rect(x + 2, y - 10, 12, 12, item.color, { rx: 2 });
      }
      svg.text(x + 22, y, item.label, { size: fontSize, fill: INK_SECONDARY });
      x += item.width;
    }
  });
  if (hidden > 0) {
    svg.text(right, top + visibleRows.length * rowHeight + 10, `+${hidden} more series`, { size: 10, anchor: "end", fill: INK_MUTED });
  }
  return visibleRows.length * rowHeight + (hidden > 0 ? 12 : 0) + 6;
}

/* ------------------------------------------------------------------ */
/*  Cartesian frame                                                     */
/* ------------------------------------------------------------------ */

const TICK_FONT = 11;
const AXIS_TITLE_FONT = 12;

interface FrameOptions {
  xGrid?: boolean;
  yGrid?: boolean;
  maxBandLabelChars?: number;
}

/**
 * Lays out axes inside `area` (legend already consumed) and draws gridlines,
 * tick labels and axis titles. Returns the plot frame with pixel mappers.
 */
function drawFrame(svg: SvgBuilder, area: Area, xAxis: Axis, yAxis: Axis, opts: FrameOptions = {}): PlotFrame {
  const maxBandChars = opts.maxBandLabelChars ?? 28;

  // ---- Left margin: y-axis title + tick labels -----------------------------
  const yTitle = yAxis.title ? svg.clean(yAxis.title) : "";
  const yTitleBand = yTitle ? AXIS_TITLE_FONT + 10 : 0;
  let yLabels: string[] = [];
  if (yAxis.kind === "linear") {
    yLabels = yAxis.ticks.map(t => yAxis.format(t));
  } else {
    const maxLabelWidth = Math.min((area.right - area.left) * 0.36, 230);
    yLabels = yAxis.labels.map(label => truncateToWidth(truncateChars(svg.clean(label) || "-", maxBandChars + 12), maxLabelWidth, TICK_FONT));
  }
  const yTickWidth = yLabels.length ? Math.max(...yLabels.map(l => estimateTextWidth(l, TICK_FONT))) : 0;
  let left = area.left + yTitleBand + yTickWidth + 10;

  // ---- Right margin: leave room for the last x tick label -----------------
  let right = area.right - 6;
  if (xAxis.kind === "linear" && xAxis.ticks.length) {
    const lastLabel = xAxis.format(xAxis.ticks[xAxis.ticks.length - 1]);
    right = Math.min(right, area.right - estimateTextWidth(lastLabel, TICK_FONT) / 2);
  }
  let plotWidth = Math.max(80, right - left);

  // ---- Bottom margin: x tick labels + x-axis title --------------------------
  const xTitle = xAxis.title ? svg.clean(xAxis.title) : "";
  const xTitleBand = xTitle ? AXIS_TITLE_FONT + 12 : 0;
  let xLabelMode: "horizontal" | "rotated" = "horizontal";
  let xLabels: string[] = [];
  let xLabelStep = 1;
  let xTickBand = TICK_FONT + 10;
  if (xAxis.kind === "linear") {
    xLabels = xAxis.ticks.map(t => xAxis.format(t));
  } else {
    const n = Math.max(1, xAxis.labels.length);
    const slot = plotWidth / n;
    const base = xAxis.labels.map(label => truncateChars(svg.clean(label) || "-", maxBandChars));
    const widest = base.length ? Math.max(...base.map(l => estimateTextWidth(l, TICK_FONT))) : 0;
    if (widest <= slot - 6) {
      xLabels = base;
    } else if (widest <= 64 && Math.ceil(n / Math.max(1, Math.floor(plotWidth / (widest + 10)))) <= 4) {
      // Short labels such as years: keep them horizontal and thin them out.
      xLabels = base;
    } else {
      const avgWidth = base.length ? base.reduce((s, l) => s + estimateTextWidth(l, TICK_FONT), 0) / base.length : 0;
      if (n <= 6 && avgWidth <= slot * 1.8) {
        // Few categories: keep horizontal but shorten to the slot.
        xLabels = base.map(l => truncateToWidth(l, slot - 6, TICK_FONT));
      } else {
        xLabelMode = "rotated";
        const maxRotatedWidth = Math.min(150, (area.bottom - area.top) * 0.3);
        xLabels = base.map(l => truncateToWidth(l, maxRotatedWidth, TICK_FONT));
        const rotatedWidest = Math.max(...xLabels.map(l => estimateTextWidth(l, TICK_FONT)));
        xTickBand = Math.sin(Math.PI * 40 / 180) * rotatedWidest + TICK_FONT + 10;
        const minSpacing = TICK_FONT * 1.35;
        xLabelStep = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotWidth / minSpacing))));
      }
    }
    if (xLabelMode === "horizontal") {
      const widestShown = xLabels.length ? Math.max(...xLabels.map(l => estimateTextWidth(l, TICK_FONT))) : 0;
      xLabelStep = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotWidth / (widestShown + 10)))));
    }
  }
  // Rotated labels hang to the left of their tick; make sure the first one fits.
  if (xLabelMode === "rotated" && xLabels.length > 0) {
    const firstWidth = estimateTextWidth(xLabels[0], TICK_FONT) * Math.cos(Math.PI * 40 / 180);
    const firstTickX = left + plotWidth / Math.max(1, xLabels.length) / 2;
    const overflow = area.left + 2 - (firstTickX - firstWidth);
    if (overflow > 0) {
      left += overflow;
      plotWidth = Math.max(80, right - left);
    }
  }
  const bottom = area.bottom - xTitleBand - xTickBand;
  const top = area.top + 4;
  const plotHeight = Math.max(60, bottom - top);

  const frame: PlotFrame = {
    x: left,
    y: top,
    w: plotWidth,
    h: plotHeight,
    bandX: xAxis.kind === "band" ? plotWidth / Math.max(1, xAxis.labels.length) : 0,
    bandY: yAxis.kind === "band" ? plotHeight / Math.max(1, yAxis.labels.length) : 0,
    px: (v: number) => {
      if (xAxis.kind === "linear") return left + ((v - xAxis.min) / (xAxis.max - xAxis.min || 1)) * plotWidth;
      return left + (v + 0.5) * (plotWidth / Math.max(1, xAxis.labels.length));
    },
    py: (v: number) => {
      if (yAxis.kind === "linear") return top + plotHeight - ((v - yAxis.min) / (yAxis.max - yAxis.min || 1)) * plotHeight;
      return top + (v + 0.5) * (plotHeight / Math.max(1, yAxis.labels.length));
    },
  };

  // ---- Gridlines --------------------------------------------------------
  if (yAxis.kind === "linear" && opts.yGrid !== false) {
    for (const tick of yAxis.ticks) {
      const y = frame.py(tick);
      svg.line(left, y, left + plotWidth, y, GRID, 1);
    }
  }
  if (xAxis.kind === "linear" && opts.xGrid) {
    for (const tick of xAxis.ticks) {
      const x = frame.px(tick);
      svg.line(x, top, x, top + plotHeight, GRID, 1);
    }
  }

  // ---- Axis lines ---------------------------------------------------------
  svg.line(left, top + plotHeight, left + plotWidth, top + plotHeight, AXIS, 1);
  svg.line(left, top, left, top + plotHeight, AXIS, 1);

  // ---- Y tick labels ------------------------------------------------------
  if (yAxis.kind === "linear") {
    yAxis.ticks.forEach((tick, i) => {
      svg.text(left - 7, frame.py(tick) + TICK_FONT * 0.35, yLabels[i], { size: TICK_FONT, anchor: "end", fill: INK_SECONDARY });
    });
  } else {
    const n = yAxis.labels.length;
    const step = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotHeight / (TICK_FONT + 3)))));
    for (let i = 0; i < n; i += step) {
      svg.text(left - 7, frame.py(i) + TICK_FONT * 0.35, yLabels[i], { size: TICK_FONT, anchor: "end", fill: INK_SECONDARY });
    }
  }

  // ---- X tick labels ------------------------------------------------------
  const labelY = top + plotHeight + TICK_FONT + 5;
  if (xAxis.kind === "linear") {
    xAxis.ticks.forEach((tick, i) => {
      const x = frame.px(tick);
      svg.line(x, top + plotHeight, x, top + plotHeight + 4, AXIS, 1);
      svg.text(x, labelY, xLabels[i], { size: TICK_FONT, anchor: "middle", fill: INK_SECONDARY });
    });
  } else {
    for (let i = 0; i < xLabels.length; i += xLabelStep) {
      const x = frame.px(i);
      if (xLabelMode === "rotated") {
        svg.text(x + 3, top + plotHeight + 10, xLabels[i], { size: TICK_FONT, anchor: "end", fill: INK_SECONDARY, rotate: -40 });
      } else {
        svg.text(x, labelY, xLabels[i], { size: TICK_FONT, anchor: "middle", fill: INK_SECONDARY });
      }
    }
  }

  // ---- Axis titles ---------------------------------------------------------
  if (xTitle) {
    svg.text(left + plotWidth / 2, area.bottom - 4, truncateToWidth(xTitle, plotWidth, AXIS_TITLE_FONT), { size: AXIS_TITLE_FONT, anchor: "middle", fill: INK, weight: "500" });
  }
  if (yTitle) {
    const cx = area.left + AXIS_TITLE_FONT;
    const cy = top + plotHeight / 2;
    svg.text(cx, cy, truncateToWidth(yTitle, plotHeight, AXIS_TITLE_FONT), { size: AXIS_TITLE_FONT, anchor: "middle", fill: INK, weight: "500", rotate: -90 });
  }

  return frame;
}

function drawReferenceLines(svg: SvgBuilder, frame: PlotFrame, lines: ReferenceLine[], xAxis: Axis, yAxis: Axis): void {
  for (const ref of lines) {
    const resolve = (axis: Axis, value: number | string): number | null => {
      if (axis.kind === "band") {
        if (typeof value === "string") {
          const idx = axis.labels.findIndex(label => label === value);
          return idx >= 0 ? idx : null;
        }
        return value;
      }
      const n = num(value);
      if (n === null || n < axis.min || n > axis.max) return null;
      return n;
    };
    if (ref.axis === "y") {
      const v = resolve(yAxis, ref.value);
      if (v === null) continue;
      const y = frame.py(v);
      svg.line(frame.x, y, frame.x + frame.w, y, REFERENCE, 1.2, "5,4");
      if (ref.label) svg.text(frame.x + frame.w - 4, y - 4, svg.clean(ref.label), { size: 10, anchor: "end", fill: INK_SECONDARY, halo: true });
    } else {
      let v = resolve(xAxis, ref.value);
      if (v === null) continue;
      if (xAxis.kind === "band" && typeof ref.value === "number" && !Number.isInteger(ref.value)) v = ref.value;
      const x = frame.px(v);
      svg.line(x, frame.y, x, frame.y + frame.h, REFERENCE, 1.2, "5,4");
      if (ref.label) svg.text(x + 4, frame.y + 11, svg.clean(ref.label), { size: 10, fill: INK_SECONDARY, halo: true });
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Bar charts                                                          */
/* ------------------------------------------------------------------ */

type BarValue = { kind: "value"; value: number } | { kind: "range"; low: number; high: number };

function readBarValue(raw: unknown): BarValue | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const low = num(raw[0]);
    const high = num(raw[1]);
    if (low === null || high === null) return null;
    return { kind: "range", low: Math.min(low, high), high: Math.max(low, high) };
  }
  if (raw && typeof raw === "object") {
    const record = raw as AnyRecord;
    const y = num(record.y ?? record.x ?? record.value);
    return y === null ? null : { kind: "value", value: y };
  }
  const n = num(raw);
  return n === null ? null : { kind: "value", value: n };
}

function readErrorBar(raw: unknown): [number, number] | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const a = num(raw[0]);
    const b = num(raw[1]);
    if (a === null || b === null) return null;
    return [Math.min(a, b), Math.max(a, b)];
  }
  if (raw && typeof raw === "object") {
    const record = raw as AnyRecord;
    const a = num(record.low ?? record.lower ?? record.min);
    const b = num(record.high ?? record.upper ?? record.max);
    if (a === null || b === null) return null;
    return [Math.min(a, b), Math.max(a, b)];
  }
  return null;
}

function renderBar(svg: SvgBuilder, config: AnyRecord, area: Area): void {
  const allDatasets: AnyRecord[] = Array.isArray(config.data?.datasets) ? config.data.datasets.filter((d: unknown) => d && typeof d === "object") : [];
  const labelsRaw: unknown[] = Array.isArray(config.data?.labels) ? config.data.labels : [];
  const categoryCount = labelsRaw.length > 0
    ? labelsRaw.length
    : Math.max(0, ...allDatasets.map(d => (Array.isArray(d.data) ? d.data.length : 0)));
  if (categoryCount === 0 || allDatasets.length === 0) {
    noData(svg, area, "No categorical values available for bar chart.");
    return;
  }
  const labels = Array.from({ length: categoryCount }, (_, i) => (labelsRaw[i] !== undefined ? String(labelsRaw[i]) : `${i + 1}`));
  const horizontal = config.options?.indexAxis === "y";
  const stacked = !!(config.options?.scales?.x?.stacked || config.options?.scales?.y?.stacked);
  const barSets = allDatasets.filter(d => d.type !== "line");
  const lineSets = allDatasets.filter(d => d.type === "line");

  const barValues = barSets.map(ds => Array.from({ length: categoryCount }, (_, i) => readBarValue(Array.isArray(ds.data) ? ds.data[i] : null)));
  const errorValues = barSets.map(ds => Array.from({ length: categoryCount }, (_, i) => (Array.isArray(ds.errorBars) ? readErrorBar(ds.errorBars[i]) : null)));
  const lineValues = lineSets.map(ds => Array.from({ length: categoryCount }, (_, i) => {
    const v = readBarValue(Array.isArray(ds.data) ? ds.data[i] : null);
    return v && v.kind === "value" ? v.value : null;
  }));

  const domainValues: number[] = [];
  let hasRange = false;
  if (stacked) {
    let anyPositive = false;
    for (let i = 0; i < categoryCount; i++) {
      let pos = 0;
      let neg = 0;
      for (const series of barValues) {
        const v = series[i];
        if (!v) continue;
        const value = v.kind === "value" ? v.value : v.high;
        if (value > 0) { pos += value; anyPositive = true; } else neg += value;
      }
      domainValues.push(pos, neg);
    }
    if (!anyPositive) {
      noData(svg, area, "No positive stacked values available.");
      return;
    }
  } else {
    for (const series of barValues) {
      for (const v of series) {
        if (!v) continue;
        if (v.kind === "value") domainValues.push(v.value);
        else { domainValues.push(v.low, v.high); hasRange = true; }
      }
    }
  }
  for (const series of errorValues) for (const e of series) if (e) domainValues.push(e[0], e[1]);
  for (const series of lineValues) for (const v of series) if (v !== null) domainValues.push(v);
  if (domainValues.length === 0) {
    noData(svg, area, "No numeric bar values available.");
    return;
  }

  const valueScaleCfg = horizontal ? config.options?.scales?.x : config.options?.scales?.y;
  const onlyRanges = hasRange && barValues.every(series => series.every(v => !v || v.kind === "range"));
  const valueAxis = linearAxis(domainValues, axisTitle(config, horizontal ? "x" : "y"), {
    includeZero: !onlyRanges || valueScaleCfg?.beginAtZero === true,
    fixedMin: num(valueScaleCfg?.min),
    fixedMax: num(valueScaleCfg?.max),
  });
  const categoryAxis: BandAxis = { kind: "band", labels, title: axisTitle(config, horizontal ? "y" : "x") };

  const legend = legendEntriesFromDatasets(svg, config, allDatasets, "box");
  const legendHeight = drawLegend(svg, legend, area.left + 10, area.right, area.top);
  const plotArea = { ...area, top: area.top + legendHeight };
  const frame = horizontal
    ? drawFrame(svg, plotArea, valueAxis, categoryAxis, { xGrid: true, yGrid: false })
    : drawFrame(svg, plotArea, categoryAxis, valueAxis);

  const valueToPx = (v: number) => (horizontal ? frame.px(v) : frame.py(v));
  const clampedZero = Math.max(valueAxis.min, Math.min(valueAxis.max, 0));
  const band = horizontal ? frame.bandY : frame.bandX;
  const groupWidth = band * (categoryCount === 1 ? 0.5 : 0.78);
  const seriesCount = Math.max(1, barSets.length);
  const gap = seriesCount > 1 ? Math.min(3, groupWidth * 0.05) : 0;
  const barThickness = stacked ? groupWidth : Math.max(1.5, (groupWidth - gap * (seriesCount - 1)) / seriesCount);
  const cornerRadius = Math.min(3, barThickness / 4);

  const drawBarRect = (catIndex: number, offset: number, from: number, to: number, fill: string, opacity?: number) => {
    const center = horizontal ? frame.py(catIndex) : frame.px(catIndex);
    const start = center - groupWidth / 2 + offset;
    const p1 = valueToPx(from);
    const p2 = valueToPx(to);
    const lo = Math.min(p1, p2);
    const len = Math.max(1, Math.abs(p2 - p1));
    if (horizontal) svg.rect(lo, start, len, barThickness, fill, { rx: cornerRadius, opacity });
    else svg.rect(start, lo, barThickness, len, fill, { rx: cornerRadius, opacity });
  };

  const stackPos = Array(categoryCount).fill(0);
  const stackNeg = Array(categoryCount).fill(0);
  barSets.forEach((ds, sIndex) => {
    const defaultColor = CHART_PALETTE[sIndex % CHART_PALETTE.length];
    for (let i = 0; i < categoryCount; i++) {
      const v = barValues[sIndex][i];
      if (!v) continue;
      const fill = colorAt(ds.backgroundColor, i, defaultColor);
      if (stacked) {
        const value = v.kind === "value" ? v.value : v.high;
        if (value >= 0) {
          drawBarRect(i, 0, stackPos[i], stackPos[i] + value, fill);
          stackPos[i] += value;
        } else {
          drawBarRect(i, 0, stackNeg[i], stackNeg[i] + value, fill);
          stackNeg[i] += value;
        }
      } else {
        const offset = sIndex * (barThickness + gap);
        if (v.kind === "range") drawBarRect(i, offset, v.low, v.high, fill);
        else drawBarRect(i, offset, clampedZero, v.value, fill);
      }
      const err = errorValues[sIndex][i];
      if (err && !stacked) {
        const center = (horizontal ? frame.py(i) : frame.px(i)) - groupWidth / 2 + sIndex * (barThickness + gap) + barThickness / 2;
        const cap = Math.min(8, barThickness * 0.5);
        const a = valueToPx(err[0]);
        const b = valueToPx(err[1]);
        if (horizontal) {
          svg.line(a, center, b, center, INK, 1.2);
          svg.line(a, center - cap / 2, a, center + cap / 2, INK, 1.2);
          svg.line(b, center - cap / 2, b, center + cap / 2, INK, 1.2);
        } else {
          svg.line(center, a, center, b, INK, 1.2);
          svg.line(center - cap / 2, a, center + cap / 2, a, INK, 1.2);
          svg.line(center - cap / 2, b, center + cap / 2, b, INK, 1.2);
        }
      }
    }
  });

  // Zero baseline when the value axis spans negative values.
  if (valueAxis.min < 0 && valueAxis.max > 0) {
    const z = valueToPx(0);
    if (horizontal) svg.line(z, frame.y, z, frame.y + frame.h, INK_MUTED, 1);
    else svg.line(frame.x, z, frame.x + frame.w, z, INK_MUTED, 1);
  }

  // Line overlays (e.g. medians or targets).
  lineSets.forEach((ds, lIndex) => {
    const color = opaque(safeColor(ds.borderColor ?? ds.backgroundColor, CHART_PALETTE[(barSets.length + lIndex) % CHART_PALETTE.length]));
    const pts: Array<[number, number]> = [];
    lineValues[lIndex].forEach((v, i) => {
      if (v === null) return;
      const c = horizontal ? frame.py(i) : frame.px(i);
      const p = valueToPx(v);
      pts.push(horizontal ? [p, c] : [c, p]);
    });
    if (ds.showLine !== false && pts.length > 1) {
      svg.path(pts.map((p, i) => `${i === 0 ? "M" : "L"} ${r(p[0])} ${r(p[1])}`).join(" "), { stroke: color, strokeWidth: 2, dash: dashArray(ds), linejoin: true });
    }
    for (const [x, y] of pts) {
      svg.path(`M ${r(x)} ${r(y - 5)} L ${r(x + 5)} ${r(y)} L ${r(x)} ${r(y + 5)} L ${r(x - 5)} ${r(y)} Z`, { fill: color, stroke: SURFACE, strokeWidth: 1 });
    }
  });

  // Optional value labels for single-series bars with few categories.
  if (config.options?.plugins?.valueLabels && barSets.length === 1 && !stacked && categoryCount <= 16) {
    const fmt = config.options?.plugins?.valueLabels?.decimals !== undefined
      ? (v: number) => v.toFixed(Math.max(0, Math.min(4, Number(config.options.plugins.valueLabels.decimals) || 0)))
      : valueAxis.format;
    const suffix = typeof config.options?.plugins?.valueLabels?.suffix === "string" ? svg.clean(config.options.plugins.valueLabels.suffix) : "";
    barValues[0].forEach((v, i) => {
      if (!v || v.kind !== "value") return;
      const label = `${fmt(v.value)}${suffix}`;
      const end = valueToPx(v.value);
      if (horizontal) {
        const x = v.value >= 0 ? end + 4 : end - 4;
        if (x + estimateTextWidth(label, 10) < frame.x + frame.w + 16) {
          svg.text(x, frame.py(i) + 3.5, label, { size: 10, anchor: v.value >= 0 ? "start" : "end", fill: INK_SECONDARY });
        }
      } else {
        svg.text(frame.px(i), v.value >= 0 ? end - 4 : end + 12, label, { size: 10, anchor: "middle", fill: INK_SECONDARY });
      }
    });
  }

  drawReferenceLines(svg, frame, readReferenceLines(config), horizontal ? valueAxis : categoryAxis, horizontal ? categoryAxis : valueAxis);
}

/* ------------------------------------------------------------------ */
/*  Line charts (category x axis)                                       */
/* ------------------------------------------------------------------ */

function lineUsesNumericX(config: AnyRecord): boolean {
  if (config.options?.scales?.x?.type === "linear") return true;
  const datasets: AnyRecord[] = Array.isArray(config.data?.datasets) ? config.data.datasets : [];
  const hasLabels = Array.isArray(config.data?.labels) && config.data.labels.length > 0;
  if (hasLabels) return false;
  return datasets.some(ds => Array.isArray(ds?.data) && ds.data.some((p: unknown) => p && typeof p === "object" && num((p as AnyRecord).x) !== null));
}

function renderLine(svg: SvgBuilder, config: AnyRecord, area: Area): void {
  const datasets: AnyRecord[] = Array.isArray(config.data?.datasets) ? config.data.datasets.filter((d: unknown) => d && typeof d === "object") : [];
  const labelsRaw: unknown[] = Array.isArray(config.data?.labels) ? config.data.labels : [];
  const series = datasets.map((ds, index) => {
    const values: Array<number | null> = (Array.isArray(ds.data) ? ds.data : []).map((raw: unknown) => {
      if (raw && typeof raw === "object") return num((raw as AnyRecord).y);
      return num(raw);
    });
    const lower: Array<number | null> = Array.isArray(ds.ciLower) ? ds.ciLower.map((v: unknown) => num(v)) : [];
    const upper: Array<number | null> = Array.isArray(ds.ciUpper) ? ds.ciUpper.map((v: unknown) => num(v)) : [];
    return {
      ds,
      values,
      lower,
      upper,
      color: opaque(safeColor(ds.borderColor ?? ds.backgroundColor, CHART_PALETTE[index % CHART_PALETTE.length])),
    };
  }).filter(s => s.values.filter(v => v !== null).length >= 1);

  const pointCount = Math.max(labelsRaw.length, ...series.map(s => s.values.length), 0);
  if (series.length === 0 || pointCount === 0 || series.every(s => s.values.filter(v => v !== null).length < 2 && pointCount > 1)) {
    noData(svg, area, "No line-series values available.");
    return;
  }
  const labels = Array.from({ length: pointCount }, (_, i) => (labelsRaw[i] !== undefined ? String(labelsRaw[i]) : `${i + 1}`));
  const domain: number[] = [];
  for (const s of series) {
    s.values.forEach(v => { if (v !== null) domain.push(v); });
    s.lower.forEach(v => { if (v !== null) domain.push(v); });
    s.upper.forEach(v => { if (v !== null) domain.push(v); });
  }
  const refLines = readReferenceLines(config);
  for (const ref of refLines) if (ref.axis === "y") { const v = num(ref.value); if (v !== null) domain.push(v); }
  const yCfg = config.options?.scales?.y;
  const yAxis = linearAxis(domain, axisTitle(config, "y"), {
    includeZero: yCfg?.beginAtZero === true,
    fixedMin: num(yCfg?.min),
    fixedMax: num(yCfg?.max),
  });
  const xAxis: BandAxis = { kind: "band", labels, title: axisTitle(config, "x") };

  const legend = legendEntriesFromDatasets(svg, config, datasets, "line");
  const legendHeight = drawLegend(svg, legend, area.left + 10, area.right, area.top);
  const frame = drawFrame(svg, { ...area, top: area.top + legendHeight }, xAxis, yAxis);

  // CI bands first, then area fills, then lines, then markers.
  for (const s of series) {
    if (s.lower.length === 0 || s.upper.length === 0) continue;
    const segments: Array<Array<[number, number, number]>> = [];
    let current: Array<[number, number, number]> = [];
    for (let i = 0; i < pointCount; i++) {
      const lo = s.lower[i];
      const hi = s.upper[i];
      if (lo === null || lo === undefined || hi === null || hi === undefined) {
        if (current.length) segments.push(current);
        current = [];
        continue;
      }
      current.push([frame.px(i), frame.py(lo), frame.py(hi)]);
    }
    if (current.length) segments.push(current);
    for (const seg of segments) {
      if (seg.length < 2) continue;
      const upperPath = seg.map((p, i) => `${i === 0 ? "M" : "L"} ${r(p[0])} ${r(p[2])}`).join(" ");
      const lowerPath = seg.slice().reverse().map(p => `L ${r(p[0])} ${r(p[1])}`).join(" ");
      svg.path(`${upperPath} ${lowerPath} Z`, { fill: s.color, fillOpacity: 0.16 });
    }
  }
  const baseline = frame.py(Math.max(yAxis.min, Math.min(yAxis.max, 0)));
  for (const s of series) {
    const pts = s.values.map((v, i) => (v === null ? null : [frame.px(i), frame.py(v)] as [number, number]));
    const segments: Array<Array<[number, number]>> = [];
    let current: Array<[number, number]> = [];
    for (const p of pts) {
      if (!p) { if (current.length) segments.push(current); current = []; continue; }
      current.push(p);
    }
    if (current.length) segments.push(current);
    if (s.ds.fill === true && series.length === 1 && s.lower.length === 0) {
      for (const seg of segments) {
        if (seg.length < 2) continue;
        const d = `${seg.map((p, i) => `${i === 0 ? "M" : "L"} ${r(p[0])} ${r(p[1])}`).join(" ")} L ${r(seg[seg.length - 1][0])} ${r(baseline)} L ${r(seg[0][0])} ${r(baseline)} Z`;
        svg.path(d, { fill: s.color, fillOpacity: 0.14 });
      }
    }
    for (const seg of segments) {
      if (seg.length < 2) continue;
      svg.path(seg.map((p, i) => `${i === 0 ? "M" : "L"} ${r(p[0])} ${r(p[1])}`).join(" "), {
        stroke: s.color,
        strokeWidth: num(s.ds.borderWidth) ?? 2.2,
        dash: dashArray(s.ds),
        linejoin: true,
      });
    }
    const explicitRadius = num(s.ds.pointRadius);
    const radius = explicitRadius !== null ? explicitRadius : pointCount <= 40 ? 3.2 : 0;
    if (radius > 0) {
      for (const p of pts) if (p) svg.circle(p[0], p[1], Math.min(6, radius), s.color, { stroke: SURFACE, strokeWidth: 1.2 });
    }
  }
  drawReferenceLines(svg, frame, refLines, xAxis, yAxis);
}

/* ------------------------------------------------------------------ */
/*  Scatter / bubble / numeric-x lines                                  */
/* ------------------------------------------------------------------ */

function renderScatter(svg: SvgBuilder, config: AnyRecord, area: Area, bubble: boolean, linesByDefault = false): void {
  const datasets: AnyRecord[] = Array.isArray(config.data?.datasets) ? config.data.datasets.filter((d: unknown) => d && typeof d === "object") : [];
  const series = datasets.map((ds, index) => {
    const raw: unknown[] = Array.isArray(ds.data) ? ds.data : [];
    const points = raw.map((p, idx) => {
      if (p && typeof p === "object") {
        const rec = p as AnyRecord;
        const x = num(rec.x);
        const y = num(rec.y);
        if (x === null || y === null) return null;
        const rr = num(rec.r);
        return { x, y, r: rr === null ? 4 : Math.max(2, Math.min(18, rr)) };
      }
      const y = num(p);
      return y === null ? null : { x: idx, y, r: 4 };
    }).filter((p): p is { x: number; y: number; r: number } => p !== null);
    const showLine = ds.showLine === true || (linesByDefault && ds.showLine !== false);
    const explicitRadius = num(ds.pointRadius);
    return {
      ds,
      points,
      showLine,
      radius: explicitRadius !== null ? explicitRadius : showLine ? 0 : 3,
      color: opaque(safeColor(showLine ? ds.borderColor ?? ds.backgroundColor : ds.backgroundColor ?? ds.borderColor, CHART_PALETTE[index % CHART_PALETTE.length])),
    };
  }).filter(s => s.points.length > 0);

  if (series.length === 0) {
    noData(svg, area, "No numeric points available for scatter chart.");
    return;
  }
  const refLines = readReferenceLines(config);
  const xs = series.flatMap(s => s.points.map(p => p.x));
  const ys = series.flatMap(s => s.points.map(p => p.y));
  for (const ref of refLines) {
    const v = num(ref.value);
    if (v === null) continue;
    (ref.axis === "x" ? xs : ys).push(v);
  }
  const xCfg = config.options?.scales?.x;
  const yCfg = config.options?.scales?.y;
  const xAxis = linearAxis(xs, axisTitle(config, "x"), { fixedMin: num(xCfg?.min), fixedMax: num(xCfg?.max), includeZero: xCfg?.beginAtZero === true });
  const yAxis = linearAxis(ys, axisTitle(config, "y"), { fixedMin: num(yCfg?.min), fixedMax: num(yCfg?.max), includeZero: yCfg?.beginAtZero === true });

  const legend = legendEntriesFromDatasets(svg, config, series.map(s => s.ds), "point");
  const legendHeight = drawLegend(svg, legend, area.left + 10, area.right, area.top);
  const frame = drawFrame(svg, { ...area, top: area.top + legendHeight }, xAxis, yAxis, { xGrid: true });

  const inRange = (p: { x: number; y: number }) => p.x >= xAxis.min && p.x <= xAxis.max && p.y >= yAxis.min && p.y <= yAxis.max;
  // Markers first (so fitted lines stay visible on top).
  for (const s of series) {
    if (s.radius <= 0 && !bubble) continue;
    const maxPoints = 1500;
    const stride = Math.max(1, Math.ceil(s.points.length / maxPoints));
    const opacity = s.points.length > 400 ? 0.45 : 0.7;
    for (let i = 0; i < s.points.length; i += stride) {
      const p = s.points[i];
      if (!inRange(p)) continue;
      const radius = bubble ? p.r : Math.min(6, s.radius);
      svg.circle(frame.px(p.x), frame.py(p.y), radius, s.color, { opacity, stroke: bubble ? s.color : undefined, strokeWidth: bubble ? 1 : undefined });
    }
  }
  for (const s of series) {
    if (!s.showLine || s.points.length < 2) continue;
    const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"} ${r(frame.px(p.x))} ${r(frame.py(p.y))}`).join(" ");
    svg.path(d, { stroke: s.color, strokeWidth: num(s.ds.borderWidth) ?? 2.2, dash: dashArray(s.ds), linejoin: true });
  }
  drawReferenceLines(svg, frame, refLines, xAxis, yAxis);
}

/* ------------------------------------------------------------------ */
/*  Histogram                                                           */
/* ------------------------------------------------------------------ */

function renderHistogram(svg: SvgBuilder, config: AnyRecord, area: Area): void {
  const datasets: AnyRecord[] = Array.isArray(config.data?.datasets) ? config.data.datasets.filter((d: unknown) => d && typeof d === "object") : [];
  const binSet = datasets.find(ds => ds.type !== "line");
  const bins = (Array.isArray(binSet?.data) ? binSet!.data : [])
    .map((b: unknown) => {
      if (!b || typeof b !== "object") return null;
      const rec = b as AnyRecord;
      const x0 = num(rec.x0);
      const x1 = num(rec.x1);
      const count = num(rec.count ?? rec.y);
      if (x0 === null || x1 === null || count === null) return null;
      return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), count };
    })
    .filter((b: unknown): b is { x0: number; x1: number; count: number } => b !== null);
  if (bins.length === 0) {
    noData(svg, area, "No histogram bins available.");
    return;
  }
  const overlays = datasets.filter(ds => ds.type === "line").map((ds, index) => ({
    ds,
    color: opaque(safeColor(ds.borderColor, CHART_PALETTE[(index + 1) % CHART_PALETTE.length])),
    points: (Array.isArray(ds.data) ? ds.data : [])
      .map((p: unknown) => (p && typeof p === "object" ? { x: num((p as AnyRecord).x), y: num((p as AnyRecord).y) } : null))
      .filter((p: { x: number | null; y: number | null } | null): p is { x: number; y: number } => !!p && p.x !== null && p.y !== null),
  }));
  const refLines = readReferenceLines(config);
  const xs = bins.flatMap((b: { x0: number; x1: number }) => [b.x0, b.x1]);
  const ys = [0, ...bins.map((b: { count: number }) => b.count), ...overlays.flatMap(o => o.points.map((p: { y: number }) => p.y))];
  const xAxis = linearAxis(xs, axisTitle(config, "x"), {});
  const yAxis = linearAxis(ys, axisTitle(config, "y"), { includeZero: true });
  const legendDatasets = [binSet!, ...overlays.map(o => o.ds)];
  const legend = legendEntriesFromDatasets(svg, config, legendDatasets, "box");
  const legendHeight = drawLegend(svg, legend, area.left + 10, area.right, area.top);
  const frame = drawFrame(svg, { ...area, top: area.top + legendHeight }, xAxis, yAxis);
  const fill = safeColor(binSet!.backgroundColor, CHART_PALETTE[0]);
  for (const b of bins) {
    const x0 = frame.px(b.x0);
    const x1 = frame.px(b.x1);
    const y = frame.py(b.count);
    const gap = Math.min(1.5, Math.abs(x1 - x0) * 0.08);
    svg.rect(Math.min(x0, x1) + gap / 2, y, Math.max(1, Math.abs(x1 - x0) - gap), frame.py(0) - y, fill, { rx: 1 });
  }
  for (const o of overlays) {
    if (o.points.length < 2) continue;
    const d = o.points.map((p: { x: number; y: number }, i: number) => `${i === 0 ? "M" : "L"} ${r(frame.px(p.x))} ${r(frame.py(p.y))}`).join(" ");
    svg.path(d, { stroke: o.color, strokeWidth: 2.2, dash: dashArray(o.ds), linejoin: true });
  }
  drawReferenceLines(svg, frame, refLines, xAxis, yAxis);
}

/* ------------------------------------------------------------------ */
/*  Box plot                                                            */
/* ------------------------------------------------------------------ */

function renderBoxplot(svg: SvgBuilder, config: AnyRecord, area: Area): void {
  const datasets: AnyRecord[] = Array.isArray(config.data?.datasets) ? config.data.datasets : [];
  const ds = datasets[0] || {};
  const labelsRaw: unknown[] = Array.isArray(config.data?.labels) ? config.data.labels : [];
  const boxes = (Array.isArray(ds.data) ? ds.data : []).map((b: unknown) => {
    if (!b || typeof b !== "object") return null;
    const rec = b as AnyRecord;
    const q1 = num(rec.q1);
    const median = num(rec.median);
    const q3 = num(rec.q3);
    const min = num(rec.min ?? rec.whiskerLow);
    const max = num(rec.max ?? rec.whiskerHigh);
    if (q1 === null || median === null || q3 === null || min === null || max === null) return null;
    const outliers: number[] = Array.isArray(rec.outliers) ? rec.outliers.map((v: unknown) => num(v)).filter((v: number | null): v is number => v !== null).slice(0, 40) : [];
    return { q1, median, q3, min, max, mean: num(rec.mean), outliers };
  });
  const valid = boxes.filter((b: unknown) => b !== null);
  if (valid.length === 0) {
    noData(svg, area, "No box-plot summaries available.");
    return;
  }
  const labels = boxes.map((_: unknown, i: number) => (labelsRaw[i] !== undefined ? String(labelsRaw[i]) : `${i + 1}`));
  const values: number[] = [];
  for (const b of valid as Array<{ min: number; max: number; outliers: number[] }>) values.push(b.min, b.max, ...b.outliers);
  const yCfg = config.options?.scales?.y;
  const yAxis = linearAxis(values, axisTitle(config, "y"), { fixedMin: num(yCfg?.min), fixedMax: num(yCfg?.max) });
  const xAxis: BandAxis = { kind: "band", labels, title: axisTitle(config, "x") };
  const frame = drawFrame(svg, area, xAxis, yAxis);
  const color = safeColor(ds.backgroundColor, CHART_PALETTE[0]);
  const stroke = opaque(safeColor(ds.borderColor, "#1c5cab"));
  const boxWidth = Math.min(64, frame.bandX * 0.55);
  boxes.forEach((b: { q1: number; median: number; q3: number; min: number; max: number; mean: number | null; outliers: number[] } | null, i: number) => {
    if (!b) return;
    const cx = frame.px(i);
    const yq1 = frame.py(b.q1);
    const yq3 = frame.py(b.q3);
    svg.line(cx, frame.py(b.min), cx, yq3, stroke, 1.2);
    svg.line(cx, yq1, cx, frame.py(b.max), stroke, 1.2);
    svg.line(cx - boxWidth * 0.25, frame.py(b.min), cx + boxWidth * 0.25, frame.py(b.min), stroke, 1.2);
    svg.line(cx - boxWidth * 0.25, frame.py(b.max), cx + boxWidth * 0.25, frame.py(b.max), stroke, 1.2);
    svg.rect(cx - boxWidth / 2, Math.min(yq1, yq3), boxWidth, Math.max(1, Math.abs(yq1 - yq3)), color, { opacity: 0.35, stroke, strokeWidth: 1.2, rx: 2 });
    svg.line(cx - boxWidth / 2, frame.py(b.median), cx + boxWidth / 2, frame.py(b.median), INK, 2);
    if (b.mean !== null && b.mean >= yAxis.min && b.mean <= yAxis.max) {
      const my = frame.py(b.mean);
      svg.path(`M ${r(cx)} ${r(my - 4)} L ${r(cx + 4)} ${r(my)} L ${r(cx)} ${r(my + 4)} L ${r(cx - 4)} ${r(my)} Z`, { fill: SURFACE, stroke: INK, strokeWidth: 1.2 });
    }
    for (const o of b.outliers) {
      if (o < yAxis.min || o > yAxis.max) continue;
      svg.circle(cx, frame.py(o), 2.4, "none", { stroke, strokeWidth: 1 });
    }
  });
  drawReferenceLines(svg, frame, readReferenceLines(config), xAxis, yAxis);
}

/* ------------------------------------------------------------------ */
/*  Forest / dot plot                                                   */
/* ------------------------------------------------------------------ */

function renderForest(svg: SvgBuilder, config: AnyRecord, area: Area): void {
  const datasets: AnyRecord[] = Array.isArray(config.data?.datasets) ? config.data.datasets.filter((d: unknown) => d && typeof d === "object") : [];
  const labelsRaw: unknown[] = Array.isArray(config.data?.labels) ? config.data.labels : [];
  const rows = Math.max(labelsRaw.length, ...datasets.map(ds => (Array.isArray(ds.data) ? ds.data.length : 0)), 0);
  const series = datasets.map((ds, index) => ({
    ds,
    color: opaque(safeColor(ds.borderColor ?? ds.backgroundColor, CHART_PALETTE[index % CHART_PALETTE.length])),
    points: Array.from({ length: rows }, (_, i) => {
      const raw = Array.isArray(ds.data) ? ds.data[i] : null;
      if (raw === null || raw === undefined) return null;
      if (typeof raw === "object" && !Array.isArray(raw)) {
        const rec = raw as AnyRecord;
        const estimate = num(rec.estimate ?? rec.x ?? rec.value);
        if (estimate === null) return null;
        const low = num(rec.low ?? rec.lower);
        const high = num(rec.high ?? rec.upper);
        return { estimate, low, high };
      }
      const estimate = num(raw);
      return estimate === null ? null : { estimate, low: null, high: null };
    }),
  }));
  const values: number[] = [];
  for (const s of series) for (const p of s.points) if (p) {
    values.push(p.estimate);
    if (p.low !== null) values.push(p.low);
    if (p.high !== null) values.push(p.high);
  }
  if (rows === 0 || values.length === 0) {
    noData(svg, area, "No estimates available for interval plot.");
    return;
  }
  const refLines = readReferenceLines(config);
  const hasExplicitRefs = Array.isArray(config.options?.referenceLines);
  const effectiveRefs: ReferenceLine[] = hasExplicitRefs ? refLines : [{ axis: "x", value: 0 }];
  for (const ref of effectiveRefs) { const v = num(ref.value); if (v !== null && ref.axis === "x") values.push(v); }
  const xCfg = config.options?.scales?.x;
  const xAxis = linearAxis(values, axisTitle(config, "x"), { fixedMin: num(xCfg?.min), fixedMax: num(xCfg?.max) });
  const labels = Array.from({ length: rows }, (_, i) => (labelsRaw[i] !== undefined ? String(labelsRaw[i]) : `${i + 1}`));
  const yAxis: BandAxis = { kind: "band", labels, title: axisTitle(config, "y") };
  const legend = legendEntriesFromDatasets(svg, config, datasets, "point");
  const legendHeight = drawLegend(svg, legend, area.left + 10, area.right, area.top);
  const frame = drawFrame(svg, { ...area, top: area.top + legendHeight }, xAxis, yAxis, { xGrid: true, yGrid: false, maxBandLabelChars: 40 });
  drawReferenceLines(svg, frame, effectiveRefs, xAxis, yAxis);
  const k = series.length;
  const spread = Math.min(frame.bandY * 0.5, 10 * (k - 1));
  series.forEach((s, sIndex) => {
    const offset = k > 1 ? -spread / 2 + (spread * sIndex) / (k - 1) : 0;
    s.points.forEach((p, i) => {
      if (!p) return;
      const y = frame.py(i) + offset;
      if (p.low !== null && p.high !== null) {
        const x1 = frame.px(Math.max(xAxis.min, p.low));
        const x2 = frame.px(Math.min(xAxis.max, p.high));
        svg.line(x1, y, x2, y, s.color, 2);
        svg.line(x1, y - 4, x1, y + 4, s.color, 1.6);
        svg.line(x2, y - 4, x2, y + 4, s.color, 1.6);
      }
      svg.circle(frame.px(p.estimate), y, 4.6, s.color, { stroke: SURFACE, strokeWidth: 1.5 });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Heatmap                                                             */
/* ------------------------------------------------------------------ */

function renderHeatmap(svg: SvgBuilder, config: AnyRecord, area: Area): void {
  const labels: string[] = Array.isArray(config.data?.labels) ? config.data.labels.map((l: unknown) => String(l)) : [];
  const yLabelsRaw: unknown[] = Array.isArray(config.data?.yLabels) ? config.data.yLabels : labels;
  const yLabels = yLabelsRaw.map(l => String(l));
  const cells: Array<{ x: number; y: number; v: number }> = [];
  const datasets: AnyRecord[] = Array.isArray(config.data?.datasets) ? config.data.datasets : [];
  if (datasets.length > 0 && Array.isArray(datasets[0]?.data)) {
    for (const d of datasets[0].data) {
      if (!d || typeof d !== "object") continue;
      const x = num((d as AnyRecord).x);
      const y = num((d as AnyRecord).y);
      const v = num((d as AnyRecord).v);
      if (x === null || y === null || v === null) continue;
      if (x < 0 || y < 0 || x >= labels.length || y >= yLabels.length) continue;
      cells.push({ x: Math.round(x), y: Math.round(y), v });
    }
  }
  if (labels.length < 2 || cells.length === 0) {
    noData(svg, area, "No heatmap data available.");
    return;
  }
  const triangle = config.options?.heatmap?.triangle;
  const visibleCells = triangle === "lower" ? cells.filter(c => c.x <= c.y) : cells;
  const values = visibleCells.map(c => c.v);
  const maxAbs = Math.max(...values.map(v => Math.abs(v)), 1e-9);
  const diverging = config.options?.heatmap?.scale !== "sequential" && (values.some(v => v < 0) || values.every(v => Math.abs(v) <= 1));
  const domainMax = diverging ? (values.every(v => Math.abs(v) <= 1) ? 1 : maxAbs) : Math.max(...values);
  const domainMin = diverging ? -domainMax : Math.min(0, Math.min(...values));
  const colorFor = (v: number): string => {
    if (diverging) {
      const t = Math.max(-1, Math.min(1, v / (domainMax || 1)));
      return t >= 0 ? mixRgb(DIVERGING_MID, DIVERGING_POS, t) : mixRgb(DIVERGING_MID, DIVERGING_NEG, -t);
    }
    const t = (v - domainMin) / ((domainMax - domainMin) || 1);
    return mixRgb(SEQUENTIAL_LOW, SEQUENTIAL_HIGH, t);
  };

  const n = labels.length;
  const m = yLabels.length;
  const colorBarWidth = 78;
  const maxLabelWidth = Math.min((area.right - area.left) * 0.3, 190);
  const yTexts = yLabels.map(l => truncateToWidth(truncateChars(svg.clean(l) || "-", 32), maxLabelWidth, TICK_FONT));
  const xTexts = labels.map(l => truncateToWidth(truncateChars(svg.clean(l) || "-", 32), maxLabelWidth, TICK_FONT));
  const leftBand = Math.max(...yTexts.map(t => estimateTextWidth(t, TICK_FONT))) + 10;
  const xTitle = axisTitle(config, "x");
  const bottomBand = Math.sin(Math.PI * 45 / 180) * Math.max(...xTexts.map(t => estimateTextWidth(t, TICK_FONT))) + 18 + (xTitle ? 18 : 0);
  const availW = area.right - area.left - leftBand - colorBarWidth;
  const availH = area.bottom - area.top - bottomBand;
  const cell = Math.max(8, Math.min(availW / n, availH / m, 90));
  const gridW = cell * n;
  const gridH = cell * m;
  const gridX = area.left + leftBand + Math.max(0, (availW - gridW) / 2);
  const gridY = area.top + 4;

  for (const c of visibleCells) {
    const x = gridX + c.x * cell;
    const y = gridY + c.y * cell;
    svg.rect(x + 1, y + 1, cell - 2, cell - 2, colorFor(c.v), { rx: 2 });
    if (cell >= 26) {
      const t = diverging ? Math.abs(c.v) / (domainMax || 1) : (c.v - domainMin) / ((domainMax - domainMin) || 1);
      const fontSize = Math.max(8, Math.min(12, cell / 4.2));
      const label = Math.abs(c.v) >= 100 ? c.v.toFixed(0) : c.v.toFixed(2);
      svg.text(x + cell / 2, y + cell / 2 + fontSize * 0.35, label, { size: fontSize, anchor: "middle", fill: t > 0.55 ? SURFACE : INK });
    }
  }
  yTexts.forEach((t, i) => {
    svg.text(gridX - 6, gridY + i * cell + cell / 2 + TICK_FONT * 0.35, t, { size: TICK_FONT, anchor: "end", fill: INK_SECONDARY });
  });
  xTexts.forEach((t, i) => {
    const x = gridX + i * cell + cell / 2;
    const y = gridY + gridH + 10;
    svg.text(x + 3, y, t, { size: TICK_FONT, anchor: "end", fill: INK_SECONDARY, rotate: -45 });
  });
  if (xTitle) svg.text(gridX + gridW / 2, area.bottom - 2, svg.clean(xTitle), { size: AXIS_TITLE_FONT, anchor: "middle", fill: INK });

  // Colour bar
  const barX = gridX + gridW + 26;
  const barH = Math.min(gridH, 220);
  const barY = gridY + (gridH - barH) / 2;
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const v = domainMax - t * (domainMax - domainMin);
    svg.rect(barX, barY + (i * barH) / steps, 14, barH / steps + 0.6, colorFor(v));
  }
  const fmt = makeTickFormatter((domainMax - domainMin) / 4, Math.max(Math.abs(domainMax), Math.abs(domainMin)));
  const tickValues = diverging ? [domainMax, domainMax / 2, 0, -domainMax / 2, -domainMax] : [domainMax, (domainMax + domainMin) / 2, domainMin];
  for (const v of tickValues) {
    const y = barY + ((domainMax - v) / ((domainMax - domainMin) || 1)) * barH;
    svg.line(barX + 14, y, barX + 18, y, AXIS, 1);
    svg.text(barX + 21, y + 3.5, fmt(v), { size: 10, fill: INK_SECONDARY });
  }
  const scaleLabel = svg.clean(readOptionalText(config.options?.heatmap?.legend) || (diverging ? "" : ""));
  if (scaleLabel) svg.text(barX, barY - 8, truncateToWidth(scaleLabel, colorBarWidth, 10), { size: 10, fill: INK_SECONDARY });
}

/* ------------------------------------------------------------------ */
/*  Pie / doughnut                                                      */
/* ------------------------------------------------------------------ */

function renderPie(svg: SvgBuilder, config: AnyRecord, area: Area, doughnut: boolean): void {
  const ds: AnyRecord = Array.isArray(config.data?.datasets) && config.data.datasets[0] ? config.data.datasets[0] : {};
  const labels: unknown[] = Array.isArray(config.data?.labels) ? config.data.labels : [];
  const values: unknown[] = Array.isArray(ds.data) ? ds.data : [];
  let slices = values
    .map((v, i) => ({
      value: Math.max(0, num(v) ?? 0),
      label: svg.clean(labels[i] ?? `Category ${i + 1}`) || `Category ${i + 1}`,
      color: colorAt(ds.backgroundColor, i, CHART_PALETTE[i % CHART_PALETTE.length]),
    }))
    .filter(s => s.value > 0);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) {
    noData(svg, area, "No positive values available for pie chart.");
    return;
  }
  if (slices.length > 8) {
    const sorted = slices.slice().sort((a, b) => b.value - a.value);
    const kept = sorted.slice(0, 7);
    const rest = sorted.slice(7).reduce((sum, s) => sum + s.value, 0);
    slices = [...kept, { value: rest, label: "Other", color: "#b9b8b0" }];
  }
  const legendWidth = Math.min(300, (area.right - area.left) * 0.42);
  const radius = Math.max(40, Math.min((area.right - area.left - legendWidth) / 2 - 24, (area.bottom - area.top) / 2 - 10));
  const cx = area.left + (area.right - area.left - legendWidth) / 2;
  const cy = (area.top + area.bottom) / 2;
  if (slices.length === 1) {
    svg.circle(cx, cy, radius, slices[0].color);
  } else {
    let angle = -Math.PI / 2;
    for (const s of slices) {
      const sweep = (s.value / total) * Math.PI * 2;
      const end = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const sx = cx + radius * Math.cos(angle);
      const sy = cy + radius * Math.sin(angle);
      const ex = cx + radius * Math.cos(end);
      const ey = cy + radius * Math.sin(end);
      svg.path(`M ${r(cx)} ${r(cy)} L ${r(sx)} ${r(sy)} A ${r(radius)} ${r(radius)} 0 ${large} 1 ${r(ex)} ${r(ey)} Z`, { fill: s.color, stroke: SURFACE, strokeWidth: 2 });
      angle = end;
    }
  }
  if (doughnut) svg.circle(cx, cy, radius * 0.55, SURFACE);
  const legendX = area.right - legendWidth + 10;
  const rowH = 20;
  let y = cy - (slices.length * rowH) / 2 + 12;
  for (const s of slices) {
    const pct = ((s.value / total) * 100).toFixed(1);
    svg.rect(legendX, y - 10, 12, 12, s.color, { rx: 2 });
    svg.text(legendX + 18, y, truncateToWidth(`${s.label} (${pct}%)`, legendWidth - 28, 11.5), { size: 11.5, fill: INK_SECONDARY });
    y += rowH;
  }
}
