import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as XLSX from "xlsx";
import { renderChartSvg } from "./chart-renderer";
import {
  __testParseDataFile,
  buildDatasetProfile,
  classifyColumns,
  fDistributionPValue,
  generateDefaultCharts,
  generateDefaultMetrics,
  generateDefaultTables,
  remapAnalysisInputs,
  studentTTwoTailPValue,
} from "./experiment-runner";
import { detectDelimiter, normaliseRecords, parseJsonRecords, sheetRowsToRecords } from "./tabular-utils";
import { buildTableManifest, insertAssetsIntoLatex, tableToLatex, type FigureManifestEntry, type TableManifestEntry } from "./paper-assets";
import { generatePaperPdf, parseLatexToSections } from "./pdf-generator";

function seededRandom(seed: number) {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

function buildSurvey(rows = 600) {
  const rnd = seededRandom(7);
  const regions = ["North", "South", "East", "West"];
  const employment = ["Full-time", "Part-time", "Unemployed"];
  return Array.from({ length: rows }, (_, i) => {
    const status = employment[Math.floor(rnd() * 3)];
    const hours = status === "Unemployed" ? 0 : Math.round(20 + rnd() * 25);
    const income = Math.round(200000 + rnd() * 400000);
    return {
      respondent_id: i + 1,
      region: regions[Math.floor(rnd() * 4)],
      female: rnd() < 0.5 ? 1 : 0,
      age: Math.round(20 + rnd() * 45),
      employment_status: status,
      weekly_hours: rnd() < 0.05 ? null : hours,
      annual_income: rnd() < 0.05 ? null : income,
      wellbeing_score: Math.round((5 + income / 200000 - (status === "Unemployed" ? 1 : 0) + rnd()) * 100) / 100,
    };
  });
}

function dataset(name: string, data: Record<string, any>[]) {
  return [{ name, data, columns: Object.keys(data[0]), totalRows: data.length }];
}

describe("chart renderer", () => {
  it("wraps long titles and rotates dense category labels instead of overlapping them", () => {
    const svg = renderChartSvg({
      type: "bar",
      data: { labels: Array.from({ length: 30 }, (_, i) => `Occupational category number ${i + 1}`), datasets: [{ label: "Share", data: Array.from({ length: 30 }, (_, i) => i + 1) }] },
      options: { plugins: { title: { display: true, text: "A deliberately long chart title that cannot fit on a single line of a nine hundred pixel wide figure" } } },
    }, 900, 560);
    expect((svg.match(/font-weight="bold"/g) || []).length).toBe(2);
    expect(svg).toContain("rotate(-40");
    expect(svg).not.toContain("NaN");
  });

  it("draws forest plots, box plots and histograms with reference lines", () => {
    const forest = renderChartSvg({ type: "forest", data: { labels: ["a", "b"], datasets: [{ data: [{ estimate: 0.2, low: 0.1, high: 0.3 }, { estimate: -0.1, low: -0.3, high: 0.05 }] }] } }, 900, 400);
    expect(forest).toContain("<circle");
    expect(forest).toContain('stroke-dasharray="5,4"');
    const box = renderChartSvg({ type: "boxplot", data: { labels: ["g1", "g2"], datasets: [{ data: [{ min: 1, q1: 2, median: 3, q3: 4, max: 5, outliers: [9] }, { min: 2, q1: 3, median: 4, q3: 5, max: 6 }] }] } }, 900, 500);
    expect((box.match(/<rect/g) || []).length).toBeGreaterThanOrEqual(3);
    const hist = renderChartSvg({ type: "histogram", data: { datasets: [{ data: [{ x0: 0, x1: 1, count: 3 }, { x0: 1, x1: 2, count: 5 }] }, { type: "line", label: "Density", data: [{ x: 0, y: 2 }, { x: 1, y: 4 }, { x: 2, y: 3 }] }] } }, 900, 500);
    expect(hist).toContain("<path d=\"M");
    for (const svg of [forest, box, hist]) expect(svg).not.toMatch(/NaN|undefined/);
  });

  it("renders floating ranges from their lower bound rather than from zero", () => {
    const svg = renderChartSvg({ type: "bar", data: { labels: ["a"], datasets: [{ data: [[10, 12]] }] }, options: { indexAxis: "y" } }, 900, 400);
    const bars = Array.from(svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^>]*fill="#2a78d6"/g));
    expect(bars.length).toBe(1);
    // The bar spans only part of the axis (10-12 on a 10-12 scale would be full width if
    // it started at zero, the axis would start at 0).
    expect(svg).not.toMatch(/>0<\/text>/);
  });
});

describe("statistical distributions", () => {
  it("computes exact Student-t and F tail probabilities", () => {
    expect(studentTTwoTailPValue(2, 10)).toBeCloseTo(0.0734, 3);
    expect(studentTTwoTailPValue(1.96, 1e6)).toBeCloseTo(0.05, 3);
    expect(fDistributionPValue(4, 2, 20)).toBeCloseTo(0.0346, 3);
  });
});

describe("column classification and variable roles", () => {
  it("keeps 0/1 indicators and rating scales numeric while treating long code runs as identifiers", () => {
    const rnd = seededRandom(3);
    const data = Array.from({ length: 200 }, (_, i) => ({
      female: i % 2,
      satisfaction: 1 + (i % 5),
      prefecture_code: 1 + (i % 47),
      score: Math.round(rnd() * 100),
    }));
    const { numericCols, idCols } = classifyColumns(data, Object.keys(data[0]));
    expect(numericCols).toContain("female");
    expect(numericCols).toContain("satisfaction");
    expect(idCols).toContain("prefecture_code");
  });

  it("does not mistake words containing 'iv' (productivity) for instruments", () => {
    const rnd = seededRandom(5);
    const data = Array.from({ length: 120 }, (_, i) => ({ firm_id: 1 + (i % 30), year: 2015 + Math.floor(i / 30), weekly_hours: 40 - rnd() * 5, productivity: 10 + rnd() * 3 }));
    const metrics = generateDefaultMetrics(dataset("p.csv", data), new Set(["descriptive_statistics"]), "Firm productivity");
    expect(metrics.analysis_design_outcome).toBe("productivity");
  });

  it("remaps user-specified roles after columns are translated", () => {
    const remapped = remapAnalysisInputs({ outcome: "幸福度", controls: ["年齢"] }, new Map([["幸福度", "Happiness"], ["年齢", "Age"]]));
    expect(remapped?.outcome).toBe("Happiness");
    expect(remapped?.controls).toEqual(["Age"]);
  });

  it("profiles datasets with value-based column kinds and panel structure", () => {
    const data = Array.from({ length: 60 }, (_, i) => ({ unit: `u${i % 12}`, year: 2018 + Math.floor(i / 12), treated: i % 12 < 6 ? 1 : 0, outcome: i * 0.5 }));
    const profile = buildDatasetProfile({ name: "panel.csv", data, columns: Object.keys(data[0]), totalRows: data.length }, "Outcome of a policy");
    const kinds = Object.fromEntries(profile.columnProfiles.map(c => [c.name, c.kind]));
    expect(kinds.treated).toBe("binary");
    expect(kinds.year).toBe("datetime");
    expect(profile.panel?.entities).toBe(12);
  });
});

describe("figure and table planning", () => {
  it("produces captioned, sectioned figures suited to a cross-sectional survey", () => {
    const survey = buildSurvey();
    const charts = generateDefaultCharts(dataset("survey.csv", survey), null, "Wellbeing and employment status");
    const names = charts.map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(["distribution_histogram", "box_plot", "category_comparison", "correlation_matrix", "scatter_plot"]));
    expect(names).not.toContain("pairwise_scatter");
    expect(names).not.toContain("stacked_bar");
    expect(charts.length).toBeLessThanOrEqual(12);
    for (const chart of charts) {
      expect(chart.caption && chart.caption.length).toBeGreaterThan(20);
      expect(["descriptive", "main", "diagnostic"]).toContain(chart.section);
      const svg = renderChartSvg(chart.config, chart.width || 900, chart.height || 560);
      expect(svg).not.toMatch(/NaN|undefined/);
    }
  });

  it("builds a journal-style regression table and correct pairwise correlations with missing data", () => {
    const survey = buildSurvey();
    const tables = generateDefaultTables(dataset("survey.csv", survey), null, "Wellbeing and employment status", { outcome: "wellbeing_score", keyExplanatory: "annual_income", controls: ["age", "region"] });
    const regression = tables.find(t => t.name === "regression_results");
    expect(regression).toBeTruthy();
    expect(regression!.headers[1]).toMatch(/^\(1\)/);
    expect(regression!.rows.some(row => /^\(.+\)$/.test(String(row[1])))).toBe(true);
    expect(regression!.rows.some(row => String(row[0]).startsWith("region = "))).toBe(true);
    expect(regression!.notes).toMatch(/Standard errors|standard errors/);

    const correlation = tables.find(t => t.name === "correlation_matrix")!;
    const labels = correlation.rows.map(row => String(row[0]));
    const incomeIndex = labels.findIndex(l => l.includes("annual_income"));
    const wellbeingIndex = labels.findIndex(l => l.includes("wellbeing_score"));
    const [row, col] = incomeIndex > wellbeingIndex ? [incomeIndex, wellbeingIndex] : [wellbeingIndex, incomeIndex];
    const reported = parseFloat(String(correlation.rows[row][col + 1]));
    const pairs = survey.filter(r => r.annual_income !== null).map(r => [r.annual_income as number, r.wellbeing_score]);
    const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
    const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
    const cov = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
    const vx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    const vy = pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0);
    expect(reported).toBeCloseTo(cov / Math.sqrt(vx * vy), 2);
  });
});

describe("data ingestion", () => {
  it("detects delimiters and normalises numbers stored as text and missing codes", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n4;5;6")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    const records: Record<string, any>[] = [{ pop: "1,234", rate: "12%", label: "x" }, { pop: "－", rate: "3%", label: "y" }, { pop: "5,000", rate: "NA", label: "z" }];
    const converted = normaliseRecords(records, ["pop", "rate", "label"]);
    expect(converted).toEqual(["pop", "rate"]);
    expect(records.map(r => r.pop)).toEqual([1234, null, 5000]);
    expect(records[2].rate).toBeNull();
    expect(records[0].label).toBe("x");
  });

  it("flattens nested JSON and reads JSON Lines", () => {
    const nested = parseJsonRecords(JSON.stringify({ results: [{ id: 1, person: { age: 30 } }, { id: 2, person: { age: 41, city: "Kyoto" } }] }));
    expect(nested[1]["person.city"]).toBe("Kyoto");
    expect(parseJsonRecords('{"a":1}\n{"a":2,"b":3}\n')).toHaveLength(2);
  });

  it("skips title rows in spreadsheets and picks the data sheet", async () => {
    const { records, columns } = sheetRowsToRecords([["Table 1. Survey"], [], ["pref", "year", "value"], ["Tokyo", 2020, 1], ["Osaka", 2020, 2]]);
    expect(columns).toEqual(["pref", "year", "value"]);
    expect(records).toHaveLength(2);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["cover page"]]), "Cover");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Title"], ["region", "income"], ["A", "1,000"], ["B", "2,500"], ["C", "x"]]), "Data");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-")), "book.xlsx");
    fs.writeFileSync(file, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    const parsed = await __testParseDataFile(file, "excel");
    expect(parsed.columns).toEqual(["region", "income"]);
    expect(parsed.data.map(r => r.income)).toEqual([1000, 2500, null]);
  });
});

describe("paper assets", () => {
  const figures: FigureManifestEntry[] = [1, 2].map(n => ({ number: n, key: `figure_${n}`, name: `f${n}`, caption: `Caption ${n} (n = 10) 50% & more`, section: "main", url: `http://example.test/${n}.png` }));
  const tables: TableManifestEntry[] = [
    { number: 1, key: "table_1", name: "descriptive_statistics", title: "Summary statistics", headers: ["Variable", "Mean"], rows: [["x_var", "1.5"]], notes: "Non-missing values.", section: "descriptive" },
    { number: 2, key: "table_2", name: "missing_data_summary", title: "Missing data", headers: ["Variable", "Missing %"], rows: [["x", "3%"]], section: "appendix" },
  ];

  it("places every figure and table exactly once, replacing LLM-made duplicates", () => {
    const latex = String.raw`\documentclass{article}
\begin{document}
\section{Results}
Figure 2 shows the relation.
\texttt{\[\[TABLE:1\]\]}
\begin{figure}[H]\includegraphics{figure_1}\caption{LLM}\end{figure}
\begin{table}[H]\begin{tabular}{lcc}a & 1.2 & 3.4\\ b & 5.6 & 7.8\\ c & 9.1 & 2.3\\\end{tabular}\end{table}
\section{Conclusion}
Done.
\end{document}`;
    const { latex: out, report } = insertAssetsIntoLatex(latex, figures, tables);
    expect((out.match(/\\includegraphics/g) || []).length).toBe(2);
    expect((out.match(/\\begin\{table\}/g) || []).length).toBe(2);
    expect(out.indexOf("{figure_1}")).toBeLessThan(out.indexOf("{figure_2}"));
    expect(out.indexOf("Appendix")).toBeLessThan(out.indexOf("tab:table_2"));
    expect(out).toContain("50\\% \\& more");
    expect(report.removedLlmTables).toBe(1);
  });

  it("typesets tables that the PDF parser reads back with notes intact", () => {
    const sections = parseLatexToSections(
      `\\documentclass{article}\\begin{document}\\section{Data}\n${tableToLatex(tables[0])}\n\\begin{table}[htbp]\\caption{Results with \\textit{nested} braces}\\begin{tabular}{l p{3cm} c}\\toprule & \\multicolumn{2}{c}{Panel A} \\\\ \\midrule R\\&D & 1.0 & (0.2) \\\\ \\bottomrule\\end{tabular}\\end{table}\n\\end{document}`,
      "t",
      "",
    );
    const parsedTables = sections.filter(s => s.type === "table");
    expect(parsedTables).toHaveLength(2);
    expect(parsedTables[0].headers).toEqual(["Variable", "Mean"]);
    expect(parsedTables[0].notes).toBe("Non-missing values.");
    expect(parsedTables[1].tableCaption).toContain("nested");
    expect(parsedTables[1].headers).toHaveLength(3);
    expect(parsedTables[1].rows?.[0]).toEqual(["R&D", "1.0", "(0.2)"]);
  });

  it("renders manifest tables into a PDF", async () => {
    const manifest = buildTableManifest({
      success: true, stdout: "", stderr: "", exitCode: 0, executionTimeMs: 0, charts: [], metrics: {},
      tables: [{ name: "regression_results", url: "", data: "", description: "Regression estimates", headers: ["", "(1) OLS", "(2) OLS + controls"], rows: [["x", "0.512***", "0.498***"], ["", "(0.101)", "(0.099)"], ["Observations", "1,000", "1,000"]], notes: "Robust standard errors.", section: "main" }],
    });
    const latex = insertAssetsIntoLatex("\\documentclass{article}\\begin{document}\\section{Results}\nSee Table 1.\n\n[[TABLE:1]]\n\\end{document}", [], manifest).latex;
    const pdf = await generatePaperPdf("", "Test", "", latex, []);
    expect(pdf.slice(0, 5).toString()).toBe("%PDF-");
  });
});
