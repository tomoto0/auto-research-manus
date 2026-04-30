import { describe, expect, it } from "vitest";
import { generateDefaultCharts, generateDefaultMetrics, generateSvgFallbackChart } from "./experiment-runner";
import { describeExperimentArtifact } from "./pipeline-engine";

describe("Artifact output regressions", () => {
  it("stores deterministic dataset analysis plans as JSON artifacts", () => {
    const descriptor = describeExperimentArtifact(JSON.stringify({
      methods: ["descriptive_statistics", "correlation"],
      blockedMethods: ["advanced_nlp"],
      topic: "Mental Health and Labour Market in UK",
    }));

    expect(descriptor.fileName).toBe("analysis_plan.json");
    expect(descriptor.storageFileName).toBe("analysis-plan.json");
    expect(descriptor.mimeType).toBe("application/json");
  });

  it("keeps free-form experiment code as Python artifacts", () => {
    const descriptor = describeExperimentArtifact("import pandas as pd\nprint('ok')\n");

    expect(descriptor.fileName).toBe("experiment.py");
    expect(descriptor.storageFileName).toBe("experiment.py");
    expect(descriptor.mimeType).toBe("text/x-python");
  });

  it("sanitises non-ASCII chart labels before SVG rendering", () => {
    const svg = generateSvgFallbackChart(JSON.stringify({
      type: "line",
      data: {
        labels: ["2021年", "2022年", "2023年"],
        datasets: [
          {
            label: "メンタルヘルス指標",
            data: [1.1, 1.4, 1.2],
          },
        ],
      },
      options: {
        plugins: {
          title: { display: true, text: "雇用とメンタルヘルスの推移" },
        },
        scales: {
          x: { title: { display: true, text: "年" } },
          y: { title: { display: true, text: "平均スコア" } },
        },
      },
    }), 900, 560).toString("utf-8");

    expect(svg).not.toMatch(/[^\x00-\x7F]/);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("prioritises topic-relevant variables over age for descriptive figures", () => {
    const charts = generateDefaultCharts([
      {
        name: "panel.csv",
        totalRows: 6,
        columns: ["pidp", "wave", "age", "ghq_score", "job_hours", "employment_shock"],
        data: [
          { pidp: 1, wave: 1, age: 28, ghq_score: 11, job_hours: 40, employment_shock: 0 },
          { pidp: 1, wave: 2, age: 29, ghq_score: 13, job_hours: 35, employment_shock: 1 },
          { pidp: 2, wave: 1, age: 41, ghq_score: 6, job_hours: 38, employment_shock: 0 },
          { pidp: 2, wave: 2, age: 42, ghq_score: 8, job_hours: 37, employment_shock: 0 },
          { pidp: 3, wave: 1, age: 36, ghq_score: 10, job_hours: 20, employment_shock: 1 },
          { pidp: 3, wave: 2, age: 37, ghq_score: 12, job_hours: 18, employment_shock: 1 },
        ],
      },
    ], null, "Mental Health and Labour Market in UK");

    const firstChart = charts.find(chart => chart.name === "distribution_histogram");
    expect(firstChart).toBeTruthy();
    expect(firstChart?.description.toLowerCase()).toContain("ghq");
    expect(firstChart?.description.toLowerCase()).not.toContain("age");
  });

  it("respects user-specified analysis inputs and records FE diagnostics", () => {
    const data = Array.from({ length: 12 }, (_, entityIndex) =>
      Array.from({ length: 4 }, (_, waveIndex) => {
        const pidp = entityIndex + 1;
        const wave = waveIndex + 1;
        const employmentShock =
          entityIndex % 2 === 0
            ? (wave >= 3 ? 1 : 0)
            : (wave === 4 ? 1 : 0);
        const jobHours = 42 - wave - (entityIndex % 3) + (wave === 4 && entityIndex % 2 === 0 ? 2 : 0);
        const ghqScore = 8 + entityIndex * 0.4 + wave * 0.5 + employmentShock * 1.8 + (entityIndex % 2) * 0.3;
        return {
          pidp,
          wave,
          ghq_score: ghqScore,
          employment_shock: employmentShock,
          job_hours: jobHours,
        };
      })
    ).flat();

    const metrics = generateDefaultMetrics([
      {
        name: "panel.csv",
        totalRows: data.length,
        columns: ["pidp", "wave", "ghq_score", "employment_shock", "job_hours"],
        data,
      },
    ], new Set(["robust_ols", "panel_fixed_effects"]), "Mental Health and Labour Market in UK", {
      outcome: "ghq_score",
      treatment: "employment_shock",
      entity: "pidp",
      time: "wave",
      controls: ["job_hours"],
    });

    expect(metrics.analysis_design_outcome).toBe("ghq_score");
    expect(metrics.analysis_design_treatment).toBe("employment_shock");
    expect(metrics.analysis_design_entity).toBe("pidp");
    expect(metrics.analysis_design_time).toBe("wave");
    expect(metrics.analysis_design_controls).toBe("job_hours");
    expect(metrics.panel_fe_gate_status).toBe("passed");
    expect(metrics.sample_waterfall_complete_case_panel_fe).toBe(data.length);
    const panelFeVcovKey = Object.keys(metrics).find(key => key.startsWith("panel_fe_vcov_"));
    const panelFeControlCountKey = Object.keys(metrics).find(key => key.startsWith("panel_fe_control_count_"));
    expect(panelFeVcovKey).toBeTruthy();
    expect(panelFeControlCountKey).toBeTruthy();
    expect(panelFeVcovKey ? metrics[panelFeVcovKey] : null).toBe("cluster");
    expect(panelFeControlCountKey ? metrics[panelFeControlCountKey] : null).toBe(1);
  });

  it("blocks panel FE when panel structure is not informative", () => {
    const data = Array.from({ length: 12 }, (_, entityIndex) => ({
      pidp: entityIndex + 1,
      wave: 1,
      ghq_score: 10 + entityIndex,
      employment_shock: entityIndex % 2,
      job_hours: 38 - (entityIndex % 4),
    }));

    const metrics = generateDefaultMetrics([
      {
        name: "cross_section.csv",
        totalRows: data.length,
        columns: ["pidp", "wave", "ghq_score", "employment_shock", "job_hours"],
        data,
      },
    ], new Set(["panel_fixed_effects"]), "Mental Health and Labour Market in UK", {
      outcome: "ghq_score",
      treatment: "employment_shock",
      entity: "pidp",
      time: "wave",
    });

    expect(metrics.panel_fe_gate_status).toBe("blocked");
    expect(String(metrics.panel_fe_gate_reason)).toContain("too few periods");
  });

  it("supports multivariate OLS with clustered SE and predictor imputation", () => {
    const data = Array.from({ length: 12 }, (_, entityIndex) =>
      Array.from({ length: 4 }, (_, waveIndex) => {
        const pidp = entityIndex + 1;
        const wave = waveIndex + 1;
        const employmentShock = wave >= 2 && entityIndex % 3 === 0 ? 1 : 0;
        return {
          pidp,
          wave,
          ghq_score: 12 + employmentShock * 1.4 + wave * 0.3 + entityIndex * 0.2,
          employment_shock: employmentShock,
          age: wave === 3 ? null : 25 + entityIndex,
          job_hours: wave === 2 && entityIndex % 2 === 0 ? null : 40 - wave - (entityIndex % 4),
        };
      })
    ).flat();

    const metrics = generateDefaultMetrics([
      {
        name: "panel_with_missing_controls.csv",
        totalRows: data.length,
        columns: ["pidp", "wave", "ghq_score", "employment_shock", "age", "job_hours"],
        data,
      },
    ], new Set(["robust_ols"]), "Mental Health and Labour Market in UK", {
      outcome: "ghq_score",
      treatment: "employment_shock",
      entity: "pidp",
      time: "wave",
      controls: ["age", "job_hours"],
      missingDataMode: "mean_imputation",
    });

    expect(metrics.analysis_missing_data_mode).toBe("mean_imputation");
    expect(metrics.sample_waterfall_imputed_predictor_cells_primary_regression).toBeGreaterThan(0);
    const controlCountKey = Object.keys(metrics).find(key => key.startsWith("robust_ols_control_count_"));
    const vcovKey = Object.keys(metrics).find(key => key.startsWith("robust_ols_vcov_"));
    const missingDataKey = Object.keys(metrics).find(key => key.startsWith("robust_ols_missing_data_"));
    expect(controlCountKey).toBeTruthy();
    expect(vcovKey).toBeTruthy();
    expect(missingDataKey).toBeTruthy();
    expect(controlCountKey ? metrics[controlCountKey] : null).toBe(2);
    expect(vcovKey ? metrics[vcovKey] : null).toBe("cluster");
    expect(missingDataKey ? metrics[missingDataKey] : null).toBe("mean_imputation");
  });

  it("supports multivariate quantile regression with bootstrap SE", () => {
    const data = Array.from({ length: 30 }, (_, entityIndex) =>
      Array.from({ length: 4 }, (_, waveIndex) => {
        const pidp = entityIndex + 1;
        const wave = waveIndex + 1;
        const employmentShock = wave >= 3 && entityIndex % 4 !== 0 ? 1 : 0;
        const age = wave === 2 && entityIndex % 5 === 0 ? null : 24 + entityIndex;
        const jobHours = 42 - wave - (entityIndex % 6);
        const outcomeNoise = ((entityIndex * 7 + wave * 3) % 11) / 10;
        return {
          pidp,
          wave,
          ghq_score: 9 + employmentShock * 1.2 + jobHours * 0.08 + (age === null ? 0 : age * 0.01) + outcomeNoise,
          employment_shock: employmentShock,
          age,
          job_hours: jobHours,
        };
      })
    ).flat();

    const metrics = generateDefaultMetrics([
      {
        name: "quantile_panel.csv",
        totalRows: data.length,
        columns: ["pidp", "wave", "ghq_score", "employment_shock", "age", "job_hours"],
        data,
      },
    ], new Set(["quantile_regression"]), "Mental Health and Labour Market in UK", {
      outcome: "ghq_score",
      treatment: "employment_shock",
      entity: "pidp",
      time: "wave",
      controls: ["age", "job_hours"],
      missingDataMode: "mean_imputation",
    });

    const seKey = Object.keys(metrics).find(key => key.startsWith("quantile_regression_se_q50_"));
    const vcovKey = Object.keys(metrics).find(key => key.startsWith("quantile_regression_vcov_"));
    const controlCountKey = Object.keys(metrics).find(key => key.startsWith("quantile_regression_control_count_"));
    const bootstrapKey = Object.keys(metrics).find(key => key.startsWith("quantile_regression_bootstrap_replicates_q50_"));
    expect(seKey).toBeTruthy();
    expect(vcovKey).toBeTruthy();
    expect(controlCountKey).toBeTruthy();
    expect(bootstrapKey).toBeTruthy();
    expect(seKey ? Number(metrics[seKey]) : 0).toBeGreaterThan(0);
    expect(vcovKey ? metrics[vcovKey] : null).toBe("bootstrap");
    expect(controlCountKey ? metrics[controlCountKey] : null).toBe(2);
    expect(bootstrapKey ? Number(metrics[bootstrapKey]) : 0).toBeGreaterThanOrEqual(12);
  });
});
