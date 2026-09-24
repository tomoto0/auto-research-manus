/**
 * PDF Generator - Converts research paper content to PDF
 * Uses PDFKit (pure Node.js, no Chromium dependency) for PDF generation.
 *
 * Strategy:
 *  1. Parse LaTeX or Markdown content into structured sections
 *  2. Render to PDF using PDFKit with academic formatting
 *  3. Embed chart images directly from URLs
 */
import PDFDocument from "pdfkit";
import { marked } from "marked";
import * as https from "https";
import * as http from "http";
import * as fsNode from "fs";
import { execSync } from "child_process";
import { storageDownload } from "./storage";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface ChartImage {
  /** Unique key used in \includegraphics{<key>} */
  key: string;
  /** Remote URL of the chart image (S3 / CDN) */
  url: string;
  /** Storage key used for direct downloads when available */
  fileKey?: string;
  /** Human-readable name for the figure caption */
  name: string;
  /** Description for the figure caption */
  description: string;
}

/* ------------------------------------------------------------------ */
/*  Image fetching helper                                              */
/* ------------------------------------------------------------------ */

async function fetchImageBuffer(params: { url?: string; fileKey?: string }): Promise<Buffer | null> {
  if (params.fileKey) {
    try {
      const resp = await storageDownload(params.fileKey, { timeoutMs: 20000 });
      const arrayBuffer = await resp.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err: any) {
      console.warn(`[PDF] Direct storage download failed for ${params.fileKey}: ${err?.message || "unknown error"}`);
    }
  }

  const url = params.url;
  if (!url) return null;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 15000);
    const protocol = url.startsWith("https") ? https : http;
    protocol.get(url, { timeout: 10000 }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        fetchImageBuffer({ url: res.headers.location }).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks));
      });
      res.on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });
    }).on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

function isSvgBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf-8").trimStart();
  return sample.startsWith("<svg") || sample.startsWith("<?xml") || sample.includes("<svg");
}

function sanitizeSvgForRasterization(buffer: Buffer): Buffer {
  const svgText = buffer.toString("utf-8");
  const sanitized = svgText
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ");
  return Buffer.from(sanitized, "utf-8");
}

async function ensurePdfEmbeddableImage(buffer: Buffer): Promise<Buffer | null> {
  if (!isSvgBuffer(buffer)) {
    // Validate it's actually a PNG/JPEG by checking magic bytes
    if (buffer.length < 8) return null;
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
    const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
    if (!isPng && !isJpeg) {
      console.warn(`[PDF] Image buffer is neither PNG, JPEG, nor SVG (first bytes: ${buffer[0].toString(16)} ${buffer[1].toString(16)})`);
      return null;
    }
    return buffer;
  }
  try {
    const sharp = (await import("sharp")).default;
    const pngBuffer = await sharp(sanitizeSvgForRasterization(buffer))
      .resize({ width: 900, height: 560, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    if (pngBuffer[0] === 0x89 && pngBuffer[1] === 0x50 && pngBuffer.length > 500) {
      console.log(`[PDF] SVG → PNG conversion successful: ${pngBuffer.length} bytes`);
      return pngBuffer;
    }
    console.warn(`[PDF] SVG → PNG conversion produced invalid/tiny output (${pngBuffer.length} bytes)`);
    return null;
  } catch (err: any) {
    console.warn(`[PDF] SVG chart conversion failed: ${err?.message || "unknown error"}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  LaTeX / Markdown parser → structured content                       */
/* ------------------------------------------------------------------ */

interface PaperSection {
  type: "title" | "author" | "conference" | "abstract" | "heading" | "subheading" | "subsubheading" |
        "paragraph" | "figure" | "table" | "equation" | "list" | "bibliography" | "separator";
  text?: string;
  level?: number;
  items?: string[];
  imageUrl?: string;
  imageFileKey?: string;
  caption?: string;
  headers?: string[];
  rows?: string[][];
  tableCaption?: string;
  notes?: string;
}

function extractLatexCommandArgument(source: string, commandName: string): string | null {
  const marker = `\\${commandName}{`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  let depth = 1;
  let cursor = start + marker.length;
  let result = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "{") {
      depth += 1;
      result += char;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return result;
      result += char;
    } else {
      result += char;
    }
    cursor += 1;
  }
  return null;
}

export function parseLatexToSections(
  latexSource: string,
  title: string,
  conference: string,
  chartImages: ChartImage[] = []
): PaperSection[] {
  const sections: PaperSection[] = [];
  let tex = latexSource;

  // Strip code-block fences
  tex = tex.replace(/^```(?:latex|tex|\w*)\s*\n?/i, "");
  tex = tex.replace(/\n?```\s*$/i, "");

  // Build chart URL map
  const chartUrlMap = new Map<string, ChartImage>();
  chartImages.forEach((c, i) => {
    chartUrlMap.set(c.key, c);
    chartUrlMap.set(`figure_${i + 1}`, c);
    chartUrlMap.set(`figure_${i + 1}.png`, c);
    chartUrlMap.set(`figure_${i + 1}.jpg`, c);
    chartUrlMap.set(`figure_${i + 1}.jpeg`, c);
    chartUrlMap.set(`figure_${i + 1}.svg`, c);
  });

  // Build label→number map for cross-references (\ref{tab:X} → "1", \ref{fig:Y} → "2")
  const labelMap = new Map<string, string>();
  let figNum = 0, tabNum = 0;
  // Scan for figure labels
  const figEnvRegex = /\\begin\{figure\*?\}[\s\S]*?\\end\{figure\*?\}/g;
  let figMatch: RegExpExecArray | null;
  while ((figMatch = figEnvRegex.exec(tex)) !== null) {
    figNum++;
    const labelRegex = /\\label\{([^}]+)\}/g;
    let lm: RegExpExecArray | null;
    while ((lm = labelRegex.exec(figMatch[0])) !== null) {
      labelMap.set(lm[1], String(figNum));
    }
  }
  // Scan for table labels
  const tabEnvRegex = /\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}/g;
  let tabMatch: RegExpExecArray | null;
  while ((tabMatch = tabEnvRegex.exec(tex)) !== null) {
    tabNum++;
    const labelRegex = /\\label\{([^}]+)\}/g;
    let lm: RegExpExecArray | null;
    while ((lm = labelRegex.exec(tabMatch[0])) !== null) {
      labelMap.set(lm[1], String(tabNum));
    }
  }
  // Scan for section labels
  let secNum = 0;
  const secLabelRegex = /\\section\*?\{[^}]+\}\s*\\label\{([^}]+)\}/g;
  let sm: RegExpExecArray | null;
  while ((sm = secLabelRegex.exec(tex)) !== null) {
    secNum++;
    labelMap.set(sm[1], String(secNum));
  }

  // Build citation key→number map from bibliography
  const citationMap = new Map<string, string>();
  const bibMatch2 = tex.match(/\\begin\{thebibliography\}\{[^}]*\}([\s\S]*?)\\end\{thebibliography\}/);
  if (bibMatch2) {
    let citNum = 0;
    const bibItemRegex = /\\bibitem\{([^}]+)\}/g;
    let bm: RegExpExecArray | null;
    while ((bm = bibItemRegex.exec(bibMatch2[1])) !== null) {
      citNum++;
      citationMap.set(bm[1], String(citNum));
    }
  }

  // Store maps in module-level variables for cleanLatexInline to use
  _activeLabelMap = labelMap;
  _activeCitationMap = citationMap;

  // Extract title
  const titleArg = extractLatexCommandArgument(tex, "title");
  const paperTitle = titleArg ? cleanLatexInline(titleArg) : title;
  sections.push({ type: "title", text: paperTitle });

  // Extract author(s) - handle both single-line and multi-line \author{...}
  const authorArg = extractLatexCommandArgument(tex, "author");
  if (authorArg) {
    let authorText = authorArg
      .replace(/\\\\+/g, ", ") // line breaks to commas
      .replace(/\\and/g, ", ") // \and to commas
      .replace(/\\texttt\{[^}]*\}/g, "") // remove email
      .replace(/\\thanks\{[^}]*\}/g, "") // remove \thanks (like footnote)
      .replace(/\\footnote\{[^}]*\}/g, "") // remove footnotes
      .replace(/\\affilimark\{[^}]*\}/g, "") // remove affiliation marks
      .replace(/\\inst\{[^}]*\}/g, "") // remove inst markers
      .replace(/\\textsuperscript\{[^}]*\}/g, "") // remove superscript markers
      .replace(/\\\w+\{([^}]*)\}/g, "$1") // strip remaining commands
      .replace(/[{}]/g, "") // remove stray braces
      .replace(/\s+/g, " ") // collapse whitespace
      .replace(/,\s*,/g, ",") // collapse double commas
      .replace(/^[,\s]+|[,\s]+$/g, "") // trim leading/trailing commas
      .trim();
    if (authorText.length > 0) {
      sections.push({ type: "author", text: authorText });
    }
  }

  sections.push({ type: "conference", text: conference || "" });

  // Extract abstract
  const abstractMatch = tex.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
  if (abstractMatch) {
    sections.push({ type: "abstract", text: cleanLatexInline(abstractMatch[1].trim()) });
  }

  // Extract body — strictly between \begin{document} and \end{document}
  const bodyMatch = tex.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  let body = bodyMatch ? bodyMatch[1] : tex;
  // Ensure we don't process anything after \end{document}
  const endDocIdx = body.indexOf("\\end{document}");
  if (endDocIdx >= 0) body = body.substring(0, endDocIdx);

  // Remove preamble commands
  body = body.replace(/\\maketitle\s*/g, "");
  body = body.replace(/\\title\{[^}]*\}\s*/g, "");
  body = body.replace(/\\author\{[\s\S]*?\}\s*/g, "");
  body = body.replace(/\\date\{[^}]*\}\s*/g, "");

  // Remove abstract environment from body (already extracted above)
  body = body.replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}\s*/g, "");

  // Remove preamble-style commands that may appear in body
  body = body.replace(/\\pretitle\{[\s\S]*?\}\s*/g, "");
  body = body.replace(/\\posttitle\{[\s\S]*?\}\s*/g, "");
  body = body.replace(/\\preauthor\{[\s\S]*?\}\s*/g, "");
  body = body.replace(/\\postauthor\{[\s\S]*?\}\s*/g, "");
  body = body.replace(/\\predate\{[\s\S]*?\}\s*/g, "");
  body = body.replace(/\\postdate\{[\s\S]*?\}\s*/g, "");
  body = body.replace(/\\hypersetup\{[\s\S]*?\}\s*/g, "");
  body = body.replace(/\\sisetup\{[\s\S]*?\}\s*/g, "");

  // Strip LaTeX comments from body (lines starting with % or inline % not escaped)
  body = body.split("\n").map(line => {
    // Remove full-line comments
    if (line.trim().startsWith("%")) return "";
    // Remove inline comments (% not preceded by \)
    return line.replace(/(?<!\\)%.*$/, "");
  }).join("\n");

  // Process display math environments (equation, align, gather, etc.) → markers
  let eqCounter = 0;
  const equationMap = new Map<string, PaperSection>();

  // Named equation environments: equation, align, gather, multline, eqnarray
  body = body.replace(
    /\\begin\{(equation|align|gather|multline|eqnarray)\*?\}([\s\S]*?)\\end\{\1\*?\}/g,
    (_match, _env, content) => {
      eqCounter++;
      const marker = `__EQUATION_${eqCounter}__`;
      // Clean the math content
      let mathContent = content.trim();
      // Remove \label{...}
      mathContent = mathContent.replace(/\\label\{[^}]*\}/g, "");
      // Remove \nonumber and \notag
      mathContent = mathContent.replace(/\\(?:nonumber|notag)/g, "");
      // For align/gather: split by \\ and join with newlines
      const lines = mathContent.split("\\\\").map((l: string) => l.trim()).filter((l: string) => l);
      const converted = lines.map((l: string) => {
        // Remove alignment markers &
        const cleaned = l.replace(/&/g, " ").trim();
        return latexMathToUnicode(cleaned);
      }).join("\n");
      equationMap.set(marker, { type: "equation", text: converted });
      return `\n${marker}\n`;
    }
  );

  // Display math: $$...$$ (must come before inline $ processing)
  body = body.replace(
    /\$\$([\s\S]*?)\$\$/g,
    (_match, content) => {
      eqCounter++;
      const marker = `__EQUATION_${eqCounter}__`;
      const converted = latexMathToUnicode(content.trim());
      equationMap.set(marker, { type: "equation", text: converted });
      return `\n${marker}\n`;
    }
  );

  // \[ ... \] display math
  body = body.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_match, content) => {
      eqCounter++;
      const marker = `__EQUATION_${eqCounter}__`;
      const converted = latexMathToUnicode(content.trim());
      equationMap.set(marker, { type: "equation", text: converted });
      return `\n${marker}\n`;
    }
  );

  // Process figure environments first (extract and replace with markers)
  let figureCounter = 0;
  const figureMap = new Map<string, PaperSection>();
  body = body.replace(
    /\\begin\{figure\*?\}(?:\[([^\]]*)\])?([\s\S]*?)\\end\{figure\*?\}/g,
    (_match, _placement, content) => {
      figureCounter++;
      const marker = `__FIGURE_${figureCounter}__`;

      // Extract includegraphics
      const imgMatch = content.match(/\\includegraphics(?:\[([^\]]*)\])?\{([^}]+)\}/);
      let imageUrl = "";
      let imageFileKey: string | undefined;
      if (imgMatch) {
        const src = imgMatch[2];
        const chart = chartUrlMap.get(src) || chartUrlMap.get(src.replace(/\.[^.]+$/, ""));
        if (chart) {
          imageUrl = chart.url;
          imageFileKey = chart.fileKey;
        }
        else if (src.startsWith("http")) imageUrl = src;
      }

      // Extract caption (balanced braces: captions often contain \textit{...} or maths)
      const captionArg = extractLatexCommandArgument(content, "caption");
      const caption = captionArg ? cleanLatexInline(captionArg) : `Figure ${figureCounter}`;

      figureMap.set(marker, {
        type: "figure",
        imageUrl,
        imageFileKey,
        caption: `Figure ${figureCounter}: ${caption}`,
      });
      return `\n${marker}\n`;
    }
  );

  // Process table environments
  let tableCounter = 0;
  const tableMap = new Map<string, PaperSection>();
  body = body.replace(
    /\\begin\{table\*?\}(?:\[([^\]]*)\])?([\s\S]*?)\\end\{table\*?\}/g,
    (_match, _placement, content) => {
      tableCounter++;
      const marker = `__TABLE_${tableCounter}__`;
      const captionArg = extractLatexCommandArgument(content, "caption");
      const tableCaption = captionArg ? cleanLatexInline(captionArg) : `Table ${tableCounter}`;
      const tabular = extractTabularEnvironment(content);
      const parsed = tabular ? parseTabularContent(tabular.body) : { headers: [], rows: [] };
      tableMap.set(marker, {
        type: "table",
        headers: parsed.headers,
        rows: parsed.rows,
        tableCaption: `Table ${tableCounter}: ${tableCaption}`,
        notes: extractTableNotes(content, tabular),
      });
      return `\n${marker}\n`;
    }
  );

  // Process bibliography
  const bibMatch = body.match(/\\begin\{thebibliography\}\{[^}]*\}([\s\S]*?)\\end\{thebibliography\}/);
  let bibItems: string[] = [];
  if (bibMatch) {
    const bibContent = bibMatch[1];
    body = body.replace(/\\begin\{thebibliography\}\{[^}]*\}[\s\S]*?\\end\{thebibliography\}/, "__BIBLIOGRAPHY__");
    const items = bibContent.split(/\\bibitem(?:\{[^}]*\}|\[[^\]]*\]\{[^}]*\})/);
    bibItems = items.map(item => cleanLatexInline(item.trim())).filter(item => item.length > 0);
  }

  // Now process the body line by line
  const lines = body.split("\n");
  let currentParagraph = "";

  function flushParagraph() {
    const text = cleanLatexInline(currentParagraph.trim());
    if (text.length > 0) {
      sections.push({ type: "paragraph", text });
    }
    currentParagraph = "";
  }

  let inList = false;
  let listItems: string[] = [];
  let listType: "ul" | "ol" = "ul";

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for figure/table markers
    const figMarkerMatch = trimmed.match(/^__FIGURE_(\d+)__$/);
    if (figMarkerMatch) {
      flushParagraph();
      const fig = figureMap.get(trimmed);
      if (fig) sections.push(fig);
      continue;
    }

    const tabMarkerMatch = trimmed.match(/^__TABLE_(\d+)__$/);
    if (tabMarkerMatch) {
      flushParagraph();
      const tab = tableMap.get(trimmed);
      if (tab) sections.push(tab);
      continue;
    }

    // Check for equation markers
    const eqMarkerMatch = trimmed.match(/^__EQUATION_(\d+)__$/);
    if (eqMarkerMatch) {
      flushParagraph();
      const eq = equationMap.get(trimmed);
      if (eq) sections.push(eq);
      continue;
    }

    if (trimmed === "__BIBLIOGRAPHY__") {
      flushParagraph();
      if (bibItems.length > 0) {
        sections.push({ type: "bibliography", items: bibItems });
      }
      continue;
    }

    // Sections
    const sectionMatch = trimmed.match(/\\section\*?\{([^}]+)\}/);
    if (sectionMatch) {
      flushParagraph();
      sections.push({ type: "heading", text: cleanLatexInline(sectionMatch[1]) });
      continue;
    }

    const subsectionMatch = trimmed.match(/\\subsection\*?\{([^}]+)\}/);
    if (subsectionMatch) {
      flushParagraph();
      sections.push({ type: "subheading", text: cleanLatexInline(subsectionMatch[1]) });
      continue;
    }

    const subsubsectionMatch = trimmed.match(/\\subsubsection\*?\{([^}]+)\}/);
    if (subsubsectionMatch) {
      flushParagraph();
      sections.push({ type: "subsubheading", text: cleanLatexInline(subsubsectionMatch[1]) });
      continue;
    }

    // Lists
    if (trimmed === "\\begin{itemize}" || trimmed === "\\begin{enumerate}") {
      flushParagraph();
      inList = true;
      listItems = [];
      listType = trimmed.includes("enumerate") ? "ol" : "ul";
      continue;
    }
    if (trimmed === "\\end{itemize}" || trimmed === "\\end{enumerate}") {
      if (listItems.length > 0) {
        sections.push({ type: "list", items: listItems });
      }
      inList = false;
      listItems = [];
      continue;
    }
    if (inList && trimmed.startsWith("\\item")) {
      listItems.push(cleanLatexInline(trimmed.replace(/^\\item\s*/, "")));
      continue;
    }

    // Skip LaTeX commands
    if (/^\\(?:documentclass|usepackage|geometry|begin\{document\}|end\{document\}|newcommand|renewcommand|setlength|pagestyle|thispagestyle|pretitle|posttitle|preauthor|postauthor|predate|postdate|hypersetup|sisetup|bibliographystyle|bibliography|input|include|graphicspath|DeclareGraphicsExtensions)/.test(trimmed)) {
      continue;
    }
    if (/^\\(?:vspace|hspace|vfill|hfill|newpage|clearpage|pagebreak|noindent|bigskip|medskip|smallskip|centering|raggedright|raggedleft)\b/.test(trimmed)) {
      continue;
    }
    // Skip \begin{center}/\end{center} and similar environments
    if (/^\\(?:begin|end)\{(?:center|flushleft|flushright)\}/.test(trimmed)) {
      continue;
    }
    // Skip standalone \LARGE, \bfseries, etc.
    if (/^\\(?:LARGE|Large|large|bfseries|itshape|normalfont|normalsize|par)\b\s*$/.test(trimmed)) {
      continue;
    }
    // Skip caption* (note: already removed in table processing, but catch stragglers)
    if (/^\\caption\*?\{/.test(trimmed)) {
      continue;
    }

    // Empty line = paragraph break
    if (trimmed === "") {
      flushParagraph();
      continue;
    }

    // Accumulate paragraph text
    currentParagraph += (currentParagraph ? " " : "") + trimmed;
  }
  flushParagraph();

  // Filter out empty sections that would produce blank pages
  const filtered = sections.filter(s => {
    // Keep structural sections (title, conference, author, separator) always
    if (s.type === "title" || s.type === "conference" || s.type === "author" || s.type === "separator") return true;
    // Keep sections with actual content
    if (s.type === "paragraph" || s.type === "abstract" || s.type === "heading" ||
        s.type === "subheading" || s.type === "subsubheading") {
      return (s.text || "").trim().length > 0;
    }
    if (s.type === "list") return (s.items || []).length > 0;
    if (s.type === "bibliography") return (s.items || []).length > 0;
    if (s.type === "table") return (s.headers || []).length > 0;
    if (s.type === "figure") return !!(s.imageUrl || s.caption);
    if (s.type === "equation") return (s.text || "").trim().length > 0;
    return true;
  });

  return filtered;
}

/** Reads a balanced {...} group starting at `index` (which must point at "{"). */
function readBalancedGroup(source: string, index: number): { value: string; end: number } | null {
  if (source[index] !== "{") return null;
  let depth = 0;
  for (let i = index; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { value: source.slice(index + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Locates the tabular / tabularx / tabular* / longtable body, tolerating column
 * specifications with nested braces such as {l p{3cm} c}.
 */
function extractTabularEnvironment(content: string): { body: string; start: number; end: number } | null {
  const begin = /\\begin\{(tabularx|tabular\*|tabular|longtable)\}/.exec(content);
  if (!begin) return null;
  const env = begin[1];
  let cursor = begin.index + begin[0].length;
  const skipSpaces = () => { while (/\s/.test(content[cursor] || "")) cursor++; };
  skipSpaces();
  if (content[cursor] === "[") {
    const close = content.indexOf("]", cursor);
    if (close > 0) cursor = close + 1;
    skipSpaces();
  }
  // tabularx / tabular* take a width argument before the column spec.
  const groups = env === "tabularx" || env === "tabular*" ? 2 : 1;
  for (let g = 0; g < groups; g++) {
    skipSpaces();
    const group = readBalancedGroup(content, cursor);
    if (!group) break;
    cursor = group.end;
  }
  const endToken = `\\end{${env}}`;
  const endIndex = content.indexOf(endToken, cursor);
  if (endIndex < 0) return null;
  return { body: content.slice(cursor, endIndex), start: begin.index, end: endIndex + endToken.length };
}

/** Free text after the tabular (e.g. "Notes: ..." or a tablenotes environment). */
function extractTableNotes(content: string, tabular: { end: number } | null): string | undefined {
  const tail = tabular ? content.slice(tabular.end) : "";
  const notesEnv = content.match(/\\begin\{tablenotes\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{tablenotes\}/);
  let raw = notesEnv ? notesEnv[1].replace(/\\item(?:\[[^\]]*\])?/g, " ") : tail;
  raw = raw
    .replace(/\\end\{(?:adjustbox|center|threeparttable|minipage)\}/g, " ")
    .replace(/\\label\{[^}]*\}/g, " ")
    .replace(/\\caption\*?\{[^}]*\}/g, " ")
    .replace(/^\s*\}+/, " ");
  const cleaned = cleanLatexInline(raw).replace(/^[\s}]+/, "").replace(/^Notes?\s*[:.]\s*/i, "").trim();
  return cleaned.length > 2 ? cleaned : undefined;
}

/** Splits a tabular row on unescaped "&". */
function splitTabularCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "\\" && i + 1 < row.length) { current += ch + row[i + 1]; i++; continue; }
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "&" && depth === 0) { cells.push(current); current = ""; continue; }
    current += ch;
  }
  cells.push(current);
  return cells;
}

/** Splits tabular content into rows on "\\" outside braces. */
function splitTabularRows(content: string): string[] {
  const rows: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\\" && content[i + 1] === "\\" && depth === 0) {
      rows.push(current);
      current = "";
      i++;
      // skip optional spacing argument such as \\[2pt]
      const rest = content.slice(i + 1);
      const spacing = rest.match(/^\s*\[[^\]]*\]/);
      if (spacing) i += spacing[0].length;
      continue;
    }
    if (ch === "\\" && i + 1 < content.length) { current += ch + content[i + 1]; i++; continue; }
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    current += ch;
  }
  if (current.trim()) rows.push(current);
  return rows;
}

function parseTabularContent(content: string): { headers: string[]; rows: string[][] } {
  const rawRows = splitTabularRows(content);
  const headers: string[] = [];
  const rows: string[][] = [];

  for (let i = 0; i < rawRows.length; i++) {
    let row = rawRows[i];
    // Remove rule and spacing commands
    row = row.replace(/\\(?:hline|toprule|midrule|bottomrule|addlinespace|endhead|endfirsthead|endfoot|endlastfoot)(?:\[[^\]]*\])?\s*/g, "");
    row = row.replace(/\\(?:cline|cmidrule)(?:\([^)]*\))?\{[^}]*\}\s*/g, "");
    row = row.replace(/\\rowcolor(?:\[[^\]]*\])?\{[^}]*\}\s*/g, "");
    row = row.trim();
    if (!row) continue;

    const cells: string[] = [];
    for (const rawCell of splitTabularCells(row)) {
      const multi = rawCell.trim().match(/^\\multicolumn\{(\d+)\}\{[^}]*\}\{([\s\S]*)\}$/);
      const span = multi ? Math.max(1, Number(multi[1])) : 1;
      let cell = cleanLatexInline((multi ? multi[2] : rawCell).trim());
      // Format very large/small numbers to scientific notation to prevent overflow
      cell = cell.replace(/(-?\d+\.\d{4,}(?:e[+-]?\d+)?)/gi, (match) => {
        const n = parseFloat(match);
        if (!isFinite(n)) return match;
        if (Math.abs(n) >= 1e6 || (Math.abs(n) < 0.001 && Math.abs(n) > 0)) {
          return n.toExponential(3);
        }
        if (match.length > 10) {
          return n.toPrecision(6);
        }
        return match;
      });
      cells.push(cell);
      for (let k = 1; k < span; k++) cells.push("");
    }
    if (headers.length === 0) {
      headers.push(...cells);
    } else {
      rows.push(cells);
    }
  }
  const width = Math.max(headers.length, ...rows.map(r => r.length), 0);
  while (headers.length < width) headers.push("");
  return { headers, rows: rows.map(r => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r)) };
}

/* ------------------------------------------------------------------ */
/*  LaTeX Math → Unicode converter                                     */
/* ------------------------------------------------------------------ */

/**
 * Convert LaTeX math expressions to readable Unicode text.
 * Handles Greek letters, operators, fractions, subscripts, superscripts, etc.
 */
/**
 * Convert LaTeX math to ASCII-safe readable text for PDFKit rendering.
 * Outputs only characters in the Basic Latin + Latin-1 Supplement range
 * that PDFKit's built-in fonts (Times-Roman, Courier) can render.
 * No Unicode Greek, no combining marks, no exotic symbols.
 */
export function latexMathToUnicode(math: string): string {
  let m = math.trim();

  // --- Greek letters → ASCII names ---
  const greekMap: Record<string, string> = {
    "\\alpha": "alpha", "\\beta": "beta", "\\gamma": "gamma", "\\delta": "delta",
    "\\epsilon": "epsilon", "\\varepsilon": "epsilon", "\\zeta": "zeta", "\\eta": "eta",
    "\\theta": "theta", "\\vartheta": "theta", "\\iota": "iota", "\\kappa": "kappa",
    "\\lambda": "lambda", "\\mu": "mu", "\\nu": "nu", "\\xi": "xi",
    "\\pi": "pi", "\\varpi": "pi", "\\rho": "rho", "\\varrho": "rho",
    "\\sigma": "sigma", "\\varsigma": "sigma", "\\tau": "tau", "\\upsilon": "upsilon",
    "\\phi": "phi", "\\varphi": "phi", "\\chi": "chi", "\\psi": "psi",
    "\\omega": "omega",
    "\\Gamma": "Gamma", "\\Delta": "Delta", "\\Theta": "Theta", "\\Lambda": "Lambda",
    "\\Xi": "Xi", "\\Pi": "Pi", "\\Sigma": "Sigma", "\\Upsilon": "Upsilon",
    "\\Phi": "Phi", "\\Psi": "Psi", "\\Omega": "Omega",
  };
  for (const [cmd, ch] of Object.entries(greekMap)) {
    m = m.replace(new RegExp(cmd.replace(/\\/g, "\\\\") + "(?![a-zA-Z])", "g"), ch);
  }

  // --- Math operators & symbols → ASCII ---
  const symbolMap: Record<string, string> = {
    "\\times": "*", "\\cdot": "*", "\\div": "/",
    "\\pm": "+/-", "\\mp": "-/+",
    "\\leq": "<=", "\\le": "<=", "\\geq": ">=", "\\ge": ">=",
    "\\neq": "!=", "\\ne": "!=",
    "\\approx": "~=", "\\sim": "~", "\\simeq": "~=",
    "\\equiv": "===", "\\propto": "proportional to",
    "\\infty": "inf", "\\partial": "d", "\\nabla": "grad",
    "\\forall": "for all", "\\exists": "exists", "\\nexists": "not exists",
    "\\in": "in", "\\notin": "not in", "\\subset": "subset", "\\supset": "superset",
    "\\subseteq": "subset=", "\\supseteq": "superset=",
    "\\cup": "union", "\\cap": "intersect", "\\emptyset": "{}",
    "\\to": "->", "\\rightarrow": "->", "\\leftarrow": "<-",
    "\\Rightarrow": "=>", "\\Leftarrow": "<=", "\\Leftrightarrow": "<=>",
    "\\mapsto": "|->",
    "\\ldots": "...", "\\cdots": "...", "\\vdots": "...", "\\ddots": "...",
    "\\langle": "<", "\\rangle": ">",
    "\\lceil": "[", "\\rceil": "]", "\\lfloor": "[", "\\rfloor": "]",
    "\\neg": "not", "\\land": "and", "\\lor": "or",
    "\\circ": "o", "\\bullet": "*", "\\star": "*",
    "\\dagger": "+", "\\ddagger": "++",
    "\\ell": "l", "\\hbar": "h", "\\Re": "Re", "\\Im": "Im",
    "\\aleph": "aleph",
    "\\prime": "'",
  };
  for (const [cmd, ch] of Object.entries(symbolMap)) {
    m = m.replace(new RegExp(cmd.replace(/\\/g, "\\\\") + "(?![a-zA-Z])", "g"), ch);
  }

  // --- Big operators → ASCII with sub/superscripts ---
  m = m.replace(/\\sum(?:_\{([^}]*)\})?(?:\^\{([^}]*)\})?/g, (_match, sub, sup) => {
    let s = "SUM";
    if (sub && sup) s += `(${latexMathToUnicode(sub)}..${latexMathToUnicode(sup)})`;
    else if (sub) s += `_(${latexMathToUnicode(sub)})`;
    return s;
  });
  m = m.replace(/\\prod(?:_\{([^}]*)\})?(?:\^\{([^}]*)\})?/g, (_match, sub, sup) => {
    let s = "PROD";
    if (sub && sup) s += `(${latexMathToUnicode(sub)}..${latexMathToUnicode(sup)})`;
    else if (sub) s += `_(${latexMathToUnicode(sub)})`;
    return s;
  });
  m = m.replace(/\\int(?:_\{([^}]*)\})?(?:\^\{([^}]*)\})?/g, (_match, sub, sup) => {
    let s = "INT";
    if (sub && sup) s += `(${latexMathToUnicode(sub)}..${latexMathToUnicode(sup)})`;
    else if (sub) s += `_(${latexMathToUnicode(sub)})`;
    return s;
  });
  const bigOpNames = ["lim", "max", "min", "sup", "inf"];
  for (const op of bigOpNames) {
    m = m.replace(new RegExp(`\\\\${op}(?:_\\{([^}]*)\\})?`, "g"), (_match: string, sub: string) => {
      let s = op;
      if (sub) s += `_(${latexMathToUnicode(sub)})`;
      return s;
    });
  }

  // --- Fractions: \frac{a}{b} → (a)/(b) ---
  m = m.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, (_match, num, den) => {
    const n = latexMathToUnicode(num);
    const d = latexMathToUnicode(den);
    if (n.length <= 2 && d.length <= 2) return `${n}/${d}`;
    return `(${n})/(${d})`;
  });

  // --- Square root: \sqrt{x} → sqrt(x) ---
  m = m.replace(/\\sqrt\[([^\]]*)\]\{([^}]*)\}/g, (_match, n, content) => {
    return `root(${latexMathToUnicode(n)}, ${latexMathToUnicode(content)})`;
  });
  m = m.replace(/\\sqrt\{([^}]*)\}/g, (_match, content) => {
    return `sqrt(${latexMathToUnicode(content)})`;
  });

  // --- Overline/hat/bar/tilde → ASCII notation ---
  m = m.replace(/\\(?:overline|bar)\{([^}]*)\}/g, (_match, content) => `bar(${latexMathToUnicode(content)})`);
  m = m.replace(/\\hat\{([^}]*)\}/g, (_match, content) => `hat(${latexMathToUnicode(content)})`);
  m = m.replace(/\\tilde\{([^}]*)\}/g, (_match, content) => `tilde(${latexMathToUnicode(content)})`);
  m = m.replace(/\\dot\{([^}]*)\}/g, (_match, content) => `${latexMathToUnicode(content)}'`);
  m = m.replace(/\\ddot\{([^}]*)\}/g, (_match, content) => `${latexMathToUnicode(content)}''`);
  m = m.replace(/\\vec\{([^}]*)\}/g, (_match, content) => `vec(${latexMathToUnicode(content)})`);

  // --- Subscripts: _{...} → _(...) ---
  m = m.replace(/_\{([^}]*)\}/g, (_match, content) => `_(${latexMathToUnicode(content)})`);
  // Single char subscript: _x stays as _x
  m = m.replace(/_([a-zA-Z0-9])/g, "_$1");

  // --- Superscripts: ^{...} → ^(...) ---
  m = m.replace(/\^\{([^}]*)\}/g, (_match, content) => `^(${latexMathToUnicode(content)})`);
  // Single char superscript: ^x stays as ^x
  m = m.replace(/\^([a-zA-Z0-9])/g, "^$1");

  // --- Math functions ---
  const funcNames = ["sin", "cos", "tan", "log", "ln", "exp", "det", "dim", "ker", "deg",
    "arg", "gcd", "hom", "Pr", "sec", "csc", "cot", "sinh", "cosh", "tanh"];
  for (const fn of funcNames) {
    m = m.replace(new RegExp(`\\\\${fn}(?![a-zA-Z])`, "g"), fn);
  }

  // --- Text commands inside math ---
  m = m.replace(/\\(?:text|mathrm|textrm|mathit|textit|mathbf|textbf|mathsf|textsf|mathtt|texttt|operatorname|operatorname\*)\{([^}]*)\}/g, "$1");
  m = m.replace(/\\(?:boldsymbol|bm)\{([^}]*)\}/g, "$1");

  // --- Spacing commands ---
  m = m.replace(/\\(?:quad|qquad)/g, "  ");
  m = m.replace(/\\[,;:!]/g, " ");
  m = m.replace(/\\(?:hspace|mspace)\{[^}]*\}/g, " ");

  // --- Delimiters ---
  m = m.replace(/\\(?:left|right|big|Big|bigg|Bigg)\s*/g, "");
  m = m.replace(/\\\{/g, "{");
  m = m.replace(/\\\}/g, "}");
  m = m.replace(/\\\|/g, "||");

  // --- Matrix environments → bracket notation ---
  m = m.replace(/\\begin\{(?:pmatrix|bmatrix|vmatrix|Vmatrix|matrix|Bmatrix)\}([\s\S]*?)\\end\{(?:pmatrix|bmatrix|vmatrix|Vmatrix|matrix|Bmatrix)\}/g, (_match, content) => {
    const rows = content.split("\\\\").map((r: string) => r.trim()).filter((r: string) => r);
    const formatted = rows.map((r: string) => r.split("&").map((c: string) => latexMathToUnicode(c.trim())).join(", ")).join("; ");
    return `[${formatted}]`;
  });

  // --- Cases environment ---
  m = m.replace(/\\begin\{cases\}([\s\S]*?)\\end\{cases\}/g, (_match, content) => {
    const rows = content.split("\\\\").map((r: string) => r.trim()).filter((r: string) => r);
    return "{ " + rows.map((r: string) => {
      const parts = r.split("&").map((c: string) => latexMathToUnicode(c.trim()));
      return parts.join(", if ");
    }).join(" | ") + " }";
  });

  // --- Cleanup remaining LaTeX commands ---
  m = m.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1");
  m = m.replace(/\\[a-zA-Z]+/g, "");
  m = m.replace(/[{}]/g, "");
  m = m.replace(/\s+/g, " ").trim();

  return m;
}

/**
 * Sanitize ANY text for PDFKit rendering with built-in fonts (Times-Roman, Courier).
 * Built-in fonts only support Basic Latin (U+0020–U+007E) and Latin-1 Supplement (U+00A0–U+00FF).
 * Any character outside these ranges will be invisible but PDFKit still allocates layout space,
 * causing blank pages when non-Latin text (e.g. Japanese/Chinese) is present.
 */
function sanitizeForPdf(text: string | undefined | null): string {
  if (!text) return "";
  if (typeof text !== "string") text = String(text);
  let safe = text.replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "");
  // Collapse runs of spaces (but keep newlines)
  safe = safe.replace(/[^\S\n]+/g, " ");
  // Remove lines that became empty after stripping
  safe = safe.replace(/^\s+$/gm, "");
  // Collapse multiple blank lines
  safe = safe.replace(/\n{3,}/g, "\n\n");
  return safe.trim();
}

/**
 * Sanitize math text for PDFKit rendering.
 * Since latexMathToUnicode now outputs ASCII-safe text, this only needs
 * to handle edge cases where non-ASCII characters slip through.
 */
function sanitizePdfMathText(text: string): string {
  return sanitizeForPdf(text);
}

/**
 * Convert text to Unicode superscript characters where possible.
 */
function toSuperscript(text: string): string {
  const supMap: Record<string, string> = {
    "0": "\u2070", "1": "\u00B9", "2": "\u00B2", "3": "\u00B3",
    "4": "\u2074", "5": "\u2075", "6": "\u2076", "7": "\u2077",
    "8": "\u2078", "9": "\u2079",
    "+": "\u207A", "-": "\u207B", "=": "\u207C",
    "(": "\u207D", ")": "\u207E",
    "n": "\u207F", "i": "\u2071",
    "a": "\u1D43", "b": "\u1D47", "c": "\u1D9C", "d": "\u1D48",
    "e": "\u1D49", "f": "\u1DA0", "g": "\u1D4D", "h": "\u02B0",
    "j": "\u02B2", "k": "\u1D4F", "l": "\u02E1", "m": "\u1D50",
    "o": "\u1D52", "p": "\u1D56", "r": "\u02B3", "s": "\u02E2",
    "t": "\u1D57", "u": "\u1D58", "v": "\u1D5B", "w": "\u02B7",
    "x": "\u02E3", "y": "\u02B8", "z": "\u1DBB",
    "T": "\u1D40",
    "*": "\u204E",
  };
  return Array.from(text).map(ch => supMap[ch] || ch).join("");
}

/**
 * Convert text to Unicode subscript characters where possible.
 */
function toSubscript(text: string): string {
  const subMap: Record<string, string> = {
    "0": "\u2080", "1": "\u2081", "2": "\u2082", "3": "\u2083",
    "4": "\u2084", "5": "\u2085", "6": "\u2086", "7": "\u2087",
    "8": "\u2088", "9": "\u2089",
    "+": "\u208A", "-": "\u208B", "=": "\u208C",
    "(": "\u208D", ")": "\u208E",
    "a": "\u2090", "e": "\u2091", "h": "\u2095",
    "i": "\u1D62", "j": "\u2C7C", "k": "\u2096", "l": "\u2097",
    "m": "\u2098", "n": "\u2099", "o": "\u2092", "p": "\u209A",
    "r": "\u1D63", "s": "\u209B", "t": "\u209C", "u": "\u1D64",
    "v": "\u1D65", "x": "\u2093",
  };
  return Array.from(text).map(ch => subMap[ch] || ch).join("");
}

// Module-level maps populated by parseLatexToSections for use in cleanLatexInline
let _activeLabelMap: Map<string, string> = new Map();
let _activeCitationMap: Map<string, string> = new Map();

function cleanLatexInline(text: string): string {
  let result = text;

  // Strip LaTeX comments: lines starting with % and inline % (not escaped \%)
  result = result.replace(/^%.*$/gm, "");
  result = result.replace(/(?<!\\)%.*$/gm, "");

  // Remove \resizebox, \adjustbox wrappers (handle nested braces)
  result = result.replace(/\\resizebox\{[^}]*\}\{[^}]*\}\{/g, "");
  result = result.replace(/\\adjustbox\{[^}]*\}\{/g, "");

  // Remove environment markers that might leak through
  result = result.replace(/\\begin\{(?:abstract|center|flushleft|flushright|quote|quotation|verse|minipage|adjustbox)\}(?:\{[^}]*\})?/g, "");
  result = result.replace(/\\end\{(?:abstract|center|flushleft|flushright|quote|quotation|verse|minipage|adjustbox)\}/g, "");

  // Text formatting - extract content from braces
  result = result.replace(/\\textbf\{([^}]+)\}/g, "$1");
  result = result.replace(/\\textit\{([^}]+)\}/g, "$1");
  result = result.replace(/\\emph\{([^}]+)\}/g, "$1");
  result = result.replace(/\\texttt\{([^}]+)\}/g, "$1");
  result = result.replace(/\\underline\{([^}]+)\}/g, "$1");
  result = result.replace(/\\textsc\{([^}]+)\}/g, "$1");
  result = result.replace(/\\textrm\{([^}]+)\}/g, "$1");
  result = result.replace(/\\textsf\{([^}]+)\}/g, "$1");
  result = result.replace(/\\mbox\{([^}]+)\}/g, "$1");
  result = result.replace(/\\text\{([^}]+)\}/g, "$1");
  result = result.replace(/\\mathrm\{([^}]+)\}/g, "$1");
  result = result.replace(/\\mathbf\{([^}]+)\}/g, "$1");
  result = result.replace(/\\mathit\{([^}]+)\}/g, "$1");
  result = result.replace(/\\boldsymbol\{([^}]+)\}/g, "$1");

  // Citations: resolve \cite{refN} → [N] using citation map, or extract number from key
  result = result.replace(/\\cite(?:p|t|author|year)?\{([^}]+)\}/g, (_m: string, keys: string) => {
    const resolved = keys.split(/\s*,\s*/).map(key => {
      const k = key.trim();
      // Use citation map first
      if (_activeCitationMap.has(k)) return _activeCitationMap.get(k)!;
      // Fallback: extract number from refN pattern
      const numMatch = k.match(/(\d+)/);
      return numMatch ? numMatch[1] : k;
    });
    return `[${resolved.join(", ")}]`;
  });

  // Resolve \ref{} to numbered references using label map
  const resolveRef = (fullLabel: string, prefix: string): string => {
    // Try label map first (populated from LaTeX source)
    if (_activeLabelMap.has(fullLabel)) {
      return `${prefix}${_activeLabelMap.get(fullLabel)!}`;
    }
    // Fallback: extract number from label name
    const numMatch = fullLabel.match(/(\d+)/);
    if (numMatch) return `${prefix}${numMatch[1]}`;
    // Last resort: return just the number placeholder
    return prefix.trim();
  };
  result = result.replace(/\\ref\{(fig:[^}]+)\}/g, (_m, label) => resolveRef(label, ""));
  result = result.replace(/\\ref\{(tab:[^}]+)\}/g, (_m: string, label: string) => resolveRef(label, ""));
  result = result.replace(/\\ref\{(sec:[^}]+)\}/g, (_m: string, label: string) => {
    if (_activeLabelMap.has(label)) return _activeLabelMap.get(label)!;
    const cleanLabel = label.replace(/^sec:/, "").replace(/_/g, " ");
    return cleanLabel.replace(/^\w/, (c: string) => c.toUpperCase());
  });
  result = result.replace(/\\ref\{([^}]+)\}/g, (_m: string, label: string) => {
    if (_activeLabelMap.has(label)) return _activeLabelMap.get(label)!;
    const numMatch = label.match(/(\d+)/);
    if (numMatch) return numMatch[1];
    return label.replace(/_/g, " ");
  });
  result = result.replace(/\\eqref\{([^}]+)\}/g, (_m: string, label: string) => {
    if (_activeLabelMap.has(label)) return `(${_activeLabelMap.get(label)!})`;
    return "(Eq.)";
  });
  result = result.replace(/\\autoref\{([^}]+)\}/g, (_m: string, label: string) => {
    if (_activeLabelMap.has(label)) {
      const num = _activeLabelMap.get(label)!;
      if (label.startsWith("fig:")) return `Figure ${num}`;
      if (label.startsWith("tab:")) return `Table ${num}`;
      return num;
    }
    if (label.startsWith("fig:")) return `Figure ${(label.match(/(\d+)/) || [""])[0] || ""}`.trim();
    if (label.startsWith("tab:")) return `Table ${(label.match(/(\d+)/) || [""])[0] || ""}`.trim();
    if (label.startsWith("sec:")) return label.replace(/^sec:/, "").replace(/_/g, " ");
    return label.replace(/_/g, " ");
  });
  result = result.replace(/\\url\{([^}]+)\}/g, "$1");
  result = result.replace(/\\href\{[^}]*\}\{([^}]+)\}/g, "$1");

  // Math: inline $...$ → convert to Unicode math
  result = result.replace(/\$([^$]+)\$/g, (_m, math) => latexMathToUnicode(math));

  // Unescaped ~ is a LaTeX non-breaking space (Table~1)
  result = result.replace(/(?<!\\)~/g, " ");

  // Escaped special characters
  result = result.replace(/\\\$/g, "$");
  result = result.replace(/\\%/g, "%");
  result = result.replace(/\\&/g, "&");
  result = result.replace(/\\_/g, "_");
  result = result.replace(/\\#/g, "#");
  result = result.replace(/\\~/g, "~");
  result = result.replace(/\\\{/g, "{");
  result = result.replace(/\\\}/g, "}");

  // Remove size commands
  result = result.replace(/\\(?:footnotesize|scriptsize|tiny|small|normalsize|large|Large|LARGE|huge|Huge|bfseries|itshape|normalfont|rmfamily|sffamily|ttfamily)\b\s*/g, "");

  // Remove various commands with arguments
  result = result.replace(/\\thanks\{[^}]*\}/g, ""); // \thanks (footnote-like)
  result = result.replace(/\\footnote\{[^}]*\}/g, "");
  result = result.replace(/\\label\{[^}]*\}/g, "");
  result = result.replace(/\\caption\*?\{[^}]*\}/g, "");
  result = result.replace(/\\includegraphics(?:\[[^\]]*\])?\{[^}]*\}/g, "[Figure]");
  result = result.replace(/\\sisetup\{[^}]*\}/g, "");
  result = result.replace(/\\hypersetup\{[^}]*\}/g, "");
  result = result.replace(/\\color\{[^}]*\}/g, "");
  result = result.replace(/\\colorbox\{[^}]*\}\{([^}]+)\}/g, "$1");
  result = result.replace(/\\fcolorbox\{[^}]*\}\{[^}]*\}\{([^}]+)\}/g, "$1");

  // Remove spacing commands
  result = result.replace(/\\(?:hspace|vspace)\*?\{[^}]*\}/g, "");
  result = result.replace(/\\(?:quad|qquad|enspace|thinspace|negthinspace|,|;|!)/g, " ");

  // Remove \noindent, \par, etc.
  result = result.replace(/\\(?:noindent|par|centering|raggedright|raggedleft)\b\s*/g, "");

  // Line breaks
  result = result.replace(/\\\\/g, " ");
  result = result.replace(/\\newline\b/g, " ");

  // Remove any remaining \command{} patterns (catch-all for unknown commands)
  // Only remove if the command is a simple word (no nested braces)
  result = result.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, "$1");

  // Remove any remaining \command without arguments
  result = result.replace(/\\[a-zA-Z]+\b/g, "");

  // Clean up orphaned braces
  result = result.replace(/[{}]/g, "");

  // Clean up extra whitespace
  result = result.replace(/\s+/g, " ").trim();
  return result;
}

function parseMarkdownToSections(
  markdownContent: string,
  title: string,
  conference: string,
  chartImages: ChartImage[] = []
): PaperSection[] {
  const sections: PaperSection[] = [];
  sections.push({ type: "title", text: title });
  sections.push({ type: "conference", text: conference || "" });

  const lines = markdownContent.split("\n");
  let currentParagraph = "";
  let inAbstract = false;

  function flushParagraph() {
    const text = currentParagraph.trim();
    if (text.length > 0) {
      if (inAbstract) {
        sections.push({ type: "abstract", text });
        inAbstract = false;
      } else {
        sections.push({ type: "paragraph", text });
      }
    }
    currentParagraph = "";
  }

  let pendingTableCaption: string | undefined;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const trimmed = line.trim();

    // "**Table 2.** Title" line introducing a Markdown table
    const tableTitle = trimmed.match(/^\*\*(Table\s+\d+)\.?\*\*\s*(.*)$/i);
    if (tableTitle && lines.slice(lineIndex + 1, lineIndex + 4).some(l => l.trim().startsWith("|"))) {
      flushParagraph();
      pendingTableCaption = `${tableTitle[1]}: ${tableTitle[2]}`;
      continue;
    }
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushParagraph();
      const block: string[] = [];
      while (lineIndex < lines.length && lines[lineIndex].trim().startsWith("|")) {
        block.push(lines[lineIndex].trim());
        lineIndex++;
      }
      lineIndex--;
      const parseRow = (row: string) => row.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, "|").trim());
      const dataRows = block.filter(row => !/^\|?\s*:?-{2,}/.test(row.replace(/^\|/, "").trim()));
      if (dataRows.length > 0) {
        let notes: string | undefined;
        const next = lines[lineIndex + 1]?.trim() === "" ? lines[lineIndex + 2]?.trim() : lines[lineIndex + 1]?.trim();
        if (next && /^\*Notes?:\*/i.test(next)) notes = next.replace(/^\*Notes?:\*\s*/i, "");
        sections.push({
          type: "table",
          headers: parseRow(dataRows[0]),
          rows: dataRows.slice(1).map(parseRow),
          tableCaption: pendingTableCaption,
          notes,
        });
      }
      pendingTableCaption = undefined;
      continue;
    }
    if (/^\*Notes?:\*/i.test(trimmed)) {
      // already attached to the preceding table
      continue;
    }

    if (trimmed.startsWith("# ")) {
      flushParagraph();
      sections.push({ type: "heading", text: trimmed.slice(2) });
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushParagraph();
      const heading = trimmed.slice(3);
      if (/abstract/i.test(heading)) {
        inAbstract = true;
      } else {
        sections.push({ type: "heading", text: heading });
      }
      continue;
    }
    if (trimmed.startsWith("### ")) {
      flushParagraph();
      sections.push({ type: "subheading", text: trimmed.slice(4) });
      continue;
    }
    if (trimmed.startsWith("#### ")) {
      flushParagraph();
      sections.push({ type: "subsubheading", text: trimmed.slice(5) });
      continue;
    }
    if (trimmed === "---") {
      flushParagraph();
      sections.push({ type: "separator" });
      continue;
    }
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      flushParagraph();
      // Collect list items
      const items: string[] = [trimmed.slice(2)];
      // Note: this only captures the current line; multi-line lists are handled by subsequent iterations
      sections.push({ type: "list", items });
      continue;
    }
    if (trimmed === "") {
      flushParagraph();
      continue;
    }
    currentParagraph += (currentParagraph ? " " : "") + trimmed;
  }
  flushParagraph();

  // Append chart images as figures
  if (chartImages.length > 0) {
    sections.push({ type: "heading", text: "Figures" });
    chartImages.forEach((chart, i) => {
      sections.push({
        type: "figure",
        imageUrl: chart.url,
        imageFileKey: chart.fileKey,
        caption: `Figure ${i + 1}: ${chart.name} — ${chart.description}`,
      });
    });
  }

  return sections;
}

/* ------------------------------------------------------------------ */
/*  PDFKit renderer                                                    */
/* ------------------------------------------------------------------ */

// A4 dimensions in points (72 points per inch)
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_TOP = 72;
const MARGIN_BOTTOM = 84;
const MARGIN_LEFT = 56;
const MARGIN_RIGHT = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
// Footers sit below the text block; the bottom margin is lifted while drawing them so
// PDFKit never creates an implicit page, and body text can no longer run into them.
const PAGE_NUMBER_Y = PAGE_HEIGHT - 52;
const FOOTER_NOTE_Y = PAGE_HEIGHT - 40;

async function renderSectionsToPdf(
  sections: PaperSection[],
  conference: string
): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: {
          top: MARGIN_TOP,
          bottom: MARGIN_BOTTOM,
          left: MARGIN_LEFT,
          right: MARGIN_RIGHT,
        },
        info: {
          Title: sections.find(s => s.type === "title")?.text || "Research Paper",
          Author: "Auto Research",
          Creator: "Auto Research Pipeline",
        },
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      const imageBufferCache = new Map<string, Promise<Buffer | null>>();
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Register fonts (use built-in fonts)
      const FONT_SERIF = "Times-Roman";
      const FONT_SERIF_BOLD = "Times-Bold";
      const FONT_SERIF_ITALIC = "Times-Italic";
      const FONT_MONO = "Courier";

      // Helper: check if we need a new page
      const ensureSpace = (needed: number) => {
        const available = PAGE_HEIGHT - MARGIN_BOTTOM - doc.y;
        // Only add a new page if the needed space exceeds what's available
        // AND we've actually used some space on the current page (prevent empty pages)
        if (needed > available && doc.y > MARGIN_TOP + 20) {
          doc.addPage();
        }
      };

      const isNumericCell = (text: string) => /^[\s([]*[-+]?(\d[\d,]*\.?\d*(e[-+]?\d+)?|\.\d+)%?\**[)\]]*\s*$/i.test(text.trim()) || /^\[[-+\d.,e\s]+\]$/i.test(text.trim());

      /**
       * Booktabs-style table with column widths measured from the content. Long cells wrap
       * inside their column instead of being truncated, numeric columns are right-aligned,
       * the font shrinks for wide tables, and the header repeats after page breaks.
       */
      const renderTable = (section: PaperSection) => {
        const headers = (section.headers || []).map(h => sanitizeForPdf(h));
        const rows = (section.rows || []).map(row => headers.map((_, i) => sanitizeForPdf(row[i] || "")));
        const columnCount = headers.length;
        if (columnCount === 0) return;
        const cellPadX = 4;
        const cellPadY = 2.5;
        const numericColumn = headers.map((_, col) => {
          const values = rows.map(r => r[col]).filter(v => v.trim() !== "");
          return col > 0 && values.length > 0 && values.filter(isNumericCell).length / values.length >= 0.6;
        });

        const measure = (fontSize: number) => {
          const natural: number[] = [];
          const minimum: number[] = [];
          for (let col = 0; col < columnCount; col++) {
            doc.font(FONT_SERIF_BOLD).fontSize(fontSize);
            let widest = doc.widthOfString(headers[col] || " ");
            let longestWord = Math.max(...(headers[col] || " ").split(/\s+/).map(w => doc.widthOfString(w || " ")));
            doc.font(FONT_SERIF).fontSize(fontSize);
            for (const row of rows) {
              const text = row[col] || "";
              widest = Math.max(widest, doc.widthOfString(text));
              longestWord = Math.max(longestWord, ...text.split(/\s+/).map(w => doc.widthOfString(w || " ")));
            }
            natural.push(widest + cellPadX * 2);
            minimum.push(Math.min(widest, Math.max(longestWord, 24)) + cellPadX * 2);
          }
          return { natural, minimum };
        };

        let fontSize = columnCount <= 4 ? 9 : columnCount <= 6 ? 8.5 : columnCount <= 9 ? 7.5 : 6.5;
        let { natural, minimum } = measure(fontSize);
        while (natural.reduce((a, b) => a + b, 0) > CONTENT_WIDTH && fontSize > 6.5) {
          fontSize = Math.max(6.5, fontSize - 0.5);
          ({ natural, minimum } = measure(fontSize));
        }
        let widths = natural.slice();
        const totalNatural = natural.reduce((a, b) => a + b, 0);
        if (totalNatural > CONTENT_WIDTH) {
          // Give every column its minimum, then share the remaining width in proportion to
          // how much each column would still like to grow.
          const minTotal = minimum.reduce((a, b) => a + b, 0);
          if (minTotal >= CONTENT_WIDTH) {
            widths = minimum.map(w => (w / minTotal) * CONTENT_WIDTH);
          } else {
            const spare = CONTENT_WIDTH - minTotal;
            const wants = natural.map((w, i) => Math.max(0, w - minimum[i]));
            const wantTotal = wants.reduce((a, b) => a + b, 0) || 1;
            widths = minimum.map((w, i) => w + (wants[i] / wantTotal) * spare);
          }
        }
        const tableWidth = widths.reduce((a, b) => a + b, 0);
        const tableX = MARGIN_LEFT + Math.max(0, (CONTENT_WIDTH - tableWidth) / 2);
        const columnX = widths.map((_, i) => tableX + widths.slice(0, i).reduce((a, b) => a + b, 0));

        const rowHeight = (cells: string[], bold: boolean) => {
          doc.font(bold ? FONT_SERIF_BOLD : FONT_SERIF).fontSize(fontSize);
          return Math.max(...cells.map((text, i) => doc.heightOfString(text || " ", { width: Math.max(8, widths[i] - cellPadX * 2), lineGap: 0.5 }))) + cellPadY * 2;
        };
        const drawRow = (cells: string[], y: number, bold: boolean) => {
          doc.font(bold ? FONT_SERIF_BOLD : FONT_SERIF).fontSize(fontSize).fillColor("#000000");
          cells.forEach((text, i) => {
            doc.text(text, columnX[i] + cellPadX, y + cellPadY, {
              width: Math.max(8, widths[i] - cellPadX * 2),
              align: numericColumn[i] ? "right" : "left",
              lineGap: 0.5,
            });
          });
        };
        const rule = (y: number, weight: number) => {
          doc.moveTo(tableX, y).lineTo(tableX + tableWidth, y).strokeColor("#000000").lineWidth(weight).stroke();
        };

        const headerHeight = rowHeight(headers, true);
        const firstRows = rows.slice(0, 3).reduce((sum, r) => sum + rowHeight(r, false), 0);
        doc.moveDown(0.6);
        ensureSpace(Math.min(headerHeight + firstRows + 40, PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM - 40));

        if (section.tableCaption) {
          doc.font(FONT_SERIF_BOLD).fontSize(9).fillColor("#000000");
          const captionText = sanitizeForPdf(section.tableCaption);
          const split = captionText.match(/^(Table\s+\d+:)\s*([\s\S]*)$/);
          if (split) {
            doc.text(`${split[1].replace(/:$/, ".")} `, MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH, continued: true });
            doc.font(FONT_SERIF).text(split[2]);
          } else {
            doc.text(captionText, MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH });
          }
          doc.moveDown(0.3);
        }

        let y = doc.y;
        rule(y, 0.9);
        drawRow(headers, y, true);
        y += headerHeight;
        rule(y, 0.5);
        for (const row of rows) {
          const h = rowHeight(row, false);
          if (y + h > PAGE_HEIGHT - MARGIN_BOTTOM - 6) {
            rule(y, 0.9);
            doc.addPage();
            y = doc.y;
            rule(y, 0.9);
            drawRow(headers, y, true);
            y += headerHeight;
            rule(y, 0.5);
          }
          drawRow(row, y, false);
          y += h;
        }
        rule(y, 0.9);
        doc.y = y + 4;
        if (section.notes) {
          doc.font(FONT_SERIF_ITALIC).fontSize(Math.max(7, fontSize - 0.5)).fillColor("#333333");
          doc.text(`Notes: ${sanitizeForPdf(section.notes)}`, tableX, doc.y, { width: Math.max(tableWidth, CONTENT_WIDTH * 0.6), align: "left", lineGap: 0.5 });
          doc.fillColor("#000000");
        }
        doc.x = MARGIN_LEFT;
        doc.moveDown(0.8);
      };

      // Process each section
      for (const section of sections) {
        switch (section.type) {
          case "title": {
            doc.font(FONT_SERIF_BOLD).fontSize(18);
            const titleText = sanitizeForPdf(section.text || "");
            doc.text(titleText, MARGIN_LEFT, doc.y, {
              width: CONTENT_WIDTH,
              align: "center",
              lineGap: 4,
            });
            doc.moveDown(0.3);
            break;
          }

          case "author": {
            doc.font(FONT_SERIF).fontSize(11).fillColor("#333333");
            doc.text(sanitizeForPdf(section.text || ""), { width: CONTENT_WIDTH, align: "center" });
            doc.fillColor("#000000");
            doc.moveDown(0.2);
            break;
          }

          case "conference": {
            const confText = sanitizeForPdf(section.text || "");
            if (confText) {
              doc.font(FONT_SERIF).fontSize(9).fillColor("#666666");
              doc.text(confText, { width: CONTENT_WIDTH, align: "center" });
              doc.fillColor("#000000");
              doc.moveDown(0.2);
            }
            doc.font(FONT_SERIF).fontSize(8).fillColor("#888888");
            doc.text("Generated by Auto Research — Autonomous Research Pipeline", {
              width: CONTENT_WIDTH,
              align: "center",
            });
            doc.fillColor("#000000");
            doc.moveDown(0.5);
            // Draw separator line
            doc.moveTo(MARGIN_LEFT, doc.y).lineTo(PAGE_WIDTH - MARGIN_RIGHT, doc.y).strokeColor("#cccccc").lineWidth(0.5).stroke();
            doc.moveDown(0.5);
            break;
          }

          case "abstract": {
            ensureSpace(80);
            // Draw abstract box
            const absStartY = doc.y;
            doc.font(FONT_SERIF_BOLD).fontSize(10);
            doc.text("Abstract", MARGIN_LEFT + 20, doc.y, { width: CONTENT_WIDTH - 40 });
            doc.moveDown(0.3);
            doc.font(FONT_SERIF).fontSize(9.5);
            doc.text(sanitizeForPdf(section.text || ""), MARGIN_LEFT + 20, doc.y, {
              width: CONTENT_WIDTH - 40,
              align: "justify",
              lineGap: 2,
            });
            const absEndY = doc.y + 10;
            // Draw left border
            doc.moveTo(MARGIN_LEFT + 15, absStartY - 5).lineTo(MARGIN_LEFT + 15, absEndY).strokeColor("#2563eb").lineWidth(2).stroke();
            // Draw background
            doc.rect(MARGIN_LEFT + 18, absStartY - 5, CONTENT_WIDTH - 36, absEndY - absStartY + 10).fillOpacity(0.03).fill("#2563eb");
            doc.fillOpacity(1).fillColor("#000000");
            doc.y = absEndY + 5;
            doc.moveDown(0.5);
            break;
          }

          case "heading": {
            ensureSpace(40);
            doc.moveDown(0.8);
            doc.font(FONT_SERIF_BOLD).fontSize(13);
            doc.text(sanitizeForPdf(section.text || ""), MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH });
            doc.moveDown(0.15);
            // Subtle underline
            doc.moveTo(MARGIN_LEFT, doc.y).lineTo(PAGE_WIDTH - MARGIN_RIGHT, doc.y).strokeColor("#eeeeee").lineWidth(0.5).stroke();
            doc.moveDown(0.35);
            break;
          }

          case "subheading": {
            ensureSpace(30);
            doc.moveDown(0.5);
            doc.font(FONT_SERIF_BOLD).fontSize(11.5);
            doc.text(sanitizeForPdf(section.text || ""), MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH });
            doc.moveDown(0.25);
            break;
          }

          case "subsubheading": {
            ensureSpace(20);
            doc.moveDown(0.2);
            doc.font(FONT_SERIF_ITALIC).fontSize(11);
            doc.text(sanitizeForPdf(section.text || ""), MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH });
            doc.moveDown(0.2);
            break;
          }

          case "paragraph": {
            const paraText = sanitizeForPdf(section.text || "");
            if (!paraText) break; // skip empty paragraphs after sanitization
            ensureSpace(20);
            doc.font(FONT_SERIF).fontSize(10.5);
            doc.text(paraText, MARGIN_LEFT, doc.y, {
              width: CONTENT_WIDTH,
              align: "justify",
              lineGap: 2,
              indent: 0,
            });
            doc.moveDown(0.3);
            break;
          }

          case "figure": {
            let imageEmbedded = false;

            if (section.imageUrl || section.imageFileKey) {
              try {
                const cacheKey = section.imageFileKey || section.imageUrl || `figure:${section.caption || doc.y}`;
                if (!imageBufferCache.has(cacheKey)) {
                  imageBufferCache.set(cacheKey, fetchImageBuffer({
                    url: section.imageUrl,
                    fileKey: section.imageFileKey,
                  }));
                }
                const rawBuffer = await imageBufferCache.get(cacheKey)!;
                const imgBuffer = rawBuffer ? await ensurePdfEmbeddableImage(rawBuffer) : null;
                if (imgBuffer && imgBuffer.length > 500) {
                  // Size the image from its real aspect ratio before deciding on a page break.
                  const maxImgWidth = CONTENT_WIDTH * 0.92;
                  const maxImgHeight = 330;
                  let renderedWidth = maxImgWidth;
                  let renderedHeight = maxImgWidth / 1.6;
                  try {
                    const sizeOf = (await import("image-size")).default;
                    const dims = sizeOf(imgBuffer);
                    if (dims.width && dims.height) {
                      const scale = Math.min(maxImgWidth / dims.width, maxImgHeight / dims.height);
                      renderedWidth = dims.width * scale;
                      renderedHeight = dims.height * scale;
                    }
                  } catch {
                    // keep default aspect ratio
                  }
                  doc.font(FONT_SERIF).fontSize(9);
                  const captionHeight = section.caption
                    ? doc.heightOfString(sanitizeForPdf(section.caption), { width: CONTENT_WIDTH - 40 }) + 8
                    : 0;
                  ensureSpace(renderedHeight + captionHeight + 24);

                  doc.moveDown(0.6);
                  const figStartY = doc.y;
                  const imgX = MARGIN_LEFT + (CONTENT_WIDTH - renderedWidth) / 2;
                  doc.image(imgBuffer, imgX, figStartY, { width: renderedWidth, height: renderedHeight });
                  doc.y = figStartY + renderedHeight + 6;
                  imageEmbedded = true;
                } else {
                  console.warn(`[PDF] Image buffer too small or invalid for ${section.caption || "figure"}`);
                }
              } catch (imgErr: any) {
                console.warn(`[PDF] Failed to embed image: ${imgErr.message}`);
              }
            }

            if (!imageEmbedded) {
              // Show a placeholder box for the missing figure
              ensureSpace(60);
              doc.moveDown(0.4);
              const placeholderY = doc.y;
              doc.rect(MARGIN_LEFT + 40, placeholderY, CONTENT_WIDTH - 80, 40)
                .fillOpacity(0.04).fill("#666666");
              doc.fillOpacity(1).fillColor("#999999");
              doc.font(FONT_SERIF_ITALIC).fontSize(9);
              doc.text("[Figure image not available]", MARGIN_LEFT, placeholderY + 14, {
                width: CONTENT_WIDTH, align: "center",
              });
              doc.fillColor("#000000");
              doc.y = placeholderY + 48;
            }

            if (section.caption) {
              ensureSpace(25);
              const captionText = sanitizeForPdf(section.caption);
              const split = captionText.match(/^(Figure\s+\d+:)\s*([\s\S]*)$/);
              doc.fillColor("#000000");
              if (split) {
                doc.font(FONT_SERIF_BOLD).fontSize(9).text(`${split[1].replace(/:$/, ".")} `, MARGIN_LEFT + 20, doc.y, {
                  width: CONTENT_WIDTH - 40,
                  align: "justify",
                  continued: true,
                });
                doc.font(FONT_SERIF).fontSize(9).text(split[2], { align: "justify" });
              } else {
                doc.font(FONT_SERIF_ITALIC).fontSize(9).text(captionText, MARGIN_LEFT + 20, doc.y, {
                  width: CONTENT_WIDTH - 40,
                  align: "center",
                });
              }
              doc.x = MARGIN_LEFT;
              doc.moveDown(0.3);
            }
            // Add spacing after figure
            doc.moveDown(0.5);
            break;
          }

          case "table": {
            if (!section.headers || section.headers.length === 0) break;
            renderTable(section);
            break;
          }

          case "equation": {
            // Display math equation - centered with subtle background
            const eqText = sanitizeForPdf(section.text || "");
            if (!eqText) break; // skip empty equations after sanitization
            const eqLines = eqText
              .split("\n")
              .map((l: string) => l.trim())
              .filter((l: string) => l.length > 0);
            const lineHeight = 14;
            const eqTotalHeight = eqLines.length * lineHeight + 24; // padding top/bottom
            ensureSpace(eqTotalHeight + 20);

            doc.moveDown(0.4);
            const eqStartY = doc.y;

            // Draw subtle background
            doc.rect(
              MARGIN_LEFT + 30,
              eqStartY - 4,
              CONTENT_WIDTH - 60,
              eqTotalHeight
            ).fillOpacity(0.025).fill("#1e40af");
            doc.fillOpacity(1).fillColor("#000000");

            // Draw left accent bar
            doc.moveTo(MARGIN_LEFT + 30, eqStartY - 4)
              .lineTo(MARGIN_LEFT + 30, eqStartY - 4 + eqTotalHeight)
              .strokeColor("#6366f1").lineWidth(1.5).stroke();

            // Render each line of the equation
            doc.font(FONT_SERIF_ITALIC).fontSize(10.5);
            let eqY = eqStartY + 8;
            for (const eqLine of eqLines) {
              doc.text(eqLine, MARGIN_LEFT + 40, eqY, {
                width: CONTENT_WIDTH - 80,
                align: "center",
                lineBreak: false,
              });
              eqY += lineHeight;
            }

            doc.y = eqStartY + eqTotalHeight + 4;
            doc.moveDown(0.4);
            break;
          }

          case "list": {
            ensureSpace(20);
            doc.font(FONT_SERIF).fontSize(10.5);
            for (const item of (section.items || [])) {
              const listText = sanitizeForPdf(item);
              if (!listText) continue; // skip empty items after sanitization
              ensureSpace(15);
              doc.text(`  •  ${listText}`, MARGIN_LEFT + 10, doc.y, {
                width: CONTENT_WIDTH - 20,
                lineGap: 2,
              });
              doc.moveDown(0.1);
            }
            doc.moveDown(0.2);
            break;
          }

          case "bibliography": {
            ensureSpace(30);
            doc.moveDown(0.5);
            doc.font(FONT_SERIF_BOLD).fontSize(13);
            doc.text("References", MARGIN_LEFT, doc.y, { width: CONTENT_WIDTH });
            doc.moveDown(0.1);
            doc.moveTo(MARGIN_LEFT, doc.y).lineTo(PAGE_WIDTH - MARGIN_RIGHT, doc.y).strokeColor("#eeeeee").lineWidth(0.5).stroke();
            doc.moveDown(0.3);

            doc.font(FONT_SERIF).fontSize(9.5);
            (section.items || []).forEach((item, i) => {
              const bibText = sanitizeForPdf(item);
              if (!bibText) return; // skip empty bibliography entries
              ensureSpace(15);
              doc.text(`[${i + 1}] ${bibText}`, MARGIN_LEFT + 5, doc.y, {
                width: CONTENT_WIDTH - 10,
                lineGap: 1.5,
              });
              doc.moveDown(0.15);
            });
            break;
          }

          case "separator": {
            doc.moveDown(0.3);
            doc.moveTo(MARGIN_LEFT, doc.y).lineTo(PAGE_WIDTH - MARGIN_RIGHT, doc.y).strokeColor("#dddddd").lineWidth(0.5).stroke();
            doc.moveDown(0.3);
            break;
          }
        }
      }

      const range = doc.bufferedPageRange();
      const totalPages = range.count;

      // Add page numbers and header to all pages
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0;
        // Footer: page number
        doc.font(FONT_SERIF).fontSize(8).fillColor("#999999");
        doc.text(
          `${i + 1} / ${totalPages}`,
          0,
          PAGE_NUMBER_Y,
          { width: PAGE_WIDTH, align: "center", lineBreak: false }
        );
        // Header: conference name (skip first page, only if conference is specified)
        if (i > 0 && conference && conference.trim().length > 0) {
          doc.text(
            conference,
            0,
            25,
            { width: PAGE_WIDTH, align: "center", lineBreak: false }
          );
        }
        doc.fillColor("#000000");
      }

      // Footer on last page
      doc.switchToPage(totalPages - 1);
      doc.page.margins.bottom = 0;
      doc.font(FONT_SERIF).fontSize(7).fillColor("#999999");
      doc.text(
        `Generated by Auto Research • ${new Date().toISOString().split("T")[0]}`,
        0,
        FOOTER_NOTE_Y,
        { width: PAGE_WIDTH, align: "center", lineBreak: false }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Generate PDF from paper content using PDFKit (no Chromium required).
 *
 * Strategy:
 *  1. If latexSource is provided, parse LaTeX → structured sections → PDF
 *  2. Otherwise, parse Markdown → structured sections → PDF
 *  3. Chart images are fetched and embedded directly
 */
export async function generatePaperPdf(
  markdownContent: string,
  title: string,
  conference?: string,
  latexSource?: string,
  chartImages: ChartImage[] = []
): Promise<Buffer> {
  const confLabel = conference || "";

  // Primary path: LaTeX → sections → PDF
  if (latexSource && latexSource.trim().length > 100) {
    console.log(`[PDF] Parsing LaTeX → structured sections (${chartImages.length} chart images)...`);
    try {
      const sections = parseLatexToSections(latexSource, title, confLabel, chartImages);
      console.log(`[PDF] Parsed ${sections.length} sections, rendering to PDF...`);
      const pdfBuffer = await renderSectionsToPdf(sections, confLabel);
      if (pdfBuffer && pdfBuffer.length > 100) {
        console.log(`[PDF] LaTeX → PDFKit produced ${(pdfBuffer.length / 1024).toFixed(1)} KiB`);
        return pdfBuffer;
      }
    } catch (err: any) {
      console.warn(`[PDF] LaTeX → PDFKit failed: ${err.message}, falling back to Markdown`);
    }
  }

  // Fallback path: Markdown → sections → PDF
  if (markdownContent && markdownContent.trim().length > 0) {
    console.log(`[PDF] Parsing Markdown → structured sections (${chartImages.length} chart images)...`);
    const sections = parseMarkdownToSections(markdownContent, title, confLabel, chartImages);
    console.log(`[PDF] Parsed ${sections.length} sections, rendering to PDF...`);
    const pdfBuffer = await renderSectionsToPdf(sections, confLabel);
    console.log(`[PDF] Markdown → PDFKit produced ${(pdfBuffer.length / 1024).toFixed(1)} KiB`);
    return pdfBuffer;
  }

  throw new Error("No content available for PDF generation (both LaTeX and Markdown are empty)");
}

/**
 * Generate PDF from Markdown content.
 */
export async function generatePaperPdfFromMarkdown(
  markdownContent: string,
  title: string,
  conference?: string,
  chartImages: ChartImage[] = []
): Promise<Buffer> {
  return generatePaperPdf(markdownContent, title, conference, undefined, chartImages);
}

/**
 * @deprecated Use generatePaperPdf instead. Kept for backward compatibility.
 */
export async function compileLatexToPdf(
  latexSource: string,
  chartImages: ChartImage[] = [],
  _timeoutMs = 180_000
): Promise<Buffer | null> {
  try {
    return await generatePaperPdf("", "Research Paper", "Conference", latexSource, chartImages);
  } catch {
    return null;
  }
}

/**
 * Find Chromium - kept for backward compatibility with experiment-runner.
 * Returns empty string if not found (no longer throws).
 */
export function findChromium(): string {
  const paths = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const p of paths) {
    try {
      if (fsNode.existsSync(p)) return p;
    } catch {}
  }
  // Try 'which' command
  for (const cmd of ["chromium-browser", "chromium", "google-chrome"]) {
    try {
      const result = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (result) return result;
    } catch {}
  }
  return ""; // Return empty instead of throwing
}
