import { describe, expect, it } from "vitest";
import { generatePaperPdf } from "./pdf-generator";
import { generateSvgFallbackChart, transliterateLabelSync } from "./experiment-runner";

function countPdfPages(pdfBuffer: Buffer): number {
  const raw = pdfBuffer.toString("latin1");
  return (raw.match(/\/Type\s*\/Page\b/g) || []).length;
}

/** Helper: assert valid SVG with no NaN/undefined artifacts */
function assertCleanSvg(svg: string) {
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain("</svg>");
  expect(svg).not.toContain("NaN");
  expect(svg).not.toContain("undefined");
}

describe("PDF formatting regressions", () => {
  it("does not append extra blank pages on short papers", async () => {
    const latex = `\\documentclass{article}
\\begin{document}
\\title{Blank Page Regression}
\\maketitle
\\begin{abstract}
Short abstract for page counting.
\\end{abstract}
\\section{Introduction}
This paragraph should fit on one page and must not trigger extra blank pages.
\\section{Conclusion}
The document ends here.
\\end{document}`;

    const pdf = await generatePaperPdf("", "Blank Page Regression", "TestConf 2026", latex, []);
    expect(pdf.slice(0, 5).toString()).toBe("%PDF-");

    const pageCount = countPdfPages(pdf);
    // Previously this produced 3 pages due footer drawing outside the printable region.
    expect(pageCount).toBeLessThanOrEqual(2);
    expect(pageCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Chart fallback rendering regressions", () => {
  it("renders bubble charts with circles and without malformed coordinates", () => {
    const bubbleConfig = JSON.stringify({
      type: "bubble",
      data: {
        datasets: [
          {
            label: "Positive correlation",
            data: [
              { x: 0, y: 0, r: 8 },
              { x: 1, y: 1, r: 12 },
              { x: 2, y: 1.8, r: 10 },
            ],
          },
          {
            label: "Negative correlation",
            data: [
              { x: 0, y: 2, r: 6 },
              { x: 1, y: 1, r: 7 },
            ],
          },
        ],
      },
      options: {
        plugins: {
          title: { display: true, text: "Correlation Matrix" },
        },
      },
    });

    const svg = generateSvgFallbackChart(bubbleConfig, 900, 560).toString("utf-8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("undefined");
  });

  it("renders pie charts as arc paths (not bar placeholders)", () => {
    const pieConfig = JSON.stringify({
      type: "pie",
      data: {
        labels: ["A", "B", "C", "D"],
        datasets: [
          {
            data: [40, 25, 20, 15],
          },
        ],
      },
      options: {
        plugins: {
          title: { display: true, text: "Category Distribution" },
        },
      },
    });

    const svg = generateSvgFallbackChart(pieConfig, 900, 560).toString("utf-8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<path d=\"M");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("undefined");
  });
});

/* ------------------------------------------------------------------ */
/*  Chart type variety tests                                           */
/* ------------------------------------------------------------------ */
describe("Chart type variety", () => {
  it("renders line chart with axis titles", () => {
    const config = JSON.stringify({
      type: "line",
      data: {
        labels: ["Jan", "Feb", "Mar", "Apr", "May"],
        datasets: [{
          label: "Revenue",
          data: [100, 120, 115, 130, 145],
          borderColor: "rgba(78, 121, 167, 1)",
        }],
      },
      options: {
        plugins: { title: { display: true, text: "Monthly Revenue" } },
        scales: {
          x: { title: { display: true, text: "Month" } },
          y: { title: { display: true, text: "USD (thousands)" } },
        },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // Should contain line path elements
    expect(svg).toContain("<path d=\"M");
    // Should contain axis title text
    expect(svg).toContain("Month");
    expect(svg).toContain("USD (thousands)");
  });

  it("renders scatter plot with regression line dataset", () => {
    const config = JSON.stringify({
      type: "scatter",
      data: {
        datasets: [
          {
            label: "Observations",
            data: [
              { x: 1, y: 2 }, { x: 2, y: 3.5 }, { x: 3, y: 4.1 },
              { x: 4, y: 5.8 }, { x: 5, y: 6.2 },
            ],
            backgroundColor: "rgba(78, 121, 167, 0.5)",
          },
          {
            label: "Regression (r=0.98)",
            data: [{ x: 1, y: 1.9 }, { x: 5, y: 6.3 }],
            borderColor: "rgba(225, 87, 89, 1)",
            pointRadius: 0,
            showLine: true,
          },
        ],
      },
      options: {
        plugins: { title: { display: true, text: "Height vs Weight" } },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    expect(svg).toContain("<circle");
    expect(svg).toContain("Height vs Weight");
  });

  it("renders heatmap with correlation data", () => {
    const vars = ["Age", "Income", "Education", "Health"];
    const heatData: { x: number; y: number; v: number }[] = [];
    for (let i = 0; i < vars.length; i++) {
      for (let j = 0; j < vars.length; j++) {
        heatData.push({ x: j, y: i, v: i === j ? 1.0 : Math.round((Math.random() * 2 - 1) * 100) / 100 });
      }
    }

    const config = JSON.stringify({
      type: "heatmap",
      data: {
        labels: vars,
        datasets: [{ data: heatData }],
      },
      options: {
        plugins: { title: { display: true, text: "Correlation Matrix" } },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // Should contain colored rect cells
    expect(svg).toContain("rgb(");
    // Should contain variable labels
    expect(svg).toContain("Age");
    expect(svg).toContain("Income");
  });

  it("renders doughnut chart with hole in center", () => {
    const config = JSON.stringify({
      type: "doughnut",
      data: {
        labels: ["Employed", "Unemployed", "Student", "Retired"],
        datasets: [{
          data: [55, 10, 20, 15],
          backgroundColor: ["#4e79a7", "#e15759", "#59a14f", "#edc949"],
        }],
      },
      options: {
        plugins: { title: { display: true, text: "Employment Status" } },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // Doughnut should have arc paths and a center circle (hole)
    expect(svg).toContain("<path d=\"M");
    expect(svg).toContain("<circle");
    expect(svg).toContain("Employment Status");
  });

  it("renders stacked bar chart with stacked rects", () => {
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: ["Group A", "Group B", "Group C"],
        datasets: [
          { label: "Variable 1", data: [30, 40, 25], backgroundColor: "rgba(78, 121, 167, 0.7)" },
          { label: "Variable 2", data: [20, 15, 35], backgroundColor: "rgba(242, 142, 43, 0.7)" },
          { label: "Variable 3", data: [10, 25, 20], backgroundColor: "rgba(225, 87, 89, 0.7)" },
        ],
      },
      options: {
        plugins: { title: { display: true, text: "Stacked Composition" } },
        scales: {
          x: { stacked: true, title: { display: true, text: "Group" } },
          y: { stacked: true, title: { display: true, text: "Value" } },
        },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // Should have rect elements for stacked bars
    expect(svg).toContain("<rect");
    expect(svg).toContain("Stacked Composition");
    // All three colors should appear
    expect(svg).toContain("rgba(78, 121, 167, 0.7)");
    expect(svg).toContain("rgba(242, 142, 43, 0.7)");
    expect(svg).toContain("rgba(225, 87, 89, 0.7)");
  });

  it("renders horizontal bar chart with swapped axes", () => {
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: ["Category 1", "Category 2", "Category 3", "Category 4", "Category 5"],
        datasets: [{
          label: "Mean Score",
          data: [85, 72, 91, 63, 78],
          backgroundColor: "rgba(89, 161, 79, 0.7)",
        }],
      },
      options: {
        indexAxis: "y",
        plugins: { title: { display: true, text: "Scores by Category" } },
        scales: {
          x: { title: { display: true, text: "Score" } },
          y: { title: { display: true, text: "Category" } },
        },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    expect(svg).toContain("<rect");
    expect(svg).toContain("Scores by Category");
    // Category labels should appear on the Y axis (text-anchor="end" for left-aligned labels)
    expect(svg).toContain("Category 1");
  });
});

/* ------------------------------------------------------------------ */
/*  Unicode / Japanese label tests                                     */
/* ------------------------------------------------------------------ */
describe("Unicode and Japanese label handling", () => {
  it("transliterates Japanese title to ASCII in SVG output", () => {
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: ["A", "B", "C"],
        datasets: [{ label: "Data", data: [10, 20, 30] }],
      },
      options: {
        plugins: { title: { display: true, text: "年齢別の収入分布" } },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // The Japanese title should be transliterated or stripped — no raw Japanese in SVG
    expect(svg).not.toMatch(/[\u3000-\u9FFF]/);
    // Should not contain replacement boxes
    expect(svg).not.toContain("\u25A1");
  });

  it("transliterates Japanese axis labels", () => {
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: ["A", "B"],
        datasets: [{ label: "Data", data: [10, 20] }],
      },
      options: {
        scales: {
          x: { title: { display: true, text: "年齢" } },
          y: { title: { display: true, text: "収入" } },
        },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // Axis labels should be transliterated (Age, Income from dictionary)
    expect(svg).not.toMatch(/[\u3000-\u9FFF]/);
  });

  it("transliterates Japanese category labels via dictionary", () => {
    const config = JSON.stringify({
      type: "pie",
      data: {
        labels: ["男性", "女性", "その他"],
        datasets: [{ data: [45, 50, 5] }],
      },
      options: {
        plugins: { title: { display: true, text: "Gender Distribution" } },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // Dictionary entries: 男性→Male, 女性→Female, その他→Other
    expect(svg).toContain("Male");
    expect(svg).toContain("Female");
    expect(svg).toContain("Other");
    // No raw Japanese
    expect(svg).not.toMatch(/[\u3000-\u9FFF]/);
  });

  it("transliterates Japanese dataset label in legend", () => {
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: ["X", "Y", "Z"],
        datasets: [{ label: "平均収入", data: [100, 200, 150] }],
      },
      options: {},
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // No raw Japanese characters in the SVG
    expect(svg).not.toMatch(/[\u3000-\u9FFF]/);
    // No replacement box characters
    expect(svg).not.toContain("\u25A1");
  });

  it("preserves ASCII in mixed ASCII + Japanese labels", () => {
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: ["Tokyo", "大阪", "Nagoya"],
        datasets: [{ label: "Population", data: [14, 9, 2] }],
      },
      options: {
        plugins: { title: { display: true, text: "City Population" } },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // ASCII labels preserved
    expect(svg).toContain("Tokyo");
    expect(svg).toContain("Nagoya");
    // 大阪 should be transliterated to Osaka
    expect(svg).toContain("Osaka");
    // No raw Japanese
    expect(svg).not.toMatch(/[\u3000-\u9FFF]/);
  });

  it("transliterateLabelSync handles known dictionary entries", () => {
    expect(transliterateLabelSync("男性")).toBe("Male");
    expect(transliterateLabelSync("女性")).toBe("Female");
    expect(transliterateLabelSync("年齢")).toBe("Age");
    expect(transliterateLabelSync("収入")).toBe("Income");
    expect(transliterateLabelSync("その他")).toBe("Other");
  });

  it("transliterateLabelSync returns ASCII strings unchanged", () => {
    expect(transliterateLabelSync("Hello")).toBe("Hello");
    expect(transliterateLabelSync("Age Group")).toBe("Age Group");
    expect(transliterateLabelSync("")).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/*  Edge case tests                                                    */
/* ------------------------------------------------------------------ */
describe("Chart edge cases", () => {
  it("shows 'No data' message for empty bar chart data", () => {
    const config = JSON.stringify({
      type: "bar",
      data: { labels: [], datasets: [] },
      options: { plugins: { title: { display: true, text: "Empty Chart" } } },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    expect(svg).toContain("No categorical values available");
  });

  it("shows 'No data' message for empty pie chart data", () => {
    const config = JSON.stringify({
      type: "pie",
      data: { labels: [], datasets: [{ data: [] }] },
      options: {},
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    expect(svg).toContain("No positive values");
  });

  it("shows 'No data' message for empty line chart", () => {
    const config = JSON.stringify({
      type: "line",
      data: { labels: [], datasets: [] },
      options: {},
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    expect(svg).toContain("No line-series values");
  });

  it("truncates very long labels with ellipsis", () => {
    const longLabel = "A".repeat(50);
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: [longLabel],
        datasets: [{ label: "Data", data: [42] }],
      },
      options: {},
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // The label should be truncated with "..."
    expect(svg).toContain("...");
    // Full 50-char label should NOT appear
    expect(svg).not.toContain(longLabel);
  });

  it("escapes XML special characters in labels", () => {
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: ["A & B", "X < Y", "C > D"],
        datasets: [{ label: 'Test "quotes"', data: [10, 20, 30] }],
      },
      options: {
        plugins: { title: { display: true, text: "Special <chars> & entities" } },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // Raw & < > should be escaped
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&gt;");
    // No unescaped ampersand in text content (check there are no bare & followed by non-entity)
    // The SVG should be well-formed
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#)/);
  });

  it("handles stacked bar with all-zero values gracefully", () => {
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: ["A", "B"],
        datasets: [
          { label: "D1", data: [0, 0], backgroundColor: "#4e79a7" },
          { label: "D2", data: [0, 0], backgroundColor: "#e15759" },
        ],
      },
      options: {
        scales: { x: { stacked: true }, y: { stacked: true } },
      },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    // Should show "no data" or at least not crash
    expect(svg).toContain("No positive stacked values");
  });

  it("handles horizontal bar with single category", () => {
    const config = JSON.stringify({
      type: "bar",
      data: {
        labels: ["Only One"],
        datasets: [{ label: "Value", data: [42], backgroundColor: "#59a14f" }],
      },
      options: { indexAxis: "y" },
    });

    const svg = generateSvgFallbackChart(config, 900, 560).toString("utf-8");
    assertCleanSvg(svg);
    expect(svg).toContain("<rect");
    expect(svg).toContain("Only One");
  });
});
