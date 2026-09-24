/**
 * Figures and tables as first-class paper assets.
 *
 * Numbers in figures and tables come from the deterministic analysis engine. Rather than
 * asking the LLM to re-typeset them (which produced broken LaTeX tables, lost figures and
 * occasionally altered values), the writing stages reference assets through placement
 * markers such as [[FIGURE:2]] / [[TABLE:3]]. This module numbers the assets, typesets
 * them deterministically (LaTeX and Markdown) and substitutes the markers, placing any
 * asset the text forgot next to its first mention while keeping numbering monotonic.
 */
import type { ExperimentOutput } from "./experiment-runner";

export interface FigureManifestEntry {
  number: number;
  /** Graphics key used by \includegraphics and the PDF generator (figure_<n>). */
  key: string;
  name: string;
  caption: string;
  section: string;
  url: string;
  fileKey?: string;
}

export interface TableManifestEntry {
  number: number;
  key: string;
  name: string;
  title: string;
  headers: string[];
  rows: string[][];
  notes?: string;
  section: string;
}

/** Tables that document the pipeline rather than the research; kept as artifacts only. */
const NON_PAPER_TABLES = new Set(["method_applicability_matrix"]);

const TABLE_SECTION_ORDER: Record<string, number> = { descriptive: 1, methods: 2, main: 3, diagnostic: 4, appendix: 5 };
const TABLE_NAME_PRIORITY: Record<string, number> = { descriptive_statistics: 0 };

export function buildFigureManifest(output: ExperimentOutput | null | undefined): FigureManifestEntry[] {
  if (!output?.charts?.length) return [];
  // Order must match experimentOutput.charts, because figure_<n> keys are assigned by index.
  return output.charts.map((chart, index) => ({
    number: index + 1,
    key: `figure_${index + 1}`,
    name: chart.name,
    caption: (chart.caption || chart.description || chart.name).trim(),
    section: chart.section || "main",
    url: chart.url,
    fileKey: chart.fileKey,
  }));
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(current); current = ""; }
    else current += ch;
  }
  cells.push(current);
  return cells;
}

export function buildTableManifest(output: ExperimentOutput | null | undefined): TableManifestEntry[] {
  if (!output?.tables?.length) return [];
  const entries = output.tables
    .filter(table => !NON_PAPER_TABLES.has(table.name))
    .map((table, index) => {
      let headers = table.headers?.map(h => String(h)) || [];
      let rows = table.rows?.map(row => row.map(cell => (cell === null || cell === undefined ? "" : String(cell)))) || [];
      if (headers.length === 0 && table.data) {
        const lines = table.data.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
        headers = lines.length ? parseCsvLine(lines[0]) : [];
        rows = lines.slice(1).map(parseCsvLine);
      }
      return {
        order: index,
        name: table.name,
        title: (table.description || table.name).trim(),
        headers,
        rows,
        notes: table.notes,
        section: table.section || "main",
      };
    })
    .filter(entry => entry.headers.length > 0 && entry.rows.length > 0)
    .sort((a, b) =>
      (TABLE_NAME_PRIORITY[a.name] ?? 9) - (TABLE_NAME_PRIORITY[b.name] ?? 9) ||
      (TABLE_SECTION_ORDER[a.section] ?? 3) - (TABLE_SECTION_ORDER[b.section] ?? 3) ||
      a.order - b.order);
  return entries.map((entry, index) => ({
    number: index + 1,
    key: `table_${index + 1}`,
    name: entry.name,
    title: entry.title,
    headers: entry.headers,
    rows: entry.rows,
    notes: entry.notes,
    section: entry.section,
  }));
}

/* ------------------------------------------------------------------ */
/*  Typesetting                                                         */
/* ------------------------------------------------------------------ */

const LATEX_SPECIALS: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  "$": "\\$",
  "#": "\\#",
  "_": "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

export function latexEscape(text: string): string {
  return String(text ?? "")
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/[\\&%$#_{}~^]/g, ch => LATEX_SPECIALS[ch])
    .replace(/\s+/g, " ")
    .trim();
}

function isNumericCell(cell: string): boolean {
  return /^[\s([]*[-+]?(\d[\d,]*\.?\d*(e[-+]?\d+)?|\.\d+)%?\**[)\]]*\s*$/i.test(cell.trim());
}

export function tableToLatex(entry: TableManifestEntry): string {
  const columnCount = entry.headers.length;
  const spec = ["l", ...Array.from({ length: columnCount - 1 }, (_, i) => {
    const numeric = entry.rows.filter(row => row[i + 1] && isNumericCell(row[i + 1])).length;
    return numeric >= entry.rows.length * 0.5 ? "r" : "l";
  })].join("");
  const sizeCommand = columnCount >= 7 ? "\\footnotesize" : columnCount >= 5 ? "\\small" : "";
  const lines = [
    "\\begin{table}[htbp]",
    "\\centering",
    `\\caption{${latexEscape(entry.title)}}`,
    `\\label{tab:${entry.key}}`,
    ...(sizeCommand ? [sizeCommand] : []),
    "\\begin{adjustbox}{max width=\\textwidth}",
    `\\begin{tabular}{${spec}}`,
    "\\toprule",
    `${entry.headers.map(latexEscape).join(" & ")} \\\\`,
    "\\midrule",
    ...entry.rows.map(row => `${Array.from({ length: columnCount }, (_, i) => latexEscape(row[i] ?? "")).join(" & ")} \\\\`),
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{adjustbox}",
  ];
  if (entry.notes) {
    lines.push(`\\par\\vspace{2pt}{\\footnotesize \\textit{Notes:} ${latexEscape(entry.notes)}\\par}`);
  }
  lines.push("\\end{table}");
  return lines.join("\n");
}

export function figureToLatex(entry: FigureManifestEntry): string {
  return [
    "\\begin{figure}[htbp]",
    "\\centering",
    `\\includegraphics[width=0.92\\textwidth]{${entry.key}}`,
    `\\caption{${latexEscape(entry.caption)}}`,
    `\\label{fig:${entry.key}}`,
    "\\end{figure}",
  ].join("\n");
}

function markdownCell(value: string): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function tableToMarkdown(entry: TableManifestEntry): string {
  const header = `| ${entry.headers.map(h => markdownCell(h) || " ").join(" | ")} |`;
  const divider = `| ${entry.headers.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`;
  const body = entry.rows.map(row => `| ${entry.headers.map((_, i) => markdownCell(row[i] ?? "") || " ").join(" | ")} |`);
  return [
    `**Table ${entry.number}.** ${entry.title}`,
    "",
    header,
    divider,
    ...body,
    ...(entry.notes ? ["", `*Notes:* ${entry.notes}`] : []),
  ].join("\n");
}

export function figureToMarkdown(entry: FigureManifestEntry): string {
  return `![Figure ${entry.number}](${entry.url})\n\n*Figure ${entry.number}.* ${entry.caption}`;
}

/** Compact, prompt-friendly listing of every figure and table with its contents. */
export function describeAssetsForPrompt(figures: FigureManifestEntry[], tables: TableManifestEntry[], options: { maxTableRows?: number } = {}): string {
  const maxRows = options.maxTableRows ?? 18;
  const figureLines = figures.map(f => `Figure ${f.number} [${f.section}] (marker [[FIGURE:${f.number}]]): ${f.caption}`);
  const tableBlocks = tables.map(t => {
    const rows = t.rows.slice(0, maxRows).map(row => `  ${row.join(" | ")}`);
    return [
      `Table ${t.number} [${t.section}] (marker [[TABLE:${t.number}]]): ${t.title}`,
      `  ${t.headers.join(" | ")}`,
      ...rows,
      t.rows.length > maxRows ? `  ... (${t.rows.length - maxRows} more rows)` : "",
      t.notes ? `  Notes: ${t.notes}` : "",
    ].filter(Boolean).join("\n");
  });
  return [
    figures.length ? `FIGURES (${figures.length}):\n${figureLines.join("\n")}` : "FIGURES: none",
    tables.length ? `TABLES (${tables.length}):\n${tableBlocks.join("\n\n")}` : "TABLES: none",
  ].join("\n\n");
}

/* ------------------------------------------------------------------ */
/*  Marker handling                                                     */
/* ------------------------------------------------------------------ */

const MARKER_PATTERN = /(?:\\texttt\{)?(?:\\?\[){2}\s*(FIGURE|TABLE|FIG|TAB)\s*[:\s]\s*(\d{1,2})\s*(?:\\?\]){2}\}?/gi;

type AssetKind = "figure" | "table";

function markerKind(raw: string): AssetKind {
  return raw.toUpperCase().startsWith("FIG") ? "figure" : "table";
}

function token(kind: AssetKind, number: number): string {
  return `@@ASSET_${kind.toUpperCase()}_${number}@@`;
}

/** Removes placement markers (e.g. for text that is shown without assets). */
export function stripAssetMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, "").replace(/\n{3,}/g, "\n\n");
}

/** Numbers of figures/tables referenced by markers in a text. */
export function markersInText(text: string): { figures: number[]; tables: number[] } {
  const figures = new Set<number>();
  const tables = new Set<number>();
  for (const match of Array.from(text.matchAll(MARKER_PATTERN))) {
    (markerKind(match[1]) === "figure" ? figures : tables).add(Number(match[2]));
  }
  return { figures: Array.from(figures).sort((a, b) => a - b), tables: Array.from(tables).sort((a, b) => a - b) };
}

function mentionPattern(kind: AssetKind, number: number, format: "latex" | "markdown"): RegExp {
  const word = kind === "figure" ? "(?:Figure|Fig\\.)" : "Table";
  const ref = kind === "figure" ? `fig:figure_${number}` : `tab:table_${number}`;
  const latexRef = format === "latex" ? `|\\\\(?:auto)?ref\\{${ref}\\}` : "";
  return new RegExp(`(?:${word}(?:~|\\s)+(?:\\\\ref\\{${ref}\\}|${number})(?![\\d.]\\d)${latexRef})`, "i");
}

/** Offset just after the paragraph that contains `from` (blank line or next heading). */
function paragraphEnd(text: string, from: number): number {
  const blank = text.indexOf("\n\n", from);
  const headingRe = /\n\s*(?:\\(?:sub)*section\*?\{|#{1,4}\s)/g;
  headingRe.lastIndex = from;
  const heading = headingRe.exec(text);
  const ends = [blank, heading ? heading.index : -1].filter(i => i >= 0);
  return ends.length ? Math.min(...ends) : text.length;
}

function fallbackAnchor(text: string, format: "latex" | "markdown", section: string): number {
  const patterns = format === "latex"
    ? [
        section === "appendix" ? /\\section\*?\{\s*Appendix/i : null,
        /\\section\*?\{[^}]*(Discussion|Conclusion|Limitations)/i,
        /\\section\*?\{\s*References/i,
        /\\begin\{thebibliography\}/,
        /\\end\{document\}/,
      ]
    : [
        section === "appendix" ? /\n#{1,3}\s*Appendix/i : null,
        /\n#{1,3}\s*(?:\d+\.?\s*)?(Discussion|Conclusion|Limitations)/i,
        /\n#{1,3}\s*(?:\d+\.?\s*)?References/i,
      ];
  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];
    if (!pattern) continue;
    const m = pattern.exec(text);
    if (!m) continue;
    if (index === 0) {
      // Appendix assets go after the appendix heading line, not before it.
      const lineEnd = text.indexOf("\n", m.index + 1);
      return lineEnd >= 0 ? lineEnd : text.length;
    }
    return m.index;
  }
  return text.length;
}

interface PlacementResult {
  text: string;
  placedFromMarkers: number[];
  placedByMention: number[];
  placedAtFallback: number[];
}

/**
 * Converts markers to tokens, drops duplicates and positions every asset: at its marker,
 * else after the paragraph that first mentions it, else before Discussion/Conclusion.
 * Positions are made monotonic so printed numbering follows the manifest numbering.
 */
function placeAssets(
  input: string,
  kind: AssetKind,
  numbers: number[],
  sectionOf: (n: number) => string,
  format: "latex" | "markdown",
): PlacementResult {
  const result: PlacementResult = { text: input, placedFromMarkers: [], placedByMention: [], placedAtFallback: [] };
  const valid = new Set(numbers);
  // 1. Markers -> tokens (first occurrence wins; unknown numbers and duplicates removed).
  const seen = new Set<number>();
  let text = input.replace(MARKER_PATTERN, (_m, rawKind: string, rawNumber: string) => {
    if (markerKind(rawKind) !== kind) return _m;
    const n = Number(rawNumber);
    if (!valid.has(n) || seen.has(n)) return "";
    seen.add(n);
    return `\n${token(kind, n)}\n`;
  });
  // 2. Collect desired positions.
  const desired = new Map<number, number>();
  const tokenRe = new RegExp(`@@ASSET_${kind.toUpperCase()}_(\\d+)@@`, "g");
  let stripped = "";
  let last = 0;
  for (const match of Array.from(text.matchAll(tokenRe))) {
    stripped += text.slice(last, match.index);
    desired.set(Number(match[1]), stripped.length);
    last = (match.index ?? 0) + match[0].length;
  }
  stripped += text.slice(last);
  text = stripped;
  for (const n of numbers) {
    if (desired.has(n)) { result.placedFromMarkers.push(n); continue; }
    if (sectionOf(n) !== "appendix") {
      const mention = mentionPattern(kind, n, format).exec(text);
      if (mention) {
        desired.set(n, paragraphEnd(text, mention.index));
        result.placedByMention.push(n);
        continue;
      }
    }
    desired.set(n, fallbackAnchor(text, format, sectionOf(n)));
    result.placedAtFallback.push(n);
  }
  // 3. Monotonic positions, then insert from the back so offsets stay valid.
  const ordered = [...numbers].sort((a, b) => a - b);
  const finalPos = new Map<number, number>();
  let floor = 0;
  for (const n of ordered) {
    const pos = Math.max(desired.get(n) ?? text.length, floor);
    finalPos.set(n, pos);
    floor = pos;
  }
  for (const n of [...ordered].reverse()) {
    const pos = finalPos.get(n)!;
    text = `${text.slice(0, pos)}\n\n${token(kind, n)}\n\n${text.slice(pos)}`;
  }
  result.text = text;
  return result;
}

function isDataHeavyLatexTable(env: string): boolean {
  const body = env.replace(/\\(?:toprule|midrule|bottomrule|hline|cline\{[^}]*\})/g, "");
  const cells = body.split(/&|\\\\/).map(c => c.replace(/\\[a-zA-Z]+(\{[^}]*\})?/g, "").trim()).filter(Boolean);
  if (cells.length < 6) return false;
  const numeric = cells.filter(isNumericCell).length;
  return numeric / cells.length >= 0.25;
}

export interface AssetInsertionReport {
  figuresFromMarkers: number[];
  figuresByMention: number[];
  figuresAtFallback: number[];
  tablesFromMarkers: number[];
  tablesByMention: number[];
  tablesAtFallback: number[];
  removedLlmFigures: number;
  removedLlmTables: number;
}

/**
 * Replaces placement markers in LLM-written LaTeX with deterministic figure/table
 * environments and guarantees every asset appears exactly once.
 */
export function insertAssetsIntoLatex(latex: string, figures: FigureManifestEntry[], tables: TableManifestEntry[]): { latex: string; report: AssetInsertionReport } {
  let text = latex;
  let removedLlmFigures = 0;
  let removedLlmTables = 0;
  // LLM-authored figure environments: keep their position as a marker, drop the markup.
  text = text.replace(/\\begin\{figure\*?\}[\s\S]*?\\end\{figure\*?\}/g, (env) => {
    removedLlmFigures++;
    const key = env.match(/\\includegraphics(?:\[[^\]]*\])?\{\s*figure_(\d+)(?:\.\w+)?\s*\}/);
    return key ? `\n[[FIGURE:${key[1]}]]\n` : "";
  });
  // LLM-authored numeric tables duplicate (and can distort) the deterministic ones.
  if (tables.length > 0) {
    text = text.replace(/\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}/g, (env) => {
      if (!isDataHeavyLatexTable(env)) return env;
      removedLlmTables++;
      return "";
    });
  }
  const figureNumbers = figures.map(f => f.number);
  const tableNumbers = tables.map(t => t.number);
  const tableSection = new Map(tables.map(t => [t.number, t.section]));
  const figResult = placeAssets(text, "figure", figureNumbers, () => "main", "latex");
  text = figResult.text;
  const needsAppendix = tables.some(t => t.section === "appendix") && !/\\section\*?\{\s*Appendix/i.test(text);
  if (needsAppendix) {
    const anchor = /\\begin\{thebibliography\}|\\end\{document\}/.exec(text);
    const pos = anchor ? anchor.index : text.length;
    text = `${text.slice(0, pos)}\\section*{Appendix: Supplementary Tables}\n\n${text.slice(pos)}`;
  }
  const tabResult = placeAssets(text, "table", tableNumbers, n => tableSection.get(n) || "main", "latex");
  text = tabResult.text;
  for (const f of figures) text = text.replace(token("figure", f.number), figureToLatex(f));
  for (const t of tables) text = text.replace(token("table", t.number), tableToLatex(t));
  text = text.replace(/\n{3,}/g, "\n\n");
  return {
    latex: text,
    report: {
      figuresFromMarkers: figResult.placedFromMarkers,
      figuresByMention: figResult.placedByMention,
      figuresAtFallback: figResult.placedAtFallback,
      tablesFromMarkers: tabResult.placedFromMarkers,
      tablesByMention: tabResult.placedByMention,
      tablesAtFallback: tabResult.placedAtFallback,
      removedLlmFigures,
      removedLlmTables,
    },
  };
}

/** Markdown counterpart used for the stored paper and the Markdown PDF fallback. */
export function insertAssetsIntoMarkdown(markdown: string, figures: FigureManifestEntry[], tables: TableManifestEntry[]): string {
  let text = markdown;
  const figResult = placeAssets(text, "figure", figures.map(f => f.number), () => "main", "markdown");
  text = figResult.text;
  if (tables.some(t => t.section === "appendix") && !/\n#{1,3}\s*Appendix/i.test(text)) {
    const refs = /\n#{1,3}\s*(?:\d+\.?\s*)?References/i.exec(text);
    const pos = refs ? refs.index : text.length;
    text = `${text.slice(0, pos)}\n\n## Appendix: Supplementary Tables\n\n${text.slice(pos)}`;
  }
  const tableSection = new Map(tables.map(t => [t.number, t.section]));
  const tabResult = placeAssets(text, "table", tables.map(t => t.number), n => tableSection.get(n) || "main", "markdown");
  text = tabResult.text;
  for (const f of figures) text = text.replace(token("figure", f.number), figureToMarkdown(f));
  for (const t of tables) text = text.replace(token("table", t.number), tableToMarkdown(t));
  return text.replace(/\n{3,}/g, "\n\n");
}
