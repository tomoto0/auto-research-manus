/**
 * 23-Stage Research Pipeline Engine
 * Orchestrates the full autonomous research pipeline using LLM and literature search
 * Supports manual approval mode: pauses after each stage for user review
 * Supports dataset-driven experiments: uploads data files, generates analysis code, executes Python
 */
import { invokeLLM } from "./_core/llm";
import { PIPELINE_STAGES, type AnalysisInputs, RunConfig, PipelineEvent } from "../shared/pipeline";
import * as db from "./db";
import { unifiedSearch, type LiteratureResult } from "./literature";
import { storagePut, storageGet } from "./storage";
import { notifyOwner } from "./_core/notification";
import { nanoid } from "nanoid";
import { generatePaperPdf, type ChartImage } from "./pdf-generator";
import { executePythonExperiment, type DatasetInfo, type ExperimentOutput, type ExperimentProgressUpdate } from "./experiment-runner";
import { isWorkerExecutionMode } from "./_core/pipeline-execution";

async function notifyPipelineOwner(title: string, content: string): Promise<void> {
  try {
    await notifyOwner({ title, content });
  } catch (error) {
    console.warn("[Pipeline] Owner notification failed:", error);
  }
}

export type EventEmitter = (event: PipelineEvent) => void;

interface PipelineContext {
  runId: string;
  topic: string;
  config: RunConfig;
  emit: EventEmitter;
  papers: LiteratureResult[];
  hypothesis: string;
  methodology: string;
  methodValidation: string;
  experimentCode: string;
  experimentResults: string;
  statisticalAnalysis: string;
  figures: string[];
  tables: string[];
  outline: string;
  abstract: string;
  paperBody: string;
  references: string;
  latex: string;
  reviewReport: string;
  revision: string;
  finalPaper: string;
  // Dataset-driven experiment fields
  datasetFiles: DatasetInfo[];
  experimentOutput: ExperimentOutput | null;
  evidenceProfile: ResearchEvidenceProfile | null;
  methodContract: MethodFeasibilityContract | null;
  executionDiagnostics: ExecutionDiagnostics | null;
  methodIntegrityNote: string;
  claimVerificationReport: string;
}

interface ResearchEvidenceProfile {
  datasetSummary: {
    datasetCount: number;
    totalRowsHint: number;
    hasTimeLike: boolean;
    hasTextLike: boolean;
    hasPanelLike: boolean;
    hasGraphLike: boolean;
    hasImageLike: boolean;
    hasGroupLike: boolean;
    hasTreatmentLike: boolean;
    hasOutcomeLike: boolean;
    hasInstrumentLike: boolean;
    hasRunningLike: boolean;
    hasContinuousLike: boolean;
  };
  literatureSummary: {
    paperCount: number;
    topMethodSignals: Record<string, number>;
  };
  recommendedExecutableMethods: string[];
  constrainedMethods: string[];
}

interface MethodFeasibilityContract {
  executableNow: string[];
  requiresMissingData: string[];
  futureWorkOnly: string[];
  blockedReasons: Record<string, string>;
  evidenceNotes: string[];
}

interface ExecutionDiagnostics {
  executionStatus: "success" | "partial" | "failed";
  executableRequested: string[];
  executedMethods: string[];
  missingRequested: string[];
  analyticalMetricCount: number;
  chartCount: number;
  tableCount: number;
  failureReasons: string[];
}

interface ClaimVerificationResult {
  report: string;
  flaggedClaims: string[];
}

export function describeExperimentArtifact(experimentCode: string): {
  fileName: string;
  storageFileName: string;
  mimeType: string;
} {
  const trimmed = (experimentCode || "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return {
        fileName: "analysis_plan.json",
        storageFileName: "analysis-plan.json",
        mimeType: "application/json",
      };
    } catch {}
  }
  return {
    fileName: "experiment.py",
    storageFileName: "experiment.py",
    mimeType: "text/x-python",
  };
}

// ─── Approval tracking for manual mode ───
// Maps runId -> { resolve, reject } for the currently awaiting approval
const approvalWaiters = new Map<string, {
  resolve: (editedOutput?: string) => void;
  reject: (reason?: string) => void;
}>();

/** Approve a stage and optionally provide edited output */
export function approveStage(runId: string, editedOutput?: string): boolean {
  const waiter = approvalWaiters.get(runId);
  if (!waiter) return false;
  waiter.resolve(editedOutput);
  approvalWaiters.delete(runId);
  return true;
}

/** Reject a stage and stop the pipeline */
export function rejectStage(runId: string, reason?: string): boolean {
  const waiter = approvalWaiters.get(runId);
  if (!waiter) return false;
  waiter.reject(reason || "Stage rejected by user");
  approvalWaiters.delete(runId);
  return true;
}

/** Check if a run is currently awaiting approval */
export function isAwaitingApproval(runId: string): boolean {
  return approvalWaiters.has(runId);
}

async function callLLM(systemPrompt: string, userPrompt: string, maxTokens?: number): Promise<string> {
  const result = await invokeLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    maxTokens: maxTokens || 16384,
  });
  const content = result.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Strip markdown code block markers from LLM output.
 * Handles ```latex, ```python, ```tex, ```bibtex, and generic ``` markers.
 */
function stripCodeBlockMarkers(text: string): string {
  if (!text) return text;
  // Remove opening ```lang markers and closing ``` markers
  let cleaned = text.trim();
  // Match opening code fence with optional language tag
  cleaned = cleaned.replace(/^```(?:latex|tex|python|bibtex|json|\w*)\s*\n?/i, "");
  // Match closing code fence at the end
  cleaned = cleaned.replace(/\n?```\s*$/i, "");
  return cleaned.trim();
}

// ─── Helper: Infer research field from topic, data, and literature ───
function inferResearchField(ctx: PipelineContext): string {
  const topic = (ctx.topic || "").toLowerCase();
  const paperText = ctx.papers.map(p => `${p.title || ""} ${p.abstract || ""}`).join(" ").toLowerCase();
  const allCols = ctx.datasetFiles.flatMap(ds => ds.columnNames || []).join(" ").toLowerCase();
  const combined = `${topic} ${paperText} ${allCols}`;

  // Check target conference first — if user explicitly chose a venue, use its field
  const conf = (ctx.config.targetConference || "").toLowerCase();
  if (["neurips", "icml", "iclr", "aaai"].includes(conf)) return "machine learning / artificial intelligence";
  if (["acl", "emnlp"].includes(conf)) return "natural language processing / computational linguistics";
  if (["cvpr"].includes(conf)) return "computer vision";
  if (["aer", "qje", "econometrica"].includes(conf)) return "economics";
  if (["lancet", "nejm", "bmj"].includes(conf)) return "medicine / public health";
  if (["nature", "science", "pnas"].includes(conf)) return "natural sciences";
  if (["apa"].includes(conf)) return "psychology / social sciences";
  if (["aera"].includes(conf)) return "education";
  if (["agu"].includes(conf)) return "environmental / earth sciences";
  if (["ieee"].includes(conf)) return "engineering";

  // Auto-detect from topic + literature + data columns
  if (/(neural network|deep learning|transformer|bert|gpt|llm|reinforcement learning|generative model|diffusion model|foundation model)/i.test(combined))
    return "machine learning / artificial intelligence";
  if (/(gdp|inflation|monetary|fiscal|trade|macroeconom|microeconom|labor market|wage|price elast|econometr)/i.test(combined))
    return "economics";
  if (/(patient|clinical|disease|treatment|drug|mortality|hospital|epidemiol|symptom|diagnosis|biomarker|cohort study)/i.test(combined))
    return "medicine / public health";
  if (/(gene|protein|genome|molecular|cell|phylogen|evolution|enzyme|dna|rna|bioinform)/i.test(combined))
    return "biology / life sciences";
  if (/(climate|environment|pollution|ecosystem|biodiversity|carbon|emission|sustainability|conservation)/i.test(combined))
    return "environmental science";
  if (/(education|student|teacher|curriculum|school|pedagog|learning outcome|academic achievement)/i.test(combined))
    return "education";
  if (/(psychology|cognitive|behavior|mental health|personality|perception|emotion|well.?being|anxiety|depression)/i.test(combined))
    return "psychology";
  if (/(sociology|social|inequality|demograph|migration|community|ethnograph|gender|race|class)/i.test(combined))
    return "sociology / social sciences";
  if (/(politic|election|democracy|governance|policy|legislation|voting|parliament|geopolit)/i.test(combined))
    return "political science";
  if (/(law|legal|regulation|constitutional|judicial|court|statute|compliance)/i.test(combined))
    return "law / legal studies";
  if (/(material|polymer|semiconductor|nanotechnology|crystal|alloy|composite|thin film)/i.test(combined))
    return "materials science / engineering";
  if (/(robot|autonomous|sensor|signal processing|circuit|wireless|antenna|vlsi)/i.test(combined))
    return "electrical engineering / robotics";
  if (/(urban|city|transport|infrastructure|land use|real estate|housing|spatial)/i.test(combined))
    return "urban studies / planning";
  if (/(agriculture|crop|soil|livestock|food security|farm|irrigation)/i.test(combined))
    return "agricultural science";
  if (/(marketing|consumer|brand|advertis|purchase|customer|retail|e-commerce)/i.test(combined))
    return "marketing / business";
  if (/(finance|stock|portfolio|asset pricing|risk|banking|credit|investment)/i.test(combined))
    return "finance";
  if (/(management|organisation|leadership|hrm|strategic|supply chain|operation)/i.test(combined))
    return "management / organisational studies";

  return "interdisciplinary research";
}

function buildFieldContext(ctx: PipelineContext): string {
  const field = inferResearchField(ctx);
  const conf = ctx.config.targetConference || "General";
  if (conf === "General") {
    return `The research field is ${field}. Adapt your writing style, methodology norms, citation practices, and terminology to match conventions in ${field}.`;
  }
  return `The target venue is ${conf} in the field of ${field}. Follow the conventions and expectations of this venue.`;
}

// ─── Helper: Build dataset description for LLM prompts ───
function buildDatasetDescription(datasets: DatasetInfo[]): string {
  if (datasets.length === 0) return "";
  return datasets.map((ds, i) => {
    const cols = ds.columnNames?.join(", ") || "unknown columns";
    let desc = `Dataset ${i + 1}: "${ds.originalName}" (${ds.fileType}, ${ds.rowCount ?? "?"} rows)\n  Columns: ${cols}`;
    if (!ds.columnNames || ds.columnNames.length === 0) {
      desc += "\n  NOTE: Column names could not be extracted at upload time. The analysis engine will parse the file at runtime and use actual column names.";
    }
    return desc;
  }).join("\n");
}

function buildDatasetCapabilityHints(datasets: DatasetInfo[]): string {
  if (datasets.length === 0) return "";
  return datasets.map((ds, i) => {
    const cols = ds.columnNames || [];
    const colText = cols.length > 0 ? cols.join(", ") : "unknown";
    const hasTimeLike = cols.some(c => /(year|month|date|time|wave|period|quarter)/i.test(c));
    const hasTextLike = cols.some(c => /(text|comment|abstract|title|description|review|note)/i.test(c));
    return `Dataset ${i + 1}: ${ds.originalName}\n- Rows: ${ds.rowCount ?? "unknown"}\n- Columns: ${cols.length || "unknown"}\n- Time-like columns detected: ${hasTimeLike ? "yes" : "no"}\n- Text-like columns detected: ${hasTextLike ? "yes" : "no"}\n- Column names: ${colText}`;
  }).join("\n\n");
}

function hasAnalysisInputs(inputs?: AnalysisInputs): boolean {
  if (!inputs) return false;
  return Boolean(
    inputs.outcome ||
    inputs.treatment ||
    inputs.entity ||
    inputs.time ||
    inputs.subgroup ||
    inputs.missingDataMode ||
    inputs.missingDataStrategy ||
    inputs.variableNotes ||
    (inputs.controls && inputs.controls.length > 0)
  );
}

function buildAnalysisInputContext(inputs?: AnalysisInputs): string {
  if (!hasAnalysisInputs(inputs)) return "";
  const lines = [
    "User-specified research variable mapping (treat as higher-priority than heuristics when feasible):",
    `- Outcome variable: ${inputs?.outcome || "not specified"}`,
    `- Treatment variable: ${inputs?.treatment || "not specified"}`,
    `- Entity / panel ID: ${inputs?.entity || "not specified"}`,
    `- Time variable: ${inputs?.time || "not specified"}`,
    `- Control variables: ${inputs?.controls?.join(", ") || "not specified"}`,
    `- Subgroup variable: ${inputs?.subgroup || "not specified"}`,
    `- Missing-data mode: ${inputs?.missingDataMode || "complete_case"}`,
    `- Missing-data strategy: ${inputs?.missingDataStrategy || "not specified"}`,
  ];
  if (inputs?.variableNotes) {
    lines.push(`- Variable notes: ${inputs.variableNotes}`);
  }
  lines.push(
    "- If a specified column is absent from the uploaded data, explicitly say so and downgrade the relevant method instead of inventing a substitute.",
  );
  return `\n\n${lines.join("\n")}`;
}

function normaliseMethodId(raw: string): string {
  const norm = (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliases: Record<string, string> = {
    descriptive: "descriptive_statistics",
    descriptive_stats: "descriptive_statistics",
    descriptive_statistics: "descriptive_statistics",
    summary_statistics: "descriptive_statistics",
    correlation_analysis: "correlation",
    pearson_correlation: "correlation",
    correlation: "correlation",
    linear_regression: "linear_regression",
    regression: "linear_regression",
    ols: "linear_regression",
    group_comparison: "group_comparison",
    anova: "group_comparison",
    t_test: "group_comparison",
    time_trend: "time_trend",
    time_series_trend: "time_trend",
    text_analysis: "text_feature_analysis",
    text_feature_analysis: "text_feature_analysis",
    nlp: "text_feature_analysis",
    data_visualization: "data_visualisation",
    data_visualisation: "data_visualisation",
    visualization: "data_visualisation",
    visualisation: "data_visualisation",
    causal_inference: "causal_inference",
    robust_regression: "robust_ols",
    robust_ols: "robust_ols",
    heteroskedasticity_robust_ols: "robust_ols",
    hc_robust_ols: "robust_ols",
    fixed_effects: "panel_fixed_effects",
    fixed_effect: "panel_fixed_effects",
    two_way_fixed_effects: "panel_fixed_effects",
    twfe: "panel_fixed_effects",
    panel_fixed_effects: "panel_fixed_effects",
    difference_in_differences: "diff_in_diff",
    diff_in_diff: "diff_in_diff",
    did: "diff_in_diff",
    event_study: "event_study",
    synthetic_control_method: "synthetic_control",
    synthetic_control: "synthetic_control",
    synthetic_controls: "synthetic_control",
    iv: "iv_2sls",
    instrumental_variables: "iv_2sls",
    instrumental_variable: "iv_2sls",
    two_stage_least_squares: "iv_2sls",
    iv_2sls: "iv_2sls",
    regression_discontinuity_design: "regression_discontinuity",
    regression_discontinuity: "regression_discontinuity",
    rdd: "regression_discontinuity",
    propensity_score_matching: "propensity_score",
    propensity_score_weighting: "propensity_score",
    propensity_score: "propensity_score",
    quantile_regression: "quantile_regression",
    graph_neural_network: "graph_modelling",
    gnn: "graph_modelling",
    graph_modelling: "graph_modelling",
    computer_vision: "vision_analysis",
    vision_analysis: "vision_analysis",
    panel_model: "panel_econometrics",
    panel_econometrics: "panel_econometrics",
    structural_equation_modelling: "panel_econometrics",
    advanced_time_series: "advanced_time_series",
    arima_var_lstm: "advanced_time_series",
    advanced_nlp_deep_learning: "advanced_nlp",
    advanced_nlp: "advanced_nlp",
  };
  return aliases[norm] || norm;
}

function uniqMethodIds(items: string[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    const m = normaliseMethodId(item);
    if (m) set.add(m);
  }
  return Array.from(set);
}

function buildLiteratureMethodSignals(papers: LiteratureResult[]): Record<string, number> {
  const signals: Record<string, number> = {
    descriptive_statistics: 0,
    correlation: 0,
    linear_regression: 0,
    robust_ols: 0,
    group_comparison: 0,
    time_trend: 0,
    text_feature_analysis: 0,
    causal_inference: 0,
    diff_in_diff: 0,
    event_study: 0,
    synthetic_control: 0,
    iv_2sls: 0,
    regression_discontinuity: 0,
    graph_modelling: 0,
    vision_analysis: 0,
    panel_econometrics: 0,
    panel_fixed_effects: 0,
    advanced_time_series: 0,
    quantile_regression: 0,
    advanced_nlp: 0,
  };
  for (const p of papers) {
    const text = `${p.title || ""} ${p.abstract || ""}`.toLowerCase();
    if (/(descriptive|summary statistics|distribution)/i.test(text)) signals.descriptive_statistics++;
    if (/(correlation|association|pearson|spearman)/i.test(text)) signals.correlation++;
    if (/(regression|ols|glm|logit|probit)/i.test(text)) signals.linear_regression++;
    if (/(heteroskedasticity[- ]robust|robust standard errors|sandwich estimator|hc1|hc3)/i.test(text)) signals.robust_ols++;
    if (/(anova|t-test|between-group|group comparison|treatment group)/i.test(text)) signals.group_comparison++;
    if (/(time trend|temporal trend|panel year|longitudinal trend)/i.test(text)) signals.time_trend++;
    if (/(text mining|nlp|sentiment|topic model|keyword extraction)/i.test(text)) signals.text_feature_analysis++;
    if (/(causal|difference-in-differences|instrumental variable|propensity score|rdd|synthetic control)/i.test(text)) signals.causal_inference++;
    if (/(difference-in-differences|did\b|two-way fixed effects)/i.test(text)) signals.diff_in_diff++;
    if (/(event study|dynamic treatment effect|relative time)/i.test(text)) signals.event_study++;
    if (/(synthetic control|synthetic controls|donor pool)/i.test(text)) signals.synthetic_control++;
    if (/(instrumental variable|2sls|two-stage least squares|local average treatment effect)/i.test(text)) signals.iv_2sls++;
    if (/(regression discontinuity|rdd\b|running variable|forcing variable)/i.test(text)) signals.regression_discontinuity++;
    if (/(graph neural|gnn|network model|graph convolution|edge|node)/i.test(text)) signals.graph_modelling++;
    if (/(computer vision|image classification|visual recognition|cnn)/i.test(text)) signals.vision_analysis++;
    if (/(panel model|fixed effects|random effects|sem|structural equation|gmm)/i.test(text)) signals.panel_econometrics++;
    if (/(fixed effects|within estimator|panel fixed effects|two-way fixed effects)/i.test(text)) signals.panel_fixed_effects++;
    if (/(arima|var\b|state space model|lstm|forecasting)/i.test(text)) signals.advanced_time_series++;
    if (/(quantile regression|conditional quantile)/i.test(text)) signals.quantile_regression++;
    if (/(transformer|bert|deep learning|neural network|embedding model|large language model)/i.test(text)) signals.advanced_nlp++;
  }
  return signals;
}

function buildResearchEvidenceProfile(topic: string, datasets: DatasetInfo[], papers: LiteratureResult[]): ResearchEvidenceProfile {
  const allCols = datasets.flatMap(ds => ds.columnNames || []).map(c => c.toLowerCase());
  const hasTimeLike = allCols.some(c => /(year|month|date|time|wave|period|quarter)/i.test(c));
  const hasTextLike = allCols.some(c => /(text|comment|abstract|title|description|review|note|content)/i.test(c));
  const hasGraphLike = allCols.some(c => /(node|edge|source|target|network|graph)/i.test(c));
  const hasImageLike = allCols.some(c => /(image|img|pixel|vision|frame|video|path)/i.test(c));
  const hasPanelLike = hasTimeLike && allCols.some(c => /(id|code|entity|respondent|household|firm|user|patient)/i.test(c));
  const hasGroupLike = allCols.some(c => /(group|category|class|type|segment|gender|sex|region|prefecture|country|state|city|occupation|industry|cohort)/i.test(c));
  const hasTreatmentLike = allCols.some(c => /(treat|treatment|intervention|policy|program|exposure|assignment)/i.test(c));
  const hasOutcomeLike = allCols.some(c => /(outcome|target|response|score|rate|risk|income|wage|price|cost|value|metric|performance)/i.test(c));
  const hasInstrumentLike = allCols.some(c => /(instrument|iv|encouragement|eligib|distance|shiftshare|shock|assignment)/i.test(c));
  const hasRunningLike = allCols.some(c => /(running|forcing|cutoff|threshold|score|distance|margin|rank)/i.test(c));
  const hasContinuousLike = allCols.some(c => /(score|rate|ratio|index|income|wage|price|cost|count|amount|duration|age|height|weight|value|metric|measure)/i.test(c));
  const totalRowsHint = datasets.reduce((sum, ds) => sum + (ds.rowCount || 0), 0);
  const methodSignals = buildLiteratureMethodSignals(papers);

  const recommendedExecutableMethods = uniqMethodIds([
    datasets.length > 0 ? "descriptive_statistics" : "",
    datasets.length > 0 ? "correlation" : "",
    totalRowsHint >= 30 && (hasContinuousLike || allCols.length >= 3) ? "linear_regression" : "",
    totalRowsHint >= 40 && (hasContinuousLike || allCols.length >= 4) ? "robust_ols" : "",
    hasTimeLike ? "time_trend" : "",
    hasTextLike ? "text_feature_analysis" : "",
    datasets.length > 0 ? "data_visualisation" : "",
    hasGroupLike ? "group_comparison" : "",
    hasPanelLike && totalRowsHint >= 120 ? "panel_fixed_effects" : "",
    hasTreatmentLike && hasOutcomeLike && hasTimeLike && totalRowsHint >= 80 ? "diff_in_diff" : "",
    hasTreatmentLike && hasOutcomeLike && hasTimeLike && hasPanelLike && totalRowsHint >= 120 ? "event_study" : "",
    hasTreatmentLike && hasOutcomeLike && hasTimeLike && hasPanelLike && totalRowsHint >= 120 ? "synthetic_control" : "",
    hasInstrumentLike && hasTreatmentLike && (hasOutcomeLike || hasContinuousLike) && totalRowsHint >= 120 ? "iv_2sls" : "",
    hasRunningLike && hasTreatmentLike && (hasOutcomeLike || hasContinuousLike) && totalRowsHint >= 140 ? "regression_discontinuity" : "",
    hasTreatmentLike && (hasOutcomeLike || hasContinuousLike) && hasContinuousLike && totalRowsHint >= 120 ? "propensity_score" : "",
    hasContinuousLike && totalRowsHint >= 120 ? "quantile_regression" : "",
  ].filter(Boolean));

  const constrainedMethods = uniqMethodIds([
    !hasTextLike || totalRowsHint < 300 ? "advanced_nlp" : "",
    !hasGraphLike ? "graph_modelling" : "",
    !hasImageLike ? "vision_analysis" : "",
    !hasPanelLike || totalRowsHint < 120 ? "panel_econometrics" : "",
    !hasTimeLike || totalRowsHint < 120 ? "advanced_time_series" : "",
    !(hasOutcomeLike && totalRowsHint >= 200) ? "causal_inference" : "",
    !(hasInstrumentLike && hasTreatmentLike && (hasOutcomeLike || hasContinuousLike) && totalRowsHint >= 120) ? "iv_2sls" : "",
    !(hasRunningLike && hasTreatmentLike && (hasOutcomeLike || hasContinuousLike) && totalRowsHint >= 140) ? "regression_discontinuity" : "",
    !(hasTreatmentLike && (hasOutcomeLike || hasContinuousLike) && hasContinuousLike && totalRowsHint >= 120) ? "propensity_score" : "",
    !(hasContinuousLike && totalRowsHint >= 120) ? "quantile_regression" : "",
  ].filter(Boolean));

  return {
    datasetSummary: {
      datasetCount: datasets.length,
      totalRowsHint,
      hasTimeLike,
      hasTextLike,
      hasPanelLike,
      hasGraphLike,
      hasImageLike,
      hasGroupLike,
      hasTreatmentLike,
      hasOutcomeLike,
      hasInstrumentLike,
      hasRunningLike,
      hasContinuousLike,
    },
    literatureSummary: {
      paperCount: papers.length,
      topMethodSignals: methodSignals,
    },
    recommendedExecutableMethods,
    constrainedMethods,
  };
}

function buildMethodologyApplicabilityGuide(profile: ResearchEvidenceProfile): string {
  const d = profile.datasetSummary;
  const rowsHint = d.totalRowsHint || 0;
  const methodLines = [
    `- descriptive_statistics: ${d.datasetCount > 0 ? "executable_now" : "blocked"} | prereq: tabular rows >= 10 | evidence: datasets=${d.datasetCount}, rows~${rowsHint}`,
    `- correlation: ${d.datasetCount > 0 ? "executable_now" : "blocked"} | prereq: >=2 numeric measures with paired values | evidence: datasets=${d.datasetCount}`,
    `- linear_regression: ${rowsHint >= 30 ? "executable_now" : "partially_ready"} | prereq: rows >= 30 + meaningful dependent/independent variables | evidence: rows~${rowsHint}`,
    `- robust_ols: ${rowsHint >= 40 ? "executable_now" : "partially_ready"} | prereq: OLS-ready data + heteroskedasticity-robust inference | evidence: rows~${rowsHint}`,
    `- group_comparison: ${d.hasGroupLike ? "executable_now" : "partially_ready"} | prereq: categorical groups + numeric outcome | evidence: group_like=${d.hasGroupLike ? "yes" : "no"}`,
    `- time_trend: ${d.hasTimeLike ? "executable_now" : "blocked"} | prereq: explicit time index + numeric outcome | evidence: time_like=${d.hasTimeLike ? "yes" : "no"}`,
    `- text_feature_analysis: ${d.hasTextLike ? "executable_now" : "blocked"} | prereq: text columns + adequate text volume | evidence: text_like=${d.hasTextLike ? "yes" : "no"}`,
    `- panel_fixed_effects: ${d.hasPanelLike && rowsHint >= 120 ? "executable_now" : "blocked"} | prereq: entity id + time index + within-unit variation | evidence: panel_like=${d.hasPanelLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- diff_in_diff: ${d.hasTreatmentLike && d.hasOutcomeLike && d.hasTimeLike && rowsHint >= 80 ? "executable_now" : "blocked"} | prereq: treated/control structure + pre/post window | evidence: treatment_like=${d.hasTreatmentLike ? "yes" : "no"}, outcome_like=${d.hasOutcomeLike ? "yes" : "no"}, time_like=${d.hasTimeLike ? "yes" : "no"}`,
    `- event_study: ${d.hasTreatmentLike && d.hasOutcomeLike && d.hasTimeLike && d.hasPanelLike && rowsHint >= 120 ? "executable_now" : "blocked"} | prereq: staggered or well-defined treatment timing + pre/post support | evidence: treatment_like=${d.hasTreatmentLike ? "yes" : "no"}, panel_like=${d.hasPanelLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- synthetic_control: ${d.hasTreatmentLike && d.hasOutcomeLike && d.hasTimeLike && d.hasPanelLike && rowsHint >= 120 ? "executable_now" : "blocked"} | prereq: identifiable treated unit(s) + donor pool + pre-period fit | evidence: treatment_like=${d.hasTreatmentLike ? "yes" : "no"}, panel_like=${d.hasPanelLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- advanced_time_series: ${d.hasTimeLike && rowsHint >= 120 ? "partially_ready" : "blocked"} | prereq: long time horizon + stationarity diagnostics | evidence: time_like=${d.hasTimeLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- panel_econometrics: ${d.hasPanelLike && rowsHint >= 120 ? "partially_ready" : "blocked"} | prereq: entity id + time panel + sufficient entities | evidence: panel_like=${d.hasPanelLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- causal_inference: ${d.hasTreatmentLike && d.hasOutcomeLike && d.hasTimeLike ? "partially_ready" : "blocked"} | prereq: identification strategy + treatment/outcome + assumptions | evidence: treatment_like=${d.hasTreatmentLike ? "yes" : "no"}, outcome_like=${d.hasOutcomeLike ? "yes" : "no"}, time_like=${d.hasTimeLike ? "yes" : "no"}`,
    `- iv_2sls: ${d.hasInstrumentLike && d.hasTreatmentLike && (d.hasOutcomeLike || d.hasContinuousLike) && rowsHint >= 120 ? "executable_now" : "blocked"} | prereq: valid instrument + first-stage strength + exclusion restriction | evidence: instrument_like=${d.hasInstrumentLike ? "yes" : "no"}, treatment_like=${d.hasTreatmentLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- regression_discontinuity: ${d.hasRunningLike && d.hasTreatmentLike && (d.hasOutcomeLike || d.hasContinuousLike) && rowsHint >= 140 ? "executable_now" : "blocked"} | prereq: running variable + cutoff + local continuity assumptions | evidence: running_like=${d.hasRunningLike ? "yes" : "no"}, treatment_like=${d.hasTreatmentLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- propensity_score: ${d.hasTreatmentLike && (d.hasOutcomeLike || d.hasContinuousLike) && d.hasContinuousLike && rowsHint >= 120 ? "executable_now" : "blocked"} | prereq: treatment assignment model + overlap/balance | evidence: treatment_like=${d.hasTreatmentLike ? "yes" : "no"}, continuous_like=${d.hasContinuousLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- quantile_regression: ${d.hasContinuousLike && rowsHint >= 120 ? "executable_now" : "blocked"} | prereq: continuous outcome + adequate tail support | evidence: continuous_like=${d.hasContinuousLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- advanced_nlp: ${d.hasTextLike && rowsHint >= 300 ? "partially_ready" : "blocked"} | prereq: large text corpus + validation resources | evidence: text_like=${d.hasTextLike ? "yes" : "no"}, rows~${rowsHint}`,
    `- graph_modelling: ${d.hasGraphLike ? "partially_ready" : "blocked"} | prereq: explicit node/edge structure | evidence: graph_like=${d.hasGraphLike ? "yes" : "no"}`,
    `- vision_analysis: ${d.hasImageLike ? "partially_ready" : "blocked"} | prereq: image assets/features + labels | evidence: image_like=${d.hasImageLike ? "yes" : "no"}`,
  ];
  return methodLines.join("\n");
}

function ensureEvidenceProfile(ctx: PipelineContext): ResearchEvidenceProfile {
  if (!ctx.evidenceProfile) {
    ctx.evidenceProfile = buildResearchEvidenceProfile(ctx.topic, ctx.datasetFiles, ctx.papers);
  }
  return ctx.evidenceProfile;
}

function extractJsonBetweenTags(text: string, tagName: string): string | null {
  const regex = new RegExp(`\\[${tagName}\\]([\\s\\S]*?)\\[\\/${tagName}\\]`, "i");
  const m = text.match(regex);
  if (!m) return null;
  return m[1].trim();
}

function deriveFallbackMethodContract(methodologyText: string, profile: ResearchEvidenceProfile): MethodFeasibilityContract {
  const lower = (methodologyText || "").toLowerCase();
  const executable = new Set<string>(profile.recommendedExecutableMethods);
  const requiresMissing = new Set<string>();
  const futureOnly = new Set<string>(profile.constrainedMethods);
  const blockedReasons: Record<string, string> = {};

  if (/(regression|ols|logit|probit)/i.test(lower)) executable.add("linear_regression");
  if (/(robust standard errors|robust ols|hc1|hc3|heteroskedasticity[- ]robust)/i.test(lower)) executable.add("robust_ols");
  if (/(correlation|association|pearson|spearman)/i.test(lower)) executable.add("correlation");
  if (/(anova|t-test|group comparison|between-group)/i.test(lower)) executable.add("group_comparison");
  if (/(time trend|time-series|arima|var\b|lstm)/i.test(lower)) {
    if (profile.datasetSummary.hasTimeLike) executable.add("time_trend");
    else {
      requiresMissing.add("advanced_time_series");
      blockedReasons.advanced_time_series = "No reliable temporal fields detected in uploaded datasets.";
    }
  }
  if (/(nlp|text mining|sentiment|topic model|transformer|bert|embedding)/i.test(lower)) {
    if (profile.datasetSummary.hasTextLike) executable.add("text_feature_analysis");
    else {
      requiresMissing.add("advanced_nlp");
      blockedReasons.advanced_nlp = "No text-like columns were detected in uploaded datasets.";
    }
  }
  if (/(graph neural|gnn|network embedding|graph convolution)/i.test(lower)) {
    requiresMissing.add("graph_modelling");
    blockedReasons.graph_modelling = "No graph structure (node/edge columns) was detected in uploaded datasets.";
  }
  if (/(computer vision|image model|cnn|visual analysis)/i.test(lower)) {
    requiresMissing.add("vision_analysis");
    blockedReasons.vision_analysis = "No image paths/pixel features were detected in uploaded datasets.";
  }
  if (/(causal|difference-in-differences|instrumental variable|propensity score|rdd|synthetic control)/i.test(lower)) {
    requiresMissing.add("causal_inference");
    blockedReasons.causal_inference = "Current data/identification assumptions are insufficient for robust causal claims.";
  }
  if (/(fixed effects|within estimator|two-way fixed effects|twfe)/i.test(lower)) {
    if (profile.datasetSummary.hasPanelLike && profile.datasetSummary.totalRowsHint >= 120) executable.add("panel_fixed_effects");
    else {
      requiresMissing.add("panel_fixed_effects");
      blockedReasons.panel_fixed_effects = "Panel fixed effects requires entity-time panel structure with sufficient repeated observations.";
    }
  }
  if (/(difference-in-differences|did\b)/i.test(lower)) {
    if (profile.datasetSummary.hasTreatmentLike && profile.datasetSummary.hasOutcomeLike && profile.datasetSummary.hasTimeLike && profile.datasetSummary.totalRowsHint >= 80) executable.add("diff_in_diff");
    else {
      requiresMissing.add("diff_in_diff");
      blockedReasons.diff_in_diff = "Difference-in-differences requires treated/control structure, outcome variables, and pre/post timing support.";
    }
  }
  if (/(event study|dynamic treatment effect|relative time)/i.test(lower)) {
    if (profile.datasetSummary.hasTreatmentLike && profile.datasetSummary.hasOutcomeLike && profile.datasetSummary.hasTimeLike && profile.datasetSummary.hasPanelLike && profile.datasetSummary.totalRowsHint >= 120) executable.add("event_study");
    else {
      requiresMissing.add("event_study");
      blockedReasons.event_study = "Event-study analysis requires panel timing structure with sufficient pre/post support.";
    }
  }
  if (/(synthetic control|synthetic controls)/i.test(lower)) {
    if (profile.datasetSummary.hasTreatmentLike && profile.datasetSummary.hasOutcomeLike && profile.datasetSummary.hasTimeLike && profile.datasetSummary.hasPanelLike && profile.datasetSummary.totalRowsHint >= 120) executable.add("synthetic_control");
    else {
      requiresMissing.add("synthetic_control");
      blockedReasons.synthetic_control = "Synthetic control requires a treated unit, donor pool, and pre-treatment panel outcome history.";
    }
  }
  if (/(instrumental variable|2sls|two-stage least squares)/i.test(lower)) {
    if (profile.datasetSummary.hasInstrumentLike && profile.datasetSummary.hasTreatmentLike && (profile.datasetSummary.hasOutcomeLike || profile.datasetSummary.hasContinuousLike) && profile.datasetSummary.totalRowsHint >= 120) executable.add("iv_2sls");
    else {
      requiresMissing.add("iv_2sls");
      blockedReasons.iv_2sls = "No validated instrument field or exclusion-restriction evidence was detected in the current data metadata.";
    }
  }
  if (/(regression discontinuity|rdd\b|forcing variable|running variable)/i.test(lower)) {
    if (profile.datasetSummary.hasRunningLike && profile.datasetSummary.hasTreatmentLike && (profile.datasetSummary.hasOutcomeLike || profile.datasetSummary.hasContinuousLike) && profile.datasetSummary.totalRowsHint >= 140) executable.add("regression_discontinuity");
    else {
      requiresMissing.add("regression_discontinuity");
      blockedReasons.regression_discontinuity = "No explicit running variable and cutoff structure was detected in the current data metadata.";
    }
  }
  if (/(propensity score|inverse probability weighting|matching estimator)/i.test(lower)) {
    if (profile.datasetSummary.hasTreatmentLike && (profile.datasetSummary.hasOutcomeLike || profile.datasetSummary.hasContinuousLike) && profile.datasetSummary.hasContinuousLike && profile.datasetSummary.totalRowsHint >= 120) executable.add("propensity_score");
    else {
      requiresMissing.add("propensity_score");
      blockedReasons.propensity_score = "Propensity-score designs need richer observed covariate support and overlap diagnostics than are currently evidenced.";
    }
  }
  if (/(quantile regression|conditional quantile)/i.test(lower)) {
    if (profile.datasetSummary.hasContinuousLike && profile.datasetSummary.totalRowsHint >= 120) executable.add("quantile_regression");
    else {
      requiresMissing.add("quantile_regression");
      blockedReasons.quantile_regression = "Quantile regression needs richer continuous-outcome support than is currently evidenced.";
    }
  }

  const executableNow = uniqMethodIds(Array.from(executable).filter(m =>
    !profile.constrainedMethods.includes(m) && !requiresMissing.has(m)
  ));
  const requiresMissingData = uniqMethodIds(Array.from(requiresMissing));
  const futureWorkOnly = uniqMethodIds(Array.from(new Set([...Array.from(futureOnly), ...requiresMissingData])));

  return {
    executableNow,
    requiresMissingData,
    futureWorkOnly,
    blockedReasons,
    evidenceNotes: [
      `Datasets: ${profile.datasetSummary.datasetCount}, rows (hint): ${profile.datasetSummary.totalRowsHint || "unknown"}`,
      `Capabilities — time:${profile.datasetSummary.hasTimeLike ? "yes" : "no"}, text:${profile.datasetSummary.hasTextLike ? "yes" : "no"}, panel:${profile.datasetSummary.hasPanelLike ? "yes" : "no"}, graph:${profile.datasetSummary.hasGraphLike ? "yes" : "no"}, image:${profile.datasetSummary.hasImageLike ? "yes" : "no"}, group:${profile.datasetSummary.hasGroupLike ? "yes" : "no"}, treatment:${profile.datasetSummary.hasTreatmentLike ? "yes" : "no"}, outcome:${profile.datasetSummary.hasOutcomeLike ? "yes" : "no"}`,
      `Literature papers considered: ${profile.literatureSummary.paperCount}`,
    ],
  };
}

function parseMethodContract(validationText: string, methodologyText: string, profile: ResearchEvidenceProfile): MethodFeasibilityContract {
  const fallback = deriveFallbackMethodContract(methodologyText, profile);
  const jsonBlock = extractJsonBetweenTags(validationText, "METHOD_CONTRACT_JSON");
  if (!jsonBlock) return fallback;
  try {
    const parsed = JSON.parse(jsonBlock) as {
      executable_now?: string[];
      requires_missing_data?: string[];
      future_work_only?: string[];
      blocked_reasons?: Record<string, string>;
      evidence_notes?: string[];
    };
    const executableNow = uniqMethodIds(parsed.executable_now || []);
    const requiresMissingData = uniqMethodIds(parsed.requires_missing_data || []);
    const futureWorkOnly = uniqMethodIds(parsed.future_work_only || []);
    const blockedReasons: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.blocked_reasons || {})) {
      blockedReasons[normaliseMethodId(k)] = String(v);
    }
    const mergedFuture = uniqMethodIds([...futureWorkOnly, ...requiresMissingData, ...profile.constrainedMethods]);
    const safeExecutableNow = executableNow.filter(m =>
      !mergedFuture.includes(m) && !profile.constrainedMethods.includes(m)
    );
    if (profile.datasetSummary.datasetCount > 0 && !safeExecutableNow.includes("descriptive_statistics")) {
      safeExecutableNow.push("descriptive_statistics");
    }
    const normalizedExecutableNow = uniqMethodIds(safeExecutableNow);
    return {
      executableNow: normalizedExecutableNow.length > 0 ? normalizedExecutableNow : fallback.executableNow,
      requiresMissingData: requiresMissingData.length > 0 ? requiresMissingData : fallback.requiresMissingData,
      futureWorkOnly: mergedFuture.length > 0 ? mergedFuture : fallback.futureWorkOnly,
      blockedReasons: Object.keys(blockedReasons).length > 0 ? blockedReasons : fallback.blockedReasons,
      evidenceNotes: (parsed.evidence_notes || []).map(s => String(s)).filter(Boolean),
    };
  } catch {
    return fallback;
  }
}

function formatMethodContract(contract: MethodFeasibilityContract | null): string {
  if (!contract) return "No method feasibility contract available.";
  const reasons = Object.entries(contract.blockedReasons)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return [
    `Executable now: ${contract.executableNow.length ? contract.executableNow.join(", ") : "none"}`,
    `Requires missing data: ${contract.requiresMissingData.length ? contract.requiresMissingData.join(", ") : "none"}`,
    `Future-work only: ${contract.futureWorkOnly.length ? contract.futureWorkOnly.join(", ") : "none"}`,
    reasons ? `Blocked reasons:\n${reasons}` : "",
    contract.evidenceNotes.length ? `Evidence notes:\n${contract.evidenceNotes.map(n => `- ${n}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

const EXECUTION_METHOD_PRIORITY = [
  "descriptive_statistics",
  "correlation",
  "group_comparison",
  "time_trend",
  "text_feature_analysis",
  "robust_ols",
  "linear_regression",
  "panel_fixed_effects",
  "diff_in_diff",
  "event_study",
  "synthetic_control",
  "iv_2sls",
  "regression_discontinuity",
  "propensity_score",
  "quantile_regression",
];

function selectExecutionMethods(
  contract: MethodFeasibilityContract,
  analysisInputs?: AnalysisInputs,
  maxMethods = 5,
): string[] {
  const available = new Set(uniqMethodIds(contract.executableNow).filter(methodId => methodId !== "data_visualisation"));
  if (available.size === 0) return [];

  const preferred: string[] = [];
  if (available.has("descriptive_statistics")) preferred.push("descriptive_statistics");
  if (analysisInputs?.outcome) preferred.push("robust_ols", "linear_regression");
  if (analysisInputs?.subgroup) preferred.push("group_comparison");
  if (analysisInputs?.time) preferred.push("time_trend");
  if (analysisInputs?.entity && analysisInputs?.time) preferred.push("panel_fixed_effects");
  if (analysisInputs?.treatment && analysisInputs?.time) preferred.push("diff_in_diff", "event_study");
  if (analysisInputs?.treatment && analysisInputs?.entity && analysisInputs?.time) preferred.push("synthetic_control");
  if (analysisInputs?.treatment) preferred.push("propensity_score");

  const selected: string[] = [];
  for (const methodId of [...preferred, ...EXECUTION_METHOD_PRIORITY]) {
    const normalized = normaliseMethodId(methodId);
    if (!available.has(normalized) || selected.includes(normalized)) continue;
    selected.push(normalized);
    if (selected.length >= maxMethods) break;
  }

  if (selected.length === 0) {
    return Array.from(available).slice(0, maxMethods);
  }
  return selected;
}

function buildDeterministicAnalysisPlan(ctx: PipelineContext, contract: MethodFeasibilityContract): string {
  const selectedMethods = selectExecutionMethods(contract, ctx.config.analysisInputs);
  const analysisPlan = {
    version: 2,
    planType: "deterministic_dataset_analysis",
    methods: selectedMethods,
    blockedMethods: uniqMethodIds([
      ...(contract.requiresMissingData || []),
      ...(contract.futureWorkOnly || []),
    ]),
    topic: ctx.topic,
    analysisInputs: ctx.config.analysisInputs,
    datasetSummary: ctx.datasetFiles.map(d => ({
      name: d.originalName,
      rows: d.rowCount || 0,
      fileType: d.fileType,
    })),
    note: "Execution plan intentionally capped to limit sandbox runtime and output volume.",
  };
  return JSON.stringify(analysisPlan, null, 2);
}

function extractRequestedExecutionMethods(experimentCode: string): string[] {
  const trimmed = (experimentCode || "").trim();
  if (!trimmed.startsWith("{")) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return uniqMethodIds(Array.isArray((parsed as any).methods) ? (parsed as any).methods : []);
  } catch {
    return [];
  }
}

function collectExecutedMethodIds(experimentOutput: ExperimentOutput | null): string[] {
  if (!experimentOutput) return [];
  const byMetrics = String(experimentOutput.metrics?.analysis_methods_executed || "")
    .split(",")
    .map(s => normaliseMethodId(s.trim()))
    .filter(Boolean);
  if (byMetrics.length > 0) return uniqMethodIds(byMetrics);
  const keys = Object.keys(experimentOutput.metrics || {});
  const inferred: string[] = [];
  if (keys.some(k => k.startsWith("mean_") || k.startsWith("std_") || k.startsWith("median_"))) inferred.push("descriptive_statistics");
  if (keys.some(k => k.startsWith("strongest_correlation_"))) inferred.push("correlation");
  if (keys.some(k => k.startsWith("regression_"))) inferred.push("linear_regression");
  if (keys.some(k => k.startsWith("robust_ols_"))) inferred.push("robust_ols");
  if (keys.some(k => k.startsWith("anova_"))) inferred.push("group_comparison");
  if (keys.some(k => k.startsWith("time_trend_"))) inferred.push("time_trend");
  if (keys.some(k => k.startsWith("text_") || k.startsWith("top_term_"))) inferred.push("text_feature_analysis");
  if (keys.some(k => k.startsWith("panel_fe_"))) inferred.push("panel_fixed_effects");
  if (keys.some(k => k.startsWith("did_"))) inferred.push("diff_in_diff");
  if (keys.some(k => k.startsWith("event_study_"))) inferred.push("event_study");
  if (keys.some(k => k.startsWith("synthetic_control_"))) inferred.push("synthetic_control");
  if (keys.some(k => k.startsWith("iv_2sls_"))) inferred.push("iv_2sls");
  if (keys.some(k => k.startsWith("rdd_"))) inferred.push("regression_discontinuity");
  if (keys.some(k => k.startsWith("propensity_score_"))) inferred.push("propensity_score");
  if (keys.some(k => k.startsWith("quantile_regression_"))) inferred.push("quantile_regression");
  if ((experimentOutput.charts || []).length > 0) inferred.push("data_visualisation");
  return uniqMethodIds(inferred);
}

function buildExecutionDiagnostics(
  contract: MethodFeasibilityContract | null,
  output: ExperimentOutput,
  analyticalMetricCount: number,
  requestedMethods?: string[],
): ExecutionDiagnostics {
  const executableRequested = requestedMethods && requestedMethods.length > 0
    ? uniqMethodIds(requestedMethods)
    : (contract?.executableNow || []);
  const executedMethods = collectExecutedMethodIds(output);
  const missingRequested = executableRequested.filter(m => !executedMethods.includes(m));
  const failureReasons: string[] = [];
  if (output.stderr) failureReasons.push(output.stderr.substring(0, 500));
  if (missingRequested.length > 0) failureReasons.push(`Requested executable methods not observed: ${missingRequested.join(", ")}`);
  if (analyticalMetricCount === 0) failureReasons.push("No analytical metrics were produced.");
  const unresolvedPrereq = String(output.metrics?.execution_unresolved_prerequisites || "").trim();
  const skippedExecutable = String(output.metrics?.execution_skipped_executable_methods || "").trim();
  const noOutputReasons = String(output.metrics?.execution_no_output_reasons || "").trim();
  if (unresolvedPrereq) failureReasons.push(`Unresolved prerequisites: ${unresolvedPrereq}`);
  if (skippedExecutable) failureReasons.push(`Executable methods skipped in runner: ${skippedExecutable}`);
  if (noOutputReasons) failureReasons.push(`Runner output notes: ${noOutputReasons}`);
  const executionStatus: ExecutionDiagnostics["executionStatus"] =
    !output.success && analyticalMetricCount === 0
      ? "failed"
      : (!output.success || missingRequested.length > 0 || analyticalMetricCount === 0 ? "partial" : "success");
  return {
    executionStatus,
    executableRequested,
    executedMethods,
    missingRequested,
    analyticalMetricCount,
    chartCount: output.charts.length,
    tableCount: output.tables.length,
    failureReasons,
  };
}

function formatExecutionDiagnostics(diag: ExecutionDiagnostics | null): string {
  if (!diag) return "No execution diagnostics available.";
  return [
    `Execution status: ${diag.executionStatus}`,
    `Executable methods requested: ${diag.executableRequested.length ? diag.executableRequested.join(", ") : "none"}`,
    `Methods evidenced by outputs: ${diag.executedMethods.length ? diag.executedMethods.join(", ") : "none"}`,
    `Missing requested methods: ${diag.missingRequested.length ? diag.missingRequested.join(", ") : "none"}`,
    `Analytical metrics count: ${diag.analyticalMetricCount}`,
    `Charts: ${diag.chartCount}, Tables: ${diag.tableCount}`,
    diag.failureReasons.length ? `Failure/limitation reasons:\n${diag.failureReasons.map(r => `- ${r}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

function buildClaimVerificationReport(ctx: PipelineContext, bodyText: string): ClaimVerificationResult {
  const flaggedClaims: string[] = [];
  const executed = new Set<string>((ctx.executionDiagnostics?.executedMethods || []).map(normaliseMethodId));
  const unsupportedMethods = new Set<string>([
    ...(ctx.methodContract?.futureWorkOnly || []),
    ...(ctx.methodContract?.requiresMissingData || []),
  ].map(normaliseMethodId));
  const claimSentences = bodyText
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const assertive = /\b(we|our|this study)\b.*\b(use|used|apply|applied|implement|implemented|train|trained|estimate|estimated|demonstrate|demonstrated|find|found|show|shows)\b/i;
  const methodPatterns: Array<[string, RegExp]> = [
    ["causal_inference", /(causal|difference-in-differences|instrumental variable|propensity score|synthetic control|rdd)/i],
    ["robust_ols", /(robust standard errors|hc1|hc3|heteroskedasticity[- ]robust)/i],
    ["panel_fixed_effects", /(fixed effects|within estimator|two-way fixed effects|twfe)/i],
    ["diff_in_diff", /(difference-in-differences|did\b)/i],
    ["event_study", /(event study|dynamic treatment effect|relative time)/i],
    ["synthetic_control", /(synthetic control|synthetic donor)/i],
    ["iv_2sls", /(instrumental variable|2sls|two-stage least squares)/i],
    ["regression_discontinuity", /(regression discontinuity|rdd\b|running variable|forcing variable)/i],
    ["propensity_score", /(propensity score|inverse probability weighting|matching estimator)/i],
    ["quantile_regression", /(quantile regression|conditional quantile)/i],
    ["graph_modelling", /(graph neural|gnn|graph convolution|network embedding)/i],
    ["vision_analysis", /(computer vision|image model|cnn|visual analysis)/i],
    ["advanced_nlp", /(transformer|bert|topic model|deep learning|embedding model|llm)/i],
    ["panel_econometrics", /(fixed effects|random effects|gmm|sem|structural equation)/i],
    ["advanced_time_series", /(arima|var\b|lstm|state space)/i],
  ];

  for (const sentence of claimSentences) {
    if (!assertive.test(sentence)) continue;
    for (const [methodId, pattern] of methodPatterns) {
      if (pattern.test(sentence) && (unsupportedMethods.has(methodId) || !executed.has(methodId))) {
        flaggedClaims.push(sentence.slice(0, 220));
        break;
      }
    }
  }

  const fabricatedEvidencePattern = /\b(figure|table)\s*\d+\s*(shows|demonstrates|proves)\b/i;
  const hasCharts = (ctx.experimentOutput?.charts?.length || 0) > 0;
  const hasTables = (ctx.experimentOutput?.tables?.length || 0) > 0;
  for (const sentence of claimSentences) {
    if (!fabricatedEvidencePattern.test(sentence)) continue;
    const referencesFigure = /figure\s*\d+/i.test(sentence);
    const referencesTable = /table\s*\d+/i.test(sentence);
    if ((referencesFigure && !hasCharts) || (referencesTable && !hasTables)) {
      flaggedClaims.push(sentence.slice(0, 220));
    }
  }

  const hasRealMetrics = getAnalyticalMetricEntries(ctx.experimentOutput).length > 0;
  if (!hasRealMetrics && /\b(p\s*[<=>]\s*0?\.\d+|r\s*=\s*-?\d+\.\d+|r\^?2\s*=\s*0?\.\d+|accuracy\s*=\s*0?\.\d+)/i.test(bodyText)) {
    flaggedClaims.push("Quantitative claim syntax detected despite no analytical metrics being available.");
  }

  const blockedPhrase = /\b(successfully (applied|implemented|validated)|outperformed|significantly improved|state-of-the-art)\b/i;
  if (blockedPhrase.test(bodyText) && (ctx.executionDiagnostics?.executionStatus === "failed" || !hasRealMetrics)) {
    flaggedClaims.push("Strong success/performance phrasing detected despite missing or failed empirical evidence.");
  }

  const reportLines = [
    `Claim verifier summary: ${flaggedClaims.length} potential unsupported claim(s) detected.`,
    `Executed methods: ${(ctx.executionDiagnostics?.executedMethods || []).join(", ") || "none"}`,
    `Contract future/missing methods: ${uniqMethodIds([...(ctx.methodContract?.futureWorkOnly || []), ...(ctx.methodContract?.requiresMissingData || [])]).join(", ") || "none"}`,
    flaggedClaims.length > 0
      ? `Flagged claims:\n${flaggedClaims.slice(0, 8).map(c => `- ${c}`).join("\n")}`
      : "No unsupported method-claim sentence was detected by heuristic verifier.",
  ];
  return { report: reportLines.join("\n"), flaggedClaims };
}

async function persistStageAudit(ctx: PipelineContext, stageNumber: number, metrics: Record<string, unknown>): Promise<void> {
  try {
    await db.updateStageLog(ctx.runId, stageNumber, { metrics: metrics as any });
  } catch (err: any) {
    console.warn(`[Pipeline] Failed to persist stage ${stageNumber} audit:`, err?.message);
  }
}

function getAnalyticalMetricEntries(experimentOutput: ExperimentOutput | null): [string, number | string][] {
  if (!experimentOutput) return [];
  const entries = Object.entries(experimentOutput.metrics || {});
  if (entries.length === 0) return [];

  const analyticalPrefixes = [
    "mean_", "std_", "median_", "min_", "max_",
    "strongest_correlation_", "p_value_", "regression_",
    "robust_ols_", "panel_fe_", "did_", "event_study_", "synthetic_control_",
    "iv_2sls_", "rdd_", "propensity_score_", "quantile_regression_",
    "anova_", "time_trend_", "text_", "top_",
    "method_readiness_",
  ];
  const analyticalExact = new Set([
    "correlation_sample_size",
    "correlation_interpretation",
    "analysis_methods_executed",
    "method_applicability_executable_now",
    "method_applicability_partially_ready",
    "method_applicability_blocked",
    "method_applicability_top_executable",
    "method_applicability_summary",
  ]);

  return entries.filter(([k]) => {
    if (analyticalExact.has(k)) return true;
    return analyticalPrefixes.some(prefix => k.startsWith(prefix));
  });
}

function collectExecutedMethods(experimentOutput: ExperimentOutput | null): string[] {
  if (!experimentOutput) return [];
  const metricKeys = Object.keys(experimentOutput.metrics || {});
  const methods = new Set<string>();

  if (metricKeys.some(k => k.startsWith("mean_") || k.startsWith("std_") || k.startsWith("median_"))) {
    methods.add("descriptive statistics");
  }
  if (metricKeys.some(k => k.startsWith("strongest_correlation_") || k === "correlation_interpretation")) {
    methods.add("correlation analysis");
  }
  if (metricKeys.some(k => k.startsWith("regression_"))) {
    methods.add("linear regression");
  }
  if (metricKeys.some(k => k.startsWith("robust_ols_"))) {
    methods.add("robust OLS inference");
  }
  if (metricKeys.some(k => k.startsWith("panel_fe_"))) {
    methods.add("panel fixed effects");
  }
  if (metricKeys.some(k => k.startsWith("did_"))) {
    methods.add("difference-in-differences");
  }
  if (metricKeys.some(k => k.startsWith("event_study_"))) {
    methods.add("event-study profiling");
  }
  if (metricKeys.some(k => k.startsWith("synthetic_control_"))) {
    methods.add("synthetic control analysis");
  }
  if (metricKeys.some(k => k.startsWith("iv_2sls_"))) {
    methods.add("instrumental variables / 2SLS");
  }
  if (metricKeys.some(k => k.startsWith("rdd_"))) {
    methods.add("regression discontinuity");
  }
  if (metricKeys.some(k => k.startsWith("propensity_score_"))) {
    methods.add("propensity-score weighting");
  }
  if (metricKeys.some(k => k.startsWith("quantile_regression_"))) {
    methods.add("quantile regression");
  }
  if (metricKeys.some(k => k.startsWith("anova_") || k.startsWith("group_"))) {
    methods.add("group comparison analysis");
  }
  if (metricKeys.some(k => k.startsWith("time_trend_"))) {
    methods.add("time trend analysis");
  }
  if (metricKeys.some(k => k.startsWith("text_") || k.startsWith("top_"))) {
    methods.add("text feature analysis");
  }
  if (metricKeys.some(k => k.startsWith("method_readiness_") || k.startsWith("method_status_") || k.startsWith("method_applicability_"))) {
    methods.add("method applicability assessment");
  }
  if (experimentOutput.charts.length > 0) {
    methods.add("data visualisation");
  }

  return Array.from(methods);
}

function detectLikelyOverclaims(methodologyText: string, executedMethods: string[]): string[] {
  if (!methodologyText) return [];
  const lower = methodologyText.toLowerCase();
  const executed = new Set<string>(executedMethods.map(normaliseMethodId));
  const overclaims: string[] = [];

  if (/(causal|difference-in-differences|instrumental variable|propensity score|rdd|synthetic control)/i.test(lower) && !executed.has("causal_inference")) {
    overclaims.push("causal inference");
  }
  if (/(robust standard errors|hc1|hc3|heteroskedasticity[- ]robust)/i.test(lower) && !executed.has("robust_ols")) {
    overclaims.push("robust OLS inference");
  }
  if (/(fixed effects|within estimator|two-way fixed effects|twfe)/i.test(lower) && !executed.has("panel_fixed_effects")) {
    overclaims.push("panel fixed effects");
  }
  if (/(difference-in-differences|did\b)/i.test(lower) && !executed.has("diff_in_diff")) {
    overclaims.push("difference-in-differences");
  }
  if (/(event study|dynamic treatment effect|relative time)/i.test(lower) && !executed.has("event_study")) {
    overclaims.push("event-study analysis");
  }
  if (/(synthetic control|synthetic controls)/i.test(lower) && !executed.has("synthetic_control")) {
    overclaims.push("synthetic control");
  }
  if (/(instrumental variable|2sls|two-stage least squares)/i.test(lower) && !executed.has("iv_2sls")) {
    overclaims.push("instrumental variables");
  }
  if (/(regression discontinuity|rdd\b|running variable)/i.test(lower) && !executed.has("regression_discontinuity")) {
    overclaims.push("regression discontinuity");
  }
  if (/(propensity score|inverse probability weighting|matching estimator)/i.test(lower) && !executed.has("propensity_score")) {
    overclaims.push("propensity-score methods");
  }
  if (/(quantile regression|conditional quantile)/i.test(lower) && !executed.has("quantile_regression")) {
    overclaims.push("quantile regression");
  }
  if (/(transformer|bert|llm|deep learning|neural network|topic model|embedding)/i.test(lower) && !executed.has("advanced_nlp") && !executed.has("text_feature_analysis")) {
    overclaims.push("advanced NLP/deep learning");
  }
  if (/(graph neural|gnn|network embedding|graph convolution)/i.test(lower) && !executed.has("graph_modelling")) {
    overclaims.push("graph modelling");
  }
  if (/(arima|var\b|vector autoregression|lstm|time-series)/i.test(lower) && !executed.has("advanced_time_series") && !executed.has("time_trend")) {
    overclaims.push("advanced time-series modelling");
  }
  if (/(panel model|random effects|gmm|sem|structural equation)/i.test(lower) && !executed.has("panel_econometrics") && !executed.has("panel_fixed_effects")) {
    overclaims.push("panel/structural econometric modelling");
  }

  return overclaims;
}

function buildMethodIntegrityNote(ctx: PipelineContext): string {
  const output = ctx.experimentOutput;
  if (!output) {
    return "No executed analysis output is available. The paper must remain methodological and avoid empirical claims.";
  }

  const analyticalMetrics = getAnalyticalMetricEntries(output);
  const executedMethodIds = collectExecutedMethodIds(output);
  const executedMethods = collectExecutedMethods(output);
  const overclaims = detectLikelyOverclaims(ctx.methodology, executedMethodIds);

  const lines: string[] = [];
  lines.push(`Datasets analysed: ${ctx.datasetFiles.length}`);
  lines.push(`Computed analytical metrics: ${analyticalMetrics.length}`);
  lines.push(`Executed methods: ${executedMethods.length > 0 ? executedMethods.join(", ") : "none"}`);
  if (overclaims.length > 0) {
    lines.push(`Methods mentioned but not executed: ${Array.from(new Set(overclaims)).join(", ")}`);
    lines.push("Rule: treat non-executed methods as future work, not as completed experiments.");
  } else {
    lines.push("Method-claim alignment check: no obvious overclaim detected from methodology keywords.");
  }

  return lines.join("\n");
}

function collectActiveMethodIds(ctx: PipelineContext): string[] {
  return uniqMethodIds([
    ...(ctx.executionDiagnostics?.executedMethods || []),
    ...(ctx.methodContract?.executableNow || []),
  ].map(normaliseMethodId));
}

function buildEconometricWritingGuidance(ctx: PipelineContext): string {
  const active = new Set<string>(collectActiveMethodIds(ctx));
  const futureOnly = new Set<string>([
    ...(ctx.methodContract?.requiresMissingData || []),
    ...(ctx.methodContract?.futureWorkOnly || []),
  ].map(normaliseMethodId));
  const lines: string[] = [];
  const hasEconometricContent = [
    "robust_ols",
    "panel_fixed_effects",
    "diff_in_diff",
    "event_study",
    "synthetic_control",
    "causal_inference",
    "iv_2sls",
    "regression_discontinuity",
    "propensity_score",
    "quantile_regression",
  ].some(methodId => active.has(methodId) || futureOnly.has(methodId));

  if (!hasEconometricContent) return "";

  lines.push("For each econometric or causal design, explicitly state the estimand, the model equation, the identifying assumptions, the inference specification, and the core diagnostics or falsification tests.");
  if (active.has("robust_ols")) {
    lines.push("- `robust_ols` (executed): write the model as `y_i = alpha + beta x_i + eps_i`, state that heteroskedasticity-robust standard errors are used, and interpret beta with its confidence interval.");
  }
  if (active.has("panel_fixed_effects")) {
    lines.push("- `panel_fixed_effects` (executed): write `y_it = alpha_i + delta_t + beta x_it + eps_it`, explain the unit and time fixed effects, and discuss within-unit variation.");
  }
  if (active.has("diff_in_diff")) {
    lines.push("- `diff_in_diff` (executed): write `y_it = alpha_i + delta_t + beta (Treat_i x Post_t) + eps_it`, define beta as the average treatment effect on the treated under parallel trends, and discuss pre/post group means.");
  }
  if (active.has("event_study")) {
    lines.push("- `event_study` (executed): write `y_it = alpha_i + delta_t + sum_{k != -1} beta_k 1{t-T_i=k} + eps_it`, interpret lead coefficients as pre-trend diagnostics and lag coefficients as dynamic effects.");
  }
  if (active.has("synthetic_control")) {
    lines.push("- `synthetic_control` (executed): describe the donor-weight optimisation `min_W (X_1 - X_0 W)' V (X_1 - X_0 W)` subject to `W >= 0` and `sum_j W_j = 1`, and discuss pre-treatment fit, post-treatment gaps, and donor weights.");
  }
  if (active.has("causal_inference") && !active.has("diff_in_diff") && !active.has("event_study") && !active.has("synthetic_control")) {
    lines.push("- `causal_inference` (executed): define the estimand in potential-outcomes notation, e.g. `tau = E[Y(1) - Y(0) | T = 1]`, and state the assumptions needed for identification.");
  }
  if (active.has("iv_2sls")) {
    lines.push("- `iv_2sls` (executed): write the first and second stages as `D_i = pi Z_i + gamma' X_i + nu_i` and `y_i = beta Dhat_i + gamma' X_i + eps_i`, and discuss first-stage strength and exclusion restrictions.");
  }
  if (active.has("regression_discontinuity")) {
    lines.push("- `regression_discontinuity` (executed): define the cutoff, bandwidth, local-linear specification, and the discontinuity estimand at the threshold.");
  }
  if (active.has("propensity_score")) {
    lines.push("- `propensity_score` (executed): define the propensity score `e(X_i) = P(T_i = 1 | X_i)` and report overlap plus balance diagnostics before and after weighting.");
  }
  if (active.has("quantile_regression")) {
    lines.push("- `quantile_regression` (executed): write the conditional quantile model `Q_tau(Y_i | X_i) = alpha_tau + beta_tau X_i` and interpret heterogeneous slopes across quantiles.");
  }
  if (futureOnly.has("iv_2sls")) {
    lines.push("- `iv_2sls` (future work only): if mentioned, frame it as unexecuted and use the equations `D_i = pi Z_i + gamma' X_i + nu_i` and `y_i = beta Dhat_i + gamma' X_i + eps_i`, noting that first-stage strength and exclusion restrictions remain to be validated.");
  }
  if (futureOnly.has("regression_discontinuity")) {
    lines.push("- `regression_discontinuity` (future work only): if mentioned, frame it as unexecuted and note the need for a running variable, cutoff, and local continuity diagnostics.");
  }
  if (futureOnly.has("propensity_score")) {
    lines.push("- `propensity_score` (future work only): if mentioned, frame it as unexecuted and note that overlap, balance, and sensitivity diagnostics are pending.");
  }
  if (futureOnly.has("quantile_regression")) {
    lines.push("- `quantile_regression` (future work only): if mentioned, frame it as unexecuted and note that conditional quantile estimation remains blocked by data support or design constraints.");
  }

  return `Econometric and causal writing guidance:\n${lines.join("\n")}`;
}

// ─── Stage Implementations ───

async function stage1_topicAnalysis(ctx: PipelineContext): Promise<string> {
  const datasetInfo = ctx.datasetFiles.length > 0
    ? `\n\nThe researcher has uploaded the following dataset(s) for analysis:\n${buildDatasetDescription(ctx.datasetFiles)}\nIncorporate these datasets into the analysis plan.`
    : "";
  return callLLM(
    "You are a research topic analyst. Analyze the given research topic and extract key concepts, research questions, and relevant keywords for literature search.",
    `Analyze this research topic in depth:\n\n"${ctx.topic}"${datasetInfo}\n\nProvide:\n1. Key research questions (3-5)\n2. Core concepts and definitions\n3. Related fields and subfields\n4. Search keywords for literature databases (10-15 keywords/phrases)\n5. Potential research directions`
  );
}

async function stage2_literatureSearch(ctx: PipelineContext): Promise<string> {
  const searchResults = await unifiedSearch(ctx.topic, {
    maxPerSource: 8,
    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY,
    springerApiKey: process.env.SPRINGER_API_KEY,
    sources: ctx.config.dataSources,
  });
  ctx.papers = searchResults;

  if (searchResults.length > 0) {
    await db.insertPapers(searchResults.map(p => ({
      runId: ctx.runId,
      paperId: p.paperId,
      title: p.title,
      authors: p.authors,
      year: p.year,
      abstract: p.abstract,
      venue: p.venue,
      citationCount: p.citationCount,
      doi: p.doi,
      arxivId: p.arxivId,
      url: p.url,
      source: p.source,
      bibtex: p.bibtex,
    })));
  }

  const sourceCounts: Record<string, number> = {};
  for (const p of searchResults) {
    sourceCounts[p.source] = (sourceCounts[p.source] || 0) + 1;
  }
  ctx.evidenceProfile = buildResearchEvidenceProfile(ctx.topic, ctx.datasetFiles, searchResults);
  const queryTerms = ctx.topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3)
    .slice(0, 10);
  const topPapers = searchResults.slice(0, 20);
  const matchCounts = topPapers.map((p) => {
    const text = `${p.title || ""} ${p.abstract || ""}`.toLowerCase();
    const matched = queryTerms.filter((term) => text.includes(term)).length;
    return matched;
  });
  const avgQueryTermCoverage = matchCounts.length
    ? matchCounts.reduce((sum, n) => sum + n, 0) / matchCounts.length
    : 0;
  const withAbstractRatio = topPapers.length
    ? topPapers.filter((p) => (p.abstract || "").trim().length > 80).length / topPapers.length
    : 0;
  const withDoiRatio = topPapers.length
    ? topPapers.filter((p) => !!(p.doi || "").trim()).length / topPapers.length
    : 0;
  const meanYear = topPapers.length
    ? topPapers.reduce((sum, p) => sum + (p.year || 0), 0) / topPapers.length
    : 0;
  await persistStageAudit(ctx, 2, {
    papersFound: searchResults.length,
    sourceCounts,
    evidenceProfile: ctx.evidenceProfile,
    retrievalQuality: {
      avgQueryTermCoverage: Math.round(avgQueryTermCoverage * 100) / 100,
      withAbstractRatio: Math.round(withAbstractRatio * 1000) / 1000,
      withDoiRatio: Math.round(withDoiRatio * 1000) / 1000,
      meanYear: Math.round(meanYear),
    },
  });

  const topSignals = Object.entries(ctx.evidenceProfile.literatureSummary.topMethodSignals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}(${v})`)
    .join(", ");

  return `Found ${searchResults.length} papers from ${Object.entries(ctx.config.dataSources).filter(([,v]) => v).map(([k]) => k).join(", ")}.\nSource distribution: ${Object.entries(sourceCounts).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}.\nLiterature method signals: ${topSignals || "none"}.\nRetrieval quality: avg query-term coverage=${avgQueryTermCoverage.toFixed(2)}, abstracts present=${(withAbstractRatio * 100).toFixed(1)}%, DOI present=${(withDoiRatio * 100).toFixed(1)}%.\n\nTop papers:\n${searchResults.slice(0, 10).map((p, i) => `${i + 1}. [${p.source}] ${p.title} (${p.year}) - Citations: ${p.citationCount}`).join("\n")}`;
}

async function stage3_paperScreening(ctx: PipelineContext): Promise<string> {
  const paperList = ctx.papers.slice(0, 30).map((p, i) => `${i + 1}. "${p.title}" (${p.year}) [${p.source}]\nAbstract: ${p.abstract?.substring(0, 300)}...`).join("\n\n");
  const screeningResult = await callLLM(
    "You are a research paper screener. Evaluate papers for relevance to the research topic. Be strict — exclude papers that are clearly unrelated to the core topic.",
    `Research topic: "${ctx.topic}"\n\nScreen these papers for relevance:\n\n${paperList}\n\nFor each paper, output a structured line in this EXACT format (one per paper):\nPAPER_<number>: INCLUDE|EXCLUDE, score=<1-10>, reason=<brief justification>\n\nExample:\nPAPER_1: INCLUDE, score=9, reason=Directly addresses UK data archiving practices\nPAPER_2: EXCLUDE, score=2, reason=About blood cell classification, unrelated to topic\n\nAfter all paper evaluations, provide a brief summary of the screening results.`
  );

  // Parse screening results and filter ctx.papers
  const includeIndices = new Set<number>();
  const lines = screeningResult.split("\n");
  for (const line of lines) {
    const match = line.match(/PAPER_(\d+)\s*:\s*(INCLUDE|EXCLUDE)/i);
    if (match) {
      const idx = parseInt(match[1]) - 1; // Convert 1-based to 0-based
      if (match[2].toUpperCase() === "INCLUDE" && idx >= 0 && idx < ctx.papers.length) {
        includeIndices.add(idx);
      }
    }
  }

  // Apply filter: keep only included papers. If parsing failed (no PAPER_ lines found),
  // keep all papers to avoid losing everything due to LLM format issues.
  if (includeIndices.size > 0) {
    const beforeCount = ctx.papers.length;
    ctx.papers = ctx.papers.filter((_p, i) => includeIndices.has(i));
    console.log(`[Pipeline] Stage 3 screening: ${beforeCount} → ${ctx.papers.length} papers (${beforeCount - ctx.papers.length} excluded)`);
  } else {
    console.warn("[Pipeline] Stage 3 screening: could not parse INCLUDE/EXCLUDE from LLM output, keeping all papers");
  }

  return screeningResult;
}

async function stage4_deepAnalysis(ctx: PipelineContext): Promise<string> {
  const topPapers = ctx.papers.slice(0, 10).map((p, i) => `${i + 1}. "${p.title}"\nAuthors: ${p.authors}\nAbstract: ${p.abstract}`).join("\n\n");
  return callLLM(
    "You are a research analyst performing deep analysis of academic papers.",
    `Research topic: "${ctx.topic}"\n\nPerform deep analysis of these key papers:\n\n${topPapers}\n\nProvide:\n1. Methodology comparison across papers\n2. Key findings synthesis\n3. Contradictions or debates in the field\n4. Common limitations\n5. Emerging trends`
  );
}

async function stage5_gapIdentification(ctx: PipelineContext): Promise<string> {
  return callLLM(
    "You are a research gap analyst. Identify unexplored areas and opportunities.",
    `Research topic: "${ctx.topic}"\n\nBased on the literature analysis, identify:\n1. Unexplored research gaps (3-5)\n2. Methodological gaps\n3. Data/empirical gaps\n4. Theoretical gaps\n5. Prioritized gap ranking with justification\n6. Potential impact of addressing each gap`
  );
}

async function stage6_hypothesisGeneration(ctx: PipelineContext): Promise<string> {
  const evidence = ensureEvidenceProfile(ctx);
  const analysisInputContext = buildAnalysisInputContext(ctx.config.analysisInputs);
  const hypothesisConstraint = `\n\nDataset/literature feasibility profile:\n- Dataset count: ${evidence.datasetSummary.datasetCount}\n- Capabilities: time=${evidence.datasetSummary.hasTimeLike ? "yes" : "no"}, text=${evidence.datasetSummary.hasTextLike ? "yes" : "no"}, panel=${evidence.datasetSummary.hasPanelLike ? "yes" : "no"}, graph=${evidence.datasetSummary.hasGraphLike ? "yes" : "no"}, image=${evidence.datasetSummary.hasImageLike ? "yes" : "no"}, group=${evidence.datasetSummary.hasGroupLike ? "yes" : "no"}, treatment=${evidence.datasetSummary.hasTreatmentLike ? "yes" : "no"}, outcome=${evidence.datasetSummary.hasOutcomeLike ? "yes" : "no"}\n- Executable method hints: ${evidence.recommendedExecutableMethods.join(", ") || "none"}\n- Constrained method hints: ${evidence.constrainedMethods.join(", ") || "none"}${analysisInputContext}\n\nMethodology applicability guide (derive hypotheses that can be empirically tested now):\n${buildMethodologyApplicabilityGuide(evidence)}`;
  const result = await callLLM(
    "You are a research hypothesis generator. Create testable hypotheses from identified gaps.",
    `Research topic: "${ctx.topic}"${hypothesisConstraint}\n\nBased on identified research gaps, generate:\n1. Primary hypothesis (clear, testable, specific)\n2. Secondary hypotheses (2-3)\n3. Null hypotheses\n4. Expected outcomes\n5. Variables (independent, dependent, control)\n6. Theoretical framework\n7. Operationalisation table (construct -> dataset column(s) -> expected sign/direction)\n8. Falsification criteria and rejection conditions for each core hypothesis\n\nRules:\n- Keep hypotheses executable with available data modalities.\n- If a hypothesis needs unavailable modalities, explicitly mark it as future-work only.`
  );
  ctx.hypothesis = result;
  await persistStageAudit(ctx, 6, {
    hypothesisLength: result.length,
    evidenceProfile: evidence,
  });
  return result;
}

async function stage7_methodDesign(ctx: PipelineContext): Promise<string> {
  const evidence = ensureEvidenceProfile(ctx);
  const hasDatasets = ctx.datasetFiles.length > 0;
  const analysisInputContext = buildAnalysisInputContext(ctx.config.analysisInputs);
  const datasetInfo = hasDatasets
    ? `\n\nAvailable datasets for analysis:\n${buildDatasetDescription(ctx.datasetFiles)}`
    : "";
  const capabilityHints = hasDatasets
    ? `\n\nDataset capability profile (derived from metadata; use this to avoid over-claiming):\n${buildDatasetCapabilityHints(ctx.datasetFiles)}`
    : "";
  const evidenceHints = `\n\nResearch evidence profile:\n- Dataset count: ${evidence.datasetSummary.datasetCount}\n- Dataset rows (hint): ${evidence.datasetSummary.totalRowsHint || "unknown"}\n- Capabilities: time=${evidence.datasetSummary.hasTimeLike ? "yes" : "no"}, text=${evidence.datasetSummary.hasTextLike ? "yes" : "no"}, panel=${evidence.datasetSummary.hasPanelLike ? "yes" : "no"}, graph=${evidence.datasetSummary.hasGraphLike ? "yes" : "no"}, image=${evidence.datasetSummary.hasImageLike ? "yes" : "no"}, group=${evidence.datasetSummary.hasGroupLike ? "yes" : "no"}, treatment=${evidence.datasetSummary.hasTreatmentLike ? "yes" : "no"}, outcome=${evidence.datasetSummary.hasOutcomeLike ? "yes" : "no"}\n- Literature signals: ${Object.entries(evidence.literatureSummary.topMethodSignals).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>`${k}:${v}`).join(", ")}\n- Recommended executable methods now: ${evidence.recommendedExecutableMethods.join(", ") || "none"}\n- Constrained methods (must not be claimed as executed): ${evidence.constrainedMethods.join(", ") || "none"}\n\nMethodology applicability guide (must be respected):\n${buildMethodologyApplicabilityGuide(evidence)}`;

  const dataConstraint = hasDatasets
    ? `\n\nCRITICAL METHODOLOGY CONSTRAINTS — ABSOLUTE RULES (VIOLATION = INVALID PAPER):

ALLOWED METHODS (whitelist — you MUST select your primary analysis methods ONLY from this list):
${evidence.recommendedExecutableMethods.map(m => `  - ${m}`).join("\n")}

BLOCKED METHODS (these MUST NOT appear in your main Methodology section):
${evidence.constrainedMethods.map(m => `  - ${m}`).join("\n")}

RULES:
1. Your main Methodology section MUST use ONLY methods from the ALLOWED list above. Any method NOT on the allowed list MUST be placed in a separate "Future Work / Aspirational Methods" subsection and MUST NOT appear in the main analytical plan.
2. The methodology title and framing MUST reflect what is actually executable. For example:
   - If only descriptive_statistics and correlation are allowed → title: "Descriptive and Correlational Analysis of ..."
   - If linear_regression is allowed → title: "Regression Analysis of ..."
   - Do NOT title it "Causal Inference Framework" or "Deep Learning Approach" if those methods are blocked.
3. DO NOT propose any advanced method (e.g., deep learning, causal inference, structural equation modelling, or domain-specific techniques) unless it explicitly appears in the ALLOWED list above.
4. BE HONEST: if the data only supports basic statistics, design a rigorous descriptive/correlational study. A well-executed simple analysis is better than an unexecutable sophisticated one.
5. The methodology section should describe:
   a. What specific statistical tests or models will be applied to which columns
   b. How variables will be operationalised (which columns map to which concepts)
   c. What preprocessing steps are needed (handling missing values, encoding categoricals, normalisation)
   d. What the expected output of each analysis step is
6. DO NOT promise results you cannot deliver. Every claim in the methodology about "we will show" or "we will demonstrate" must be achievable with the allowed methods and available data.
7. Descriptive statistics are mandatory whenever at least one dataset is available; they must include central tendency, dispersion, and missing-data profiling.
8. Include a dedicated subsection called "Methodology Applicability Matrix" with one row per major method family (descriptive_statistics, correlation, linear_regression, robust_ols, group_comparison, time_trend, text_feature_analysis, panel_fixed_effects, diff_in_diff, event_study, synthetic_control, causal_inference, iv_2sls, regression_discontinuity, propensity_score, quantile_regression, advanced_time_series, advanced_nlp, graph_modelling, vision_analysis), with readiness label (executable_now/partially_ready/blocked), key prerequisite checks, and rationale.
9. Any method marked partially_ready or blocked MUST include explicit "what is missing" and "how to unlock" notes.`
    : "";

  const result = await callLLM(
    `You are a research methodology designer. You must design methods that are REALISTIC and EXECUTABLE with the available data. Do NOT propose methods that sound impressive but cannot actually be implemented with the given dataset.`,
    `Research topic: "${ctx.topic}"\nHypothesis: ${ctx.hypothesis}${datasetInfo}${capabilityHints}${evidenceHints}${analysisInputContext}${dataConstraint}\n\nDesign a complete experimental methodology:\n1. Research design (experimental/quasi-experimental/observational) — choose based on what the DATA actually supports\n2. Data description and variable operationalisation — map dataset columns to research variables\n3. Data preprocessing steps — handling missing values, encoding, normalisation\n4. Statistical analysis plan — specific tests/models matched to data type and research questions\n5. Evaluation approach — how will you assess the quality of the analysis?\n6. Baseline comparisons — what simple benchmarks will you compare against?\n7. Limitations — what CAN'T be answered with this data?\n8. Potential confounding variables and how to address them\n9. Hypothesis-to-test alignment matrix (hypothesis -> executable test -> decision rule -> expected falsification outcome)\n10. Methodology applicability matrix covering the major modern method families and readiness labels\n\nAt the end, add two sections:\n- "Executable Analyses" with concrete analyses runnable now.\n- "Blocked Analyses" with methods that require missing data/modalities and why.\n\nAlso add a final short section named "Empirical Readiness Classification" with one label:\n- empirical (if executable analyses can produce evidence-backed quantitative claims)\n- methodological_protocol (if evidence is mainly design/protocol and quantitative claims are not yet supported).`
  );
  ctx.methodology = result;
  await persistStageAudit(ctx, 7, {
    evidenceProfile: evidence,
    methodologyLength: result.length,
  });
  return result;
}

async function stage8_methodValidation(ctx: PipelineContext): Promise<string> {
  const evidence = ensureEvidenceProfile(ctx);
  const analysisInputContext = buildAnalysisInputContext(ctx.config.analysisInputs);
  const datasetInfo = ctx.datasetFiles.length > 0
    ? `\n\nAvailable datasets:\n${buildDatasetDescription(ctx.datasetFiles)}`
    : "";
  const capabilityHints = ctx.datasetFiles.length > 0
    ? `\n\nDataset capability profile:\n${buildDatasetCapabilityHints(ctx.datasetFiles)}`
    : "";
  const evidenceHints = `\n\nResearch evidence profile:\n- Recommended executable methods: ${evidence.recommendedExecutableMethods.join(", ") || "none"}\n- Constrained methods: ${evidence.constrainedMethods.join(", ") || "none"}\n- Literature method signals: ${Object.entries(evidence.literatureSummary.topMethodSignals).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>`${k}:${v}`).join(", ")}\n\nMethodology applicability guide (hard constraints):\n${buildMethodologyApplicabilityGuide(evidence)}`;

  const result = await callLLM(
    `You are a methodology reviewer and data science expert. You must critically evaluate whether the proposed methodology is ACTUALLY FEASIBLE with the available data. Be harsh and honest. Your job is to REJECT over-ambitious methodologies and force them to match reality.`,
    `Research topic: "${ctx.topic}"\nMethodology:\n${ctx.methodology}${datasetInfo}${capabilityHints}${evidenceHints}${analysisInputContext}\n\nCritically validate:\n1. DATA-METHOD ALIGNMENT: Does the proposed method match the actual data? For example:\n   - If the data is a simple CSV with 10 columns, can you really train a graph neural network on it? NO.\n   - If the data has no temporal ordering, can you do time-series analysis? NO.\n   - If the data is aggregate statistics, can you do individual-level causal inference? NO.\n   Flag ANY method that cannot be executed with the available data.\n\n2. STATISTICAL VALIDITY: Are the proposed statistical tests appropriate for the data types?\n   - Correlation on categorical ID columns (prefecture codes, year codes) is MEANINGLESS.\n   - t-tests require proper group definitions, not arbitrary splits.\n   - Regression requires meaningful dependent and independent variables.\n   - Causal estimators require explicit estimands, identifying assumptions, and diagnostics.\n\n3. FEASIBILITY: Can this methodology actually be implemented in Python with standard libraries?\n\n4. HONESTY CHECK: Does the methodology over-promise? If so, recommend simpler, honest alternatives.\n\n5. Recommendations: What methodology SHOULD be used given the actual data?\n\n6. Overall feasibility score (1-10) — be strict. A methodology that proposes deep learning on a 4000-row CSV should score 2-3.\n\nCRITICAL VALIDATION RULE:\nIf the proposed methodology contains ANY method not in the recommended executable list (${evidence.recommendedExecutableMethods.join(", ")}) as a PRIMARY analysis method (not future work), your validation MUST:\n- Assign a feasibility score of 3 or below\n- Explicitly list each non-executable method and explain why it cannot be run\n- Provide a REWRITTEN methodology that uses ONLY executable methods\n- Move all non-executable methods to the "future_work_only" list in the contract\n\nADDITIONAL MANDATORY RULES:\n- If at least one dataset is available, descriptive_statistics MUST be included in executable_now.\n- The contract must include a method-family-level applicability judgement (executable_now / partially_ready / blocked) for modern methodologies (robust_ols, panel_fixed_effects, diff_in_diff, event_study, synthetic_control, causal_inference, iv_2sls, regression_discontinuity, propensity_score, quantile_regression, advanced_time_series, advanced_nlp, graph_modelling, vision_analysis), with concise blocked_reasons/evidence_notes.\n- When causal or econometric methods are mentioned, the review must explicitly state the estimand, key identifying assumptions, and required diagnostics or falsification tests.\n- If the user supplied a variable mapping, validate it explicitly and list any mismatches against detected dataset columns.\n\nAfter the narrative review, output a machine-readable block using EXACTLY this format:\n[METHOD_CONTRACT_JSON]\n{\"executable_now\":[...],\"requires_missing_data\":[...],\"future_work_only\":[...],\"blocked_reasons\":{\"method\":\"reason\"},\"evidence_notes\":[...]}\n[/METHOD_CONTRACT_JSON]\n\nUse concise snake_case method ids (e.g., descriptive_statistics, correlation, linear_regression, robust_ols, group_comparison, time_trend, text_feature_analysis, panel_fixed_effects, diff_in_diff, event_study, synthetic_control, causal_inference, iv_2sls, regression_discontinuity, propensity_score, quantile_regression, graph_modelling, vision_analysis, panel_econometrics, advanced_time_series, advanced_nlp).\n\nIMPORTANT: The "executable_now" list MUST be a strict subset of: ${evidence.recommendedExecutableMethods.join(", ")}. Do NOT add methods to "executable_now" that are not in this list.`
  );
  ctx.methodValidation = result;
  const contract = parseMethodContract(result, ctx.methodology, evidence);
  ctx.methodContract = contract;
  await persistStageAudit(ctx, 8, {
    methodContract: contract,
    methodValidationLength: result.length,
  });
  return result;
}

async function stage9_codeGeneration(ctx: PipelineContext): Promise<string> {
  const hasDatasets = ctx.datasetFiles.length > 0;
  const contract = ctx.methodContract || deriveFallbackMethodContract(ctx.methodology, ensureEvidenceProfile(ctx));
  ctx.methodContract = contract;

  if (hasDatasets) {
    // The runner computes outputs from real data, so keep the persisted plan compact
    // and cap execution to the highest-value feasible methods.
    ctx.experimentCode = buildDeterministicAnalysisPlan(ctx, contract);
    await persistStageAudit(ctx, 9, {
      methodContract: contract,
      selectedExecutionMethods: extractRequestedExecutionMethods(ctx.experimentCode),
      experimentCodeLength: ctx.experimentCode.length,
      deterministicPlan: true,
    });
    return ctx.experimentCode;
  } else {
    // Original simulated code generation
    const result = await callLLM(
      "You are an expert programmer generating experiment code. Write clean, well-documented Python code. Output raw Python code only - do NOT wrap in markdown code blocks.",
      `Research topic: "${ctx.topic}"\nMethodology:\n${ctx.methodology}\n\nGenerate complete Python experiment code including:\n1. Data loading/generation\n2. Model implementation\n3. Training/evaluation loop\n4. Metrics computation\n5. Result saving\n6. Visualization code\n\nUse standard libraries (numpy, pandas, scikit-learn, matplotlib). Include proper error handling and logging.\n\nIMPORTANT: Output raw Python code only. Do NOT wrap in \`\`\`python code blocks.`
    );
    // Strip any code block markers the LLM might have added
    ctx.experimentCode = stripCodeBlockMarkers(result);
    await persistStageAudit(ctx, 9, {
      methodContract: contract,
      experimentCodeLength: ctx.experimentCode.length,
      noDatasetMode: true,
    });
    return ctx.experimentCode;
  }
}

async function stage10_codeReview(ctx: PipelineContext): Promise<string> {
  const isDeterministicDatasetPlan = ctx.datasetFiles.length > 0 && (ctx.experimentCode || "").trim().startsWith("{");
  if (isDeterministicDatasetPlan) {
    const message = "Deterministic dataset analysis plan detected; skipping LLM code review because sandbox execution is driven by the curated method list rather than free-form generated code.";
    await persistStageAudit(ctx, 10, {
      skippedLlmCodeReview: true,
      requestedExecutionMethods: extractRequestedExecutionMethods(ctx.experimentCode),
    });
    return message;
  }

  return callLLM(
    "You are a senior code reviewer. Review experiment code for correctness, efficiency, and best practices.",
    `Review this experiment code:\n\n${ctx.experimentCode}\n\nCheck for:\n1. Logical errors\n2. Statistical correctness\n3. Edge cases\n4. Performance issues\n5. Code quality and documentation\n6. Reproducibility\n7. Suggested improvements\n\nProvide a corrected version if needed.`
  );
}

async function stage11_experimentExecution(ctx: PipelineContext): Promise<string> {
  const hasDatasets = ctx.datasetFiles.length > 0;

  if (hasDatasets) {
    // Server-side data analysis with Chart.js rendering
    ctx.emit({
      type: "log", runId: ctx.runId, stageNumber: 11,
      message: "Executing data analysis and chart generation...",
      timestamp: Date.now(),
    });

    try {
      // Strip any remaining code block markers
      let codeBody = stripCodeBlockMarkers(ctx.experimentCode);
      const requestedMethods = extractRequestedExecutionMethods(codeBody);

      const emitExperimentProgress = (update: ExperimentProgressUpdate) => {
        ctx.emit({
          type: "log",
          runId: ctx.runId,
          stageNumber: 11,
          message: update.message,
          data: {
            phase: update.phase,
            heartbeat: update.heartbeat,
            elapsedMs: update.elapsedMs,
            chartCount: update.chartCount,
            tableCount: update.tableCount,
            metricCount: update.metricCount,
          },
          timestamp: Date.now(),
        });
      };

      const output = await executePythonExperiment(
        ctx.runId,
        11,
        codeBody,
        ctx.datasetFiles,
        ctx.methodContract,
        {
          heartbeatMs: 15_000,
          onProgress: emitExperimentProgress,
        },
      );

      ctx.experimentOutput = output;
      const analyticalMetricEntries = getAnalyticalMetricEntries(output);
      ctx.executionDiagnostics = buildExecutionDiagnostics(
        ctx.methodContract,
        output,
        analyticalMetricEntries.length,
        requestedMethods,
      );
      ctx.methodIntegrityNote = buildMethodIntegrityNote(ctx);
      await persistStageAudit(ctx, 11, {
        methodContract: ctx.methodContract,
        requestedExecutionMethods: requestedMethods,
        executionDiagnostics: ctx.executionDiagnostics,
        analyticalMetricCount: analyticalMetricEntries.length,
      });

      // Build result summary
      const chartSummary = output.charts.length > 0
        ? `\n\nGenerated Charts:\n${output.charts.map((c, i) => `  ${i + 1}. ${c.name}: ${c.description}`).join("\n")}`
        : "";
      const tableSummary = output.tables.length > 0
        ? `\n\nGenerated Tables:\n${output.tables.map((t, i) => `  ${i + 1}. ${t.name}: ${t.description}`).join("\n")}`
        : "";
      const metricsSummary = Object.keys(output.metrics).length > 0
        ? `\n\nKey Metrics:\n${Object.entries(output.metrics).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`
        : "";

      // Upload charts as artifacts
      for (const chart of output.charts) {
        const inferredFormat = chart.format || (chart.mimeType === "image/svg+xml" || chart.url.includes(".svg") ? "svg" : "png");
        const inferredMime = chart.mimeType || (inferredFormat === "svg" ? "image/svg+xml" : "image/png");
        const inferredKey = chart.fileKey || `experiments/${ctx.runId}/${chart.name}.${inferredFormat}`;
        await db.insertArtifact({
          runId: ctx.runId,
          stageNumber: 11,
          artifactType: "experiment_chart",
          fileName: `${chart.name}.${inferredFormat}`,
          fileUrl: chart.url,
          fileKey: inferredKey,
          mimeType: inferredMime,
        });
      }

      const resultText = `Analysis execution completed ${output.success ? "successfully" : "with errors"} in ${(output.executionTimeMs / 1000).toFixed(1)}s.\n\nExit code: ${output.exitCode}${chartSummary}${tableSummary}${metricsSummary}\n\nMETHOD FEASIBILITY CONTRACT:\n${formatMethodContract(ctx.methodContract)}\n\nEXECUTION DIAGNOSTICS:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}\n\nMETHOD EXECUTION INTEGRITY CHECK:\n${ctx.methodIntegrityNote}\n\nStdout:\n${output.stdout.substring(0, 3000)}${output.stderr ? `\n\nStderr:\n${output.stderr.substring(0, 1000)}` : ""}`;

      ctx.experimentResults = resultText;
      return resultText;
    } catch (err: any) {
      console.warn("[Pipeline] Data analysis failed, using non-fabricated failure mode:", err?.message);
      ctx.emit({
        type: "log", runId: ctx.runId, stageNumber: 11,
        message: `Data analysis failed: ${err?.message}. Proceeding without fabricated empirical results.`,
        timestamp: Date.now(),
      });
      // Fall through to explicit failure reporting below
    }
  }

  // No real data analysis available — record this fact clearly
  // DO NOT ask LLM to "simulate" or "generate realistic" numbers — this causes hallucination
  if (hasDatasets) {
    // Data analysis was attempted but failed
    ctx.experimentResults = `DATA ANALYSIS STATUS: FAILED\n\nThe uploaded dataset(s) could not be fully analysed due to technical errors. No empirical metrics, correlations, or p-values were computed from the actual data. The paper should acknowledge this limitation and present the methodology and analytical framework without fabricated numerical results.\n\nDatasets uploaded: ${ctx.datasetFiles.map(d => d.originalName).join(", ")}\nColumns available: ${ctx.datasetFiles.map(d => d.columnNames?.join(", ") || "unknown").join("; ")}`;
    const blocked = uniqMethodIds([
      ...(ctx.methodContract?.requiresMissingData || []),
      ...(ctx.methodContract?.futureWorkOnly || []),
    ]);
    const blockedReasonLines = Object.entries(ctx.methodContract?.blockedReasons || {})
      .map(([method, reason]) => `- ${method}: ${reason}`)
      .join("\n");
    const blockedSummary = blocked.length > 0
      ? `\nBlocked/unsupported methods from contract: ${blocked.join(", ")}${blockedReasonLines ? `\nBlocked reason details:\n${blockedReasonLines}` : ""}`
      : "";
    const missingExec = (ctx.methodContract?.executableNow || []).length > 0
      ? `\nExecutable methods that could not be evidenced: ${(ctx.methodContract?.executableNow || []).join(", ")}`
      : "";
    ctx.experimentResults += `${missingExec}${blockedSummary}`;
    ctx.executionDiagnostics = {
      executionStatus: "failed",
      executableRequested: ctx.methodContract?.executableNow || [],
      executedMethods: [],
      missingRequested: ctx.methodContract?.executableNow || [],
      analyticalMetricCount: 0,
      chartCount: 0,
      tableCount: 0,
      failureReasons: [
        "Execution crashed before analytical outputs were produced.",
        ...(blockedReasonLines ? [blockedReasonLines] : []),
      ],
    };
    ctx.methodIntegrityNote = "Execution failed; no methods can be claimed as empirically executed.";
    await persistStageAudit(ctx, 11, {
      methodContract: ctx.methodContract,
      executionDiagnostics: ctx.executionDiagnostics,
      analyticalMetricCount: 0,
      failureMode: "dataset_execution_failed",
    });
  } else {
    // No datasets at all — purely theoretical paper
    ctx.experimentResults = `DATA ANALYSIS STATUS: NO DATASETS\n\nNo empirical datasets were provided. This is a theoretical/conceptual paper. All numerical results in the paper should be clearly marked as hypothetical examples or derived from cited literature, NOT presented as original empirical findings.`;
    ctx.executionDiagnostics = {
      executionStatus: "failed",
      executableRequested: [],
      executedMethods: [],
      missingRequested: [],
      analyticalMetricCount: 0,
      chartCount: 0,
      tableCount: 0,
      failureReasons: ["No datasets provided."],
    };
    ctx.methodIntegrityNote = "No datasets provided; empirical method claims are not allowed.";
    await persistStageAudit(ctx, 11, {
      methodContract: ctx.methodContract,
      executionDiagnostics: ctx.executionDiagnostics,
      analyticalMetricCount: 0,
      failureMode: "no_dataset",
    });
  }
  return ctx.experimentResults;
}

async function stage12_resultCollection(ctx: PipelineContext): Promise<string> {
  const analyticalMetrics = getAnalyticalMetricEntries(ctx.experimentOutput);
  const hasRealData = analyticalMetrics.length > 0;
  const experimentChartInfo = ctx.experimentOutput?.charts.length
    ? `\n\nActual generated charts from data analysis:\n${ctx.experimentOutput.charts.map((c, i) => `${i + 1}. ${c.name}: ${c.description}`).join("\n")}`
    : "";
  const experimentMetrics = hasRealData
    ? `\n\nActual computed analytical metrics (these are the ONLY valid numerical results):\n${analyticalMetrics.map(([k, v]) => `${k}: ${v}`).join("\n")}`
    : "";
  const experimentTables = ctx.experimentOutput?.tables.length
    ? `\n\nActual computed tables:\n${ctx.experimentOutput.tables.map((t, i) => `Table ${i + 1}: ${t.name}\n${t.data?.substring(0, 800)}`).join("\n\n")}`
    : "";
  const contractBlock = `\n\nMethod feasibility contract:\n${formatMethodContract(ctx.methodContract)}`;
  const executionBlock = `\n\nExecution diagnostics:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}`;

  const result = await callLLM(
    `You are a data analyst organizing experimental results. CRITICAL ANTI-HALLUCINATION RULES:\n1. You may ONLY report numerical values that appear in the "Actual computed metrics" or "Actual computed tables" sections below.\n2. Do NOT invent, estimate, or extrapolate any numbers not explicitly provided.\n3. If no actual metrics are provided, state: "Empirical analysis could not be completed. No numerical results are available."\n4. Never write phrases like "results show" or "we found" followed by numbers you generated yourself.`,
    `Organize these experiment results into structured format:\n\n${ctx.experimentResults}${experimentChartInfo}${experimentMetrics}${experimentTables}${contractBlock}${executionBlock}\n\nProvide:\n1. Summary of what data was actually analysed (based ONLY on the information above)\n2. List of actual computed metrics (copy them verbatim from above, do NOT add new ones)\n3. Description of generated charts and tables\n4. Data quality assessment\n5. Limitations of the analysis\n\n${!hasRealData ? "IMPORTANT: No empirical metrics were computed. State this clearly. Do NOT fabricate any numbers." : ""}`
  );
  await persistStageAudit(ctx, 12, {
    hasRealData,
    analyticalMetricCount: analyticalMetrics.length,
    methodContract: ctx.methodContract,
    executionDiagnostics: ctx.executionDiagnostics,
  });
  return result;
}

async function stage13_statisticalAnalysis(ctx: PipelineContext): Promise<string> {
  const analyticalMetrics = getAnalyticalMetricEntries(ctx.experimentOutput);
  const hasRealMetrics = analyticalMetrics.length > 0;
  const experimentMetrics = hasRealMetrics
    ? `\n\nActual computed analytical metrics from data analysis (ONLY these numbers are valid):\n${analyticalMetrics.map(([k, v]) => `${k}: ${v}`).join("\n")}`
    : "";
  const experimentTables = ctx.experimentOutput?.tables.length
    ? `\n\nActual computed tables from data analysis:\n${ctx.experimentOutput.tables.map((t, i) => `Table ${i + 1}: ${t.name}\n${t.data?.substring(0, 800)}`).join("\n\n")}`
    : "";
  const contractBlock = `\n\nMethod feasibility contract:\n${formatMethodContract(ctx.methodContract)}`;
  const executionBlock = `\n\nExecution diagnostics:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}`;

  const result = await callLLM(
    `You are a statistician. CRITICAL ANTI-HALLUCINATION RULES:\n1. You may ONLY discuss and interpret numerical values that appear in the "Actual computed metrics" or "Actual computed tables" sections.\n2. Do NOT invent p-values, confidence intervals, effect sizes, or any other statistics not explicitly computed.\n3. If no actual metrics are provided, describe WHAT statistical tests SHOULD be performed and WHY, but do NOT report any numerical results.\n4. Clearly distinguish between "computed results" and "recommended analyses".`,
    `${hasRealMetrics ? "Interpret and discuss" : "Describe the statistical analysis plan for"} these results:\n\n${ctx.experimentResults}${experimentMetrics}${experimentTables}${contractBlock}${executionBlock}\n\n${hasRealMetrics ? `Interpret the actual computed metrics above:\n1. What do these descriptive statistics tell us?\n2. What patterns or trends are visible?\n3. What additional statistical tests would strengthen the analysis?\n4. What are the limitations of the current analysis?\n5. Explicitly summarise methodology applicability using any method_readiness_* and method_status_* metrics, distinguishing executable_now vs partially_ready vs blocked methods.\n\nIMPORTANT: Only discuss the numbers provided above. Do NOT generate new statistics.` : `No empirical metrics were computed from the data. Describe:\n1. What statistical tests SHOULD be performed (but do NOT report results)\n2. What descriptive statistics would be informative\n3. Recommended hypothesis tests and their rationale\n4. Required assumptions and how to validate them\n5. Suggested sample size and power analysis approach\n6. A methodology applicability matrix (executable_now / partially_ready / blocked) with prerequisite checks\n\nIMPORTANT: Do NOT fabricate any numerical results. Only describe the analytical plan.`}`
  );
  ctx.statisticalAnalysis = result;
  await persistStageAudit(ctx, 13, {
    hasRealMetrics,
    analyticalMetricCount: analyticalMetrics.length,
    methodContract: ctx.methodContract,
    executionDiagnostics: ctx.executionDiagnostics,
  });
  return result;
}

async function stage14_figureGeneration(ctx: PipelineContext): Promise<string> {
  // If we have real charts from Python execution, reference them
  if (ctx.experimentOutput?.charts.length) {
    const chartList = ctx.experimentOutput.charts.map((c, i) =>
      `Figure ${i + 1}: ${c.name} - ${c.description} (URL: ${c.url})`
    ).join("\n");

    const result = await callLLM(
      "You are a scientific visualization expert. Describe the generated figures for inclusion in the paper.",
      `The following figures were generated from actual data analysis:\n\n${chartList}\n\nBased on these results:\n${ctx.experimentResults?.substring(0, 3000)}\n\nFor each figure, provide:\n1. A detailed caption suitable for a research paper\n2. Description of what the figure shows\n3. Key observations from the visualization\n4. How it supports the research hypothesis\n5. Academic-quality checklist (axis labels and units, legend clarity, sample size context, and whether confidence/statistical uncertainty information is shown or unavailable)\n\nAlso suggest any additional figures that would strengthen the paper.`
    );
    ctx.figures = [result];
    return result;
  }

  const noFigureMessage = "No chart artifacts were generated from executed analysis. Figures are intentionally omitted to avoid simulated or fabricated visual evidence.";
  ctx.figures = [noFigureMessage];
  return noFigureMessage;
}

async function stage15_tableGeneration(ctx: PipelineContext): Promise<string> {
  const hasRealTables = ctx.experimentOutput?.tables && ctx.experimentOutput.tables.length > 0;
  const experimentTables = hasRealTables
    ? `\n\nActual computed tables from data analysis (use ONLY these values):\n${ctx.experimentOutput!.tables.map((t, i) => `Table ${i + 1}: ${t.name}\n${t.data?.substring(0, 1000)}`).join("\n\n")}`
    : "";
  const analyticalMetrics = getAnalyticalMetricEntries(ctx.experimentOutput);
  const hasRealMetrics = analyticalMetrics.length > 0;
  const experimentMetrics = hasRealMetrics
    ? `\n\nActual computed analytical metrics:\n${analyticalMetrics.map(([k, v]) => `${k}: ${v}`).join("\n")}`
    : "";
  const contractBlock = `\n\nMethod feasibility contract:\n${formatMethodContract(ctx.methodContract)}`;
  const executionBlock = `\n\nExecution diagnostics:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}`;

  const result = await callLLM(
    `You are a scientific table designer. Create publication-quality LaTeX tables.\n\nCRITICAL ANTI-HALLUCINATION RULES:\n1. Tables MUST contain ONLY values from the "Actual computed tables" or "Actual computed metrics" sections.\n2. Do NOT invent, estimate, or fabricate any numerical values.\n3. If no actual data is provided, create tables showing the STRUCTURE only (column headers, row labels) with "—" or "N/A" in data cells, and add a note explaining that empirical values are pending.\n4. Every number in every cell must be traceable to the provided data.`,
    `${hasRealTables || hasRealMetrics ? "Format the following actual data into publication-quality LaTeX tables" : "Describe the table structures that WOULD be included in an empirical version of this paper"}:\n\n${ctx.experimentResults}\n${ctx.statisticalAnalysis?.substring(0, 2000)}${experimentTables}${experimentMetrics}${contractBlock}${executionBlock}\n\n${hasRealTables ? `Convert the actual computed tables above into LaTeX format using booktabs. Preserve ALL original values exactly as computed. Do NOT round, adjust, or add values.` : `No empirical data tables were computed. Do NOT generate LaTeX table environments with empty cells or placeholder dashes.\nInstead, provide a PROSE DESCRIPTION of what tables the empirical study would include:\n1. Describe the structure of the main results table (what columns, what rows, what metrics)\n2. Describe the structure of the descriptive statistics table\n3. Use paragraph form, NOT LaTeX table environments\nThis ensures the paper reads well without empty placeholder tables.`}\n\nIn all cases, include (using available data only):\n- A descriptive-statistics table (if any descriptive metrics exist)\n- A methodology applicability table that clearly marks executable_now / partially_ready / blocked methods\n- Brief table notes about assumptions, sample coverage, and interpretation boundaries\n\nTable formatting rules (for real data only):\n- Use \\resizebox{\\textwidth}{!}{...} for tables with 4+ columns\n- Use booktabs (\\toprule, \\midrule, \\bottomrule)\n- Do NOT use sisetup or S column type\n- Keep column headers SHORT (abbreviate if needed)`
  );
  ctx.tables = [result];
  await persistStageAudit(ctx, 15, {
    hasRealTables: !!hasRealTables,
    hasRealMetrics,
    methodContract: ctx.methodContract,
    executionDiagnostics: ctx.executionDiagnostics,
  });
  return result;
}

async function stage16_outlineGeneration(ctx: PipelineContext): Promise<string> {
  const fieldCtx = buildFieldContext(ctx);
  const venueLabel = ctx.config.targetConference === "General" ? `a leading venue in ${inferResearchField(ctx)}` : ctx.config.targetConference;
  const econometricGuidance = buildEconometricWritingGuidance(ctx);
  const result = await callLLM(
    `You are an academic paper outline generator. ${fieldCtx}`,
    `Research topic: "${ctx.topic}"\nMethod contract:\n${formatMethodContract(ctx.methodContract)}\nExecution diagnostics:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}${econometricGuidance ? `\n\n${econometricGuidance}` : ""}\n\nGenerate a detailed paper outline suitable for ${venueLabel}:\n1. Title (compelling, specific)\n2. Abstract outline (key points)\n3. Introduction structure (motivation, contributions)\n4. Related Work / Literature Review organization\n5. Methodology section structure\n6. Experiments / Empirical Analysis section structure\n7. Results and Discussion\n8. Conclusion and Future Work\n9. Appendix items\n\nInclude explicit subsection placeholders for:\n- Construct operationalisation and falsification logic\n- Estimands, model equations, identifying assumptions, and diagnostics where applicable\n- Evidence-backed findings only\n- Execution limitations and unmet data prerequisites\n\nAdapt the section naming and structure to conventions in ${inferResearchField(ctx)}.`
  );
  ctx.outline = result;
  return result;
}

async function stage17_abstractWriting(ctx: PipelineContext): Promise<string> {
  const analyticalMetrics = getAnalyticalMetricEntries(ctx.experimentOutput);
  const hasRealMetrics = analyticalMetrics.length > 0;
  const metricsForAbstract = hasRealMetrics
    ? `\n\nActual computed analytical metrics (you may cite ONLY these specific numbers):\n${analyticalMetrics.map(([k, v]) => `${k}: ${v}`).join("\n")}`
    : "";
  const methodIntegrityBlock = ctx.methodIntegrityNote
    ? `\n\nMethod execution integrity note:\n${ctx.methodIntegrityNote}`
    : "";
  const contractBlock = `\n\nMethod feasibility contract:\n${formatMethodContract(ctx.methodContract)}`;
  const executionBlock = `\n\nExecution diagnostics:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}`;
  const econometricGuidance = buildEconometricWritingGuidance(ctx);

  const result = await callLLM(
    `You are an expert academic writer. ${buildFieldContext(ctx)} Write a compelling abstract. Use British English spelling and academic tone.\n\nCRITICAL ANTI-HALLUCINATION RULES:\n1. You may ONLY cite specific numbers that appear in the "Actual computed analytical metrics" section below.\n2. If no actual analytical metrics are provided, write the abstract WITHOUT specific numerical claims. Use qualitative descriptions instead (e.g., "we analyse", "we propose", "our framework examines").\n3. Do NOT invent percentages, p-values, effect sizes, or any other statistics.\n4. If methodology mentions techniques not executed, frame them as planned/future work, never as completed evidence.\n\nMETHODOLOGY ALIGNMENT RULES:\n5. The abstract MUST NOT mention unexecuted methods as contributions or methods of this paper.\n6. Only describe the methods that were actually executed (see execution diagnostics below).\n7. Unexecuted methods may be mentioned ONLY in a single sentence about future directions at the end of the abstract.\n8. The abstract should accurately reflect what the paper delivers, not what it aspires to deliver.`,
    `Research topic: "${ctx.topic}"\nOutline:\n${ctx.outline}\nStatistical analysis:\n${ctx.statisticalAnalysis?.substring(0, 2000)}${metricsForAbstract}${methodIntegrityBlock}${contractBlock}${executionBlock}${econometricGuidance ? `\n\n${econometricGuidance}` : ""}\n\nWrite a 150-250 word abstract that:\n1. States the problem clearly\n2. Describes the approach and methodology\n3. ${hasRealMetrics ? "Highlights key results using ONLY the actual computed analytical metrics above" : "Describes the analytical framework and expected contributions WITHOUT fabricating numerical results"}\n4. States the main contribution\n5. If econometric methods are central, summarises the identification logic and empirical design without overstating causal claims\n\n${!hasRealMetrics ? "IMPORTANT: No empirical analytical metrics are available. Write the abstract focusing on the research question, methodology, and analytical framework. Do NOT include any specific numbers, percentages, or statistical values." : ""}`
  );
  ctx.abstract = result;
  await persistStageAudit(ctx, 17, {
    hasRealMetrics,
    methodContract: ctx.methodContract,
    executionDiagnostics: ctx.executionDiagnostics,
  });
  return result;
}

async function stage18_bodyWriting(ctx: PipelineContext): Promise<string> {
  // Build numbered reference list with stable BibTeX keys (ref1, ref2, ...) for citation alignment.
  // Stage 18 uses [1], [2] in Markdown body; Stage 20 converts these to \cite{ref1}, \cite{ref2} in LaTeX.
  const numberedRefs = ctx.papers.slice(0, 20).map((p, i) => {
    const authors = p.authors || "Unknown";
    const year = p.year || "n.d.";
    const venue = p.venue ? `, ${p.venue}` : "";
    return `[${i + 1}] (key: ref${i + 1}) ${authors}. "${p.title}". ${year}${venue}.`;
  }).join("\n");

  // Build data analysis results section for the prompt
  let dataAnalysisSection = "";
  if (ctx.experimentOutput) {
    const chartRefs = ctx.experimentOutput.charts.map((c, i) =>
      `Figure ${i + 1}: ${c.name} - ${c.description}`
    ).join("\n");
    const tableRefs = ctx.experimentOutput.tables.map((t, i) =>
      `Table ${i + 1}: ${t.name} - ${t.description}`
    ).join("\n");
    const metricsText = getAnalyticalMetricEntries(ctx.experimentOutput)
      .map(([k, v]) => `${k}: ${v}`).join("\n");

    dataAnalysisSection = `\n\n## Data Analysis Results (from actual dataset analysis)\nCharts generated:\n${chartRefs}\n\nTables generated:\n${tableRefs}\n\nAnalytical metrics:\n${metricsText || "None"}\n\nMethod feasibility contract:\n${formatMethodContract(ctx.methodContract)}\n\nExecution diagnostics:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}\n\nMethod integrity note:\n${ctx.methodIntegrityNote || "No integrity note available."}\n\nIMPORTANT: Reference these actual figures and tables in the paper body. Use "Figure 1", "Table 1" etc. to refer to them. The results section should discuss these actual analysis outputs only.\n\nIf method applicability metrics are present (e.g., method_readiness_* / method_status_* / method_applicability_summary), explicitly discuss what is executable now versus only partially ready versus blocked.`;
  }

  const hasRealMetrics = getAnalyticalMetricEntries(ctx.experimentOutput).length > 0;
  const hasRealCharts = ctx.experimentOutput?.charts && ctx.experimentOutput.charts.length > 0;
  const hasRealTables = ctx.experimentOutput?.tables && ctx.experimentOutput.tables.length > 0;
  const econometricGuidance = buildEconometricWritingGuidance(ctx);

  const executedMethodsList = ctx.executionDiagnostics?.executedMethods?.join(", ") || "none";
  const blockedMethodsList = [
    ...(ctx.methodContract?.requiresMissingData || []),
    ...(ctx.methodContract?.futureWorkOnly || []),
  ].join(", ") || "none";

  let antiHallucinationRules = "";
  if (hasRealMetrics || hasRealCharts || hasRealTables) {
    antiHallucinationRules = `\n\nANTI-HALLUCINATION RULES:\n1. In the Results section, you may ONLY report numerical values from the "Data Analysis Results" section above.\n2. When discussing figures and tables, describe what they show based on the provided descriptions.\n3. Do NOT invent additional statistics, p-values, or effect sizes beyond what is provided.\n4. If you need to discuss implications, use hedged language ("suggests", "indicates", "is consistent with").\n5. Any methodology component not confirmed by the method integrity note must be framed as unexecuted/future work.\n6. If method applicability metrics are available, include a dedicated subsection that classifies method families into executable_now, partially_ready, and blocked, and tie this classification to prerequisites/limitations.\n7. Descriptive statistics and academic-quality visualisation discussion must be included whenever such outputs exist.\n\nMETHODOLOGY-RESULTS ALIGNMENT (CRITICAL):\n- Actually executed methods: ${executedMethodsList}\n- Blocked/unexecuted methods: ${blockedMethodsList}\n- The Methodology section MUST describe ONLY the analyses that were actually executed.\n- Methods listed as blocked/unexecuted MUST appear ONLY in a "Limitations and Future Work" subsection, clearly marked as "not yet implemented" or "planned for future work".\n- The paper title MUST NOT reference unexecuted methods as if they are the paper's contribution.\n- Do NOT describe any blocked or unexecuted method as something "we apply" or "we implement" — only as "future work".`;
  } else {
    antiHallucinationRules = `\n\nCRITICAL ANTI-HALLUCINATION RULES (NO DATASET MODE):\n1. No empirical results were computed from the data. The Results and Discussion section MUST be framed as a methodological discussion, NOT as a results presentation.\n2. Do NOT fabricate any numerical results, p-values, correlations, means, standard deviations, or effect sizes.\n3. Instead, describe the analytical FRAMEWORK: what analyses would be performed, what metrics would be computed, and what patterns would be examined.\n4. Use conditional language throughout: "would", "is expected to", "the analysis aims to".\n5. Do NOT include any tables with empty cells, placeholder dashes ("—"), or "N/A" values. Instead, describe what the tables WOULD contain in prose form.\n6. Do NOT include a "DATA ANALYSIS STATUS" line or "Research Classification" section — these are internal metadata.\n7. Do NOT include an "Execution Limitations" section — limitations should be discussed within the Discussion section naturally.\n\nPAPER FRAMING (CRITICAL):\n- This paper should be framed as a METHODOLOGICAL FRAMEWORK or RESEARCH PROTOCOL paper, not an empirical study.\n- The "Results and Discussion" section should discuss the EXPECTED OUTCOMES of the proposed framework, the interpretive logic, and methodological merits.\n- Blocked/unexecuted methods: ${blockedMethodsList}\n- Do NOT use past tense ("we found", "we demonstrated") for unexecuted analyses. Use future/conditional tense only.\n- The paper should be self-contained and valuable as a methodological contribution even without empirical data.`;
  }

  const firstPass = await callLLM(
    `You are an expert academic writer. ${buildFieldContext(ctx)} Use British English spelling. You MUST cite the provided references throughout the paper body using numbered citations like [1], [2], [3], etc. Every claim derived from prior work must include a citation. The Related Work / Literature Review section must cite at least 8 references. The Introduction should cite at least 3-5 references to motivate the research.${antiHallucinationRules}

WRITING QUALITY REQUIREMENTS:
- Each section must be substantive (at least 3-4 paragraphs for major sections like Methodology, Results).
- Avoid single-sentence subsections. Every subsection must have at least 2 paragraphs of detailed content.
- Use formal academic prose, not bullet points, for the main body text.
- Methodology must include: (a) formal problem definition with mathematical notation where appropriate, (b) clear estimands and model equations for executed econometric/causal methods, (c) identifying assumptions and inference specification where relevant, (d) detailed description of the analytical framework or model, (e) data preprocessing steps, (f) variable operationalisation.
- Experiments must include: (a) dataset description (source, size, time period, key variables), (b) experimental setup and implementation details, (c) evaluation metrics with definitions, (d) baseline methods for comparison.
- Results must include: (a) main findings with reference to specific tables and figures, (b) discussion of statistical uncertainty and design diagnostics where applicable, (c) comparison with baselines or prior work, (d) limitations and potential confounds.`,
    `Write the complete paper body in Markdown format.\n\nTopic: "${ctx.topic}"\nAbstract: ${ctx.abstract}\nOutline: ${ctx.outline}\nHypothesis package: ${ctx.hypothesis}\nMethodology: ${ctx.methodology}\nResults: ${ctx.experimentResults?.substring(0, 3000)}\nStatistical Analysis: ${ctx.statisticalAnalysis?.substring(0, 2000)}${dataAnalysisSection}${econometricGuidance ? `\n\n## ${econometricGuidance}` : ""}\n\n## Available References (use these numbered citations in the text):\n${numberedRefs}\n\nWrite complete sections with the following MINIMUM requirements:\n\n1. **Introduction** (at least 4 paragraphs) — Motivate the research problem with real-world significance, cite relevant prior work using [1], [2] etc., identify the specific research gap, and clearly state contributions (as a numbered list at the end of the Introduction).\n\n2. **Related Work** (at least 3 subsections) — Thoroughly review the literature. Cite each referenced paper by its number [1]-[${ctx.papers.slice(0, 20).length}]. Group related works thematically into subsections (e.g., "2.1 Prior Work on X", "2.2 Approaches to Y", "2.3 Gap Analysis"). Each subsection must have at least 2 paragraphs.\n\n3. **Methodology** (at least 4 subsections) — This is a CRITICAL section that must be detailed:\n   3.1 **Problem Formulation and Estimands** — Formally define the research problem. Use mathematical notation where appropriate (e.g., define variables, objective functions, hypotheses, and estimands).\n   3.2 **Analytical Framework / Model Description** — Describe the proposed approach step by step. Include model equations, data preprocessing, feature engineering, or variable operationalisation. Explain WHY each methodological choice was made.\n   3.3 **Identification, Inference, and Diagnostics** — For econometric or causal methods, state identifying assumptions, uncertainty quantification, and the diagnostic/falsification logic. If a method is unexecuted, explicitly mark it as future work.\n   3.4 **Implementation Details** — Describe tools, libraries, parameters, and computational environment used.\n   3.5 **Operationalisation and Falsification Logic** — explicitly map each core hypothesis to operational variables, executable tests, and falsification criteria.\n\n4. **Experiments** (at least 3 subsections) —\n   4.1 **Dataset Description** — Source, collection method, time period, sample size, key variables with descriptive statistics.\n   4.2 **Experimental Setup** — ${hasRealMetrics ? "Describe the exact configuration, parameterisation, standard-error or uncertainty specification, and reproducibility measures." : "Describe the planned experimental configuration and reproducibility measures. Acknowledge that full empirical results are pending."}\n   4.3 **Evaluation Metrics and Diagnostic Quantities** — Define each metric mathematically (e.g., accuracy = TP+TN/N, RMSE = sqrt(1/n * sum(yi - y_hat_i)^2)). For econometric designs, define the estimands and diagnostic quantities in words and equations.\n   4.4 **Baselines / Comparison Designs** — Describe comparison methods and why they were chosen.\n\n5. **Results and Discussion** (at least 4 paragraphs) — ${hasRealMetrics ? "Present findings using ONLY the actual computed metrics. Structure as: (a) Main results with table/figure references, (b) Interpretation of coefficient intervals, design diagnostics, or specialised econometric plots where available, (c) Comparison with baselines or prior work, (d) Limitations and threats to validity." : "Describe the analytical framework and what the results WOULD show. Do NOT fabricate any numbers. Use conditional language. Discuss expected patterns, required diagnostics, potential limitations, and how results would be interpreted."}\n\n6. **Conclusion and Future Work** (at least 2 paragraphs) — Summarise contributions (matching the numbered list from Introduction), discuss broader implications, and outline concrete future research directions.\n\n7. **Research Classification** — Add one explicit label and one short justification:\n   - empirical (if supported by executed evidence), or\n   - methodological_protocol (if empirical evidence is incomplete).\n\n8. **References** — List all cited references in the format:\n   [1] Authors. "Title". Year, Venue.\n   [2] Authors. "Title". Year, Venue.\n   ... (include ALL references from the list above that were cited in the text)\n\nIMPORTANT: You MUST include inline citations [1], [2], etc. throughout the text. The References section at the end MUST list every cited paper. Each major section must be substantive — no single-sentence sections or subsections.`,
    32768
  );
  const claimCheck = buildClaimVerificationReport(ctx, firstPass);
  ctx.claimVerificationReport = claimCheck.report;
  await persistStageAudit(ctx, 18, {
    claimVerificationReport: ctx.claimVerificationReport,
    flaggedClaimsCount: claimCheck.flaggedClaims.length,
    methodContract: ctx.methodContract,
    executionDiagnostics: ctx.executionDiagnostics,
  });

  let result = firstPass;
  if (claimCheck.flaggedClaims.length > 0) {
    result = await callLLM(
      `You are an expert academic editor. Rewrite the paper body to remove unsupported empirical/method claims while preserving quality and structure.`,
      `Original body:\n${firstPass}\n\nClaim verifier report:\n${ctx.claimVerificationReport}\n\nMethod feasibility contract:\n${formatMethodContract(ctx.methodContract)}\n\nExecution diagnostics:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}\n\nRewrite requirements:\n1. Remove or reframe all flagged unsupported claims.\n2. Any method in requires_missing_data/future_work_only MUST be written as planned/future work only.\n3. Keep only evidence-backed empirical claims.\n4. Preserve section structure and citations.\n5. Do not add new quantitative values unless already in analytical metrics/tables.`
    );
  }
  const secondCheck = buildClaimVerificationReport(ctx, result);
  if (secondCheck.flaggedClaims.length > 0) {
    result = await callLLM(
      `You are an academic compliance editor. Perform a strict final pass to eliminate unsupported claims.`,
      `Draft body:\n${result}\n\nSecond-pass claim verifier report:\n${secondCheck.report}\n\nMethod feasibility contract:\n${formatMethodContract(ctx.methodContract)}\n\nExecution diagnostics:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}\n\nApply strict edits:\n1. Remove unsupported assertive claims.\n2. Replace unsupported completed-method wording with "planned/future work" wording.\n3. Preserve section structure and citation markers.\n4. Keep only evidence-backed numbers and references to actually generated figures/tables.`
    );
    ctx.claimVerificationReport = buildClaimVerificationReport(ctx, result).report;
  }
  // Completeness check: ensure the paper has all required sections
  const requiredSections = ["Introduction", "Related Work", "Methodology", "Experiment", "Result", "Conclusion"];
  const missingSections = requiredSections.filter(sec => {
    const pattern = new RegExp(`(?:^|\\n)#+\\s*\\d*\\.?\\s*${sec}`, "i");
    return !pattern.test(result) && !result.toLowerCase().includes(sec.toLowerCase());
  });

  if (missingSections.length > 2) {
    console.warn(`[Pipeline] Paper body missing ${missingSections.length} sections: ${missingSections.join(", ")}. The paper may be incomplete.`);
    // Append a note about missing sections so downstream stages are aware
    ctx.paperBody = result + `\n\n<!-- WARNING: The following sections may be incomplete or missing: ${missingSections.join(", ")} -->\n`;
  } else {
    ctx.paperBody = result;
  }
  return result;
}

async function stage19_referenceFormatting(ctx: PipelineContext): Promise<string> {
  // Use stable numbered keys (ref1, ref2, ...) that match the [1], [2] citation style from Stage 18.
  // This ensures \cite{ref1} in LaTeX corresponds to \bibitem{ref1} = paper #1.
  const bibtexEntries = ctx.papers.slice(0, 20).map((p, i) => {
    const key = `ref${i + 1}`;
    // Always regenerate BibTeX with the stable key to guarantee consistency
    const author = p.authors || "Unknown";
    const title = p.title || "Unknown title";
    const year = p.year || "n.d.";
    const venue = p.venue || "";
    const doi = p.doi || "";
    const url = p.url || "";
    return `@article{${key},\n  title = {${title}},\n  author = {${author}},\n  year = {${year}},\n  journal = {${venue}},\n  doi = {${doi}},\n  url = {${url}}\n}`;
  }).join("\n\n");
  ctx.references = bibtexEntries;
  return `Generated BibTeX file with ${ctx.papers.slice(0, 20).length} references.\n\n${bibtexEntries}`;
}

function postProcessLatexSource(latex: string): string {
  let result = latex;
  result = result.replace(/\\newcommand\{\\sci\}(?:\[[^\]]+\])?\{[\s\S]*?\}/g, "\\newcommand{\\sci}[2]{#1 \\\\times 10^{#2}}");
  result = result.replace(/\\newcommand\{\\sci\}\\cite\{[^}]+\}\{[^}]+\}/g, "\\newcommand{\\sci}[2]{#1 \\\\times 10^{#2}}");
  if (!/\\newcommand\{\\sci\}\[2\]/.test(result)) {
    result = result.replace(/\\usepackage\[T1\]\{fontenc\}[^\n]*\n/, (match) => `${match}\\newcommand{\\sci}[2]{#1 \\\\times 10^{#2}}\n`);
  }
  result = result.replace(/`([^`\n]+)`/g, "\\texttt{$1}");
  result = result.replace(/\\title\{\s*\\textbf\{([^}]+)\}\s*\}/g, "\\title{$1}");
  result = result.replace(/\\author\{\s*\\textbf\{([^}]+)\}/g, "\\author{$1");
  return result;
}

async function stage20_latexCompilation(ctx: PipelineContext): Promise<string> {
  // Build figure instructions if we have experiment-generated charts
  let figureInstructions = "";
  if (ctx.experimentOutput?.charts.length) {
    const figureList = ctx.experimentOutput.charts.map((c, i) => {
      const figKey = `figure_${i + 1}`;
      return `  - Figure ${i + 1}: key="${figKey}", caption="${c.name}: ${c.description}"`;
    }).join("\n");

    figureInstructions = `\n\n## IMPORTANT: Embed Data Analysis Figures\nThe following figures were generated from actual data analysis and MUST be embedded in the LaTeX document using \\includegraphics.\nFor each figure, use this exact pattern:\n\n\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.85\\textwidth]{<figure_key>}\n  \\caption{<caption text>}\n  \\label{fig:<label>}\n\\end{figure}\n\nAvailable figures:\n${figureList}\n\nPlace each figure in the most appropriate section (typically Results or Experiments). Use the exact figure key (e.g., figure_1, figure_2) as the argument to \\includegraphics. The graphicx package must be included in the preamble. Reference each figure in the text using \\ref{fig:<label>}.`;
  }

  // Build a strict data manifest: only these numbers may appear in the paper
  const analyticalMetrics = getAnalyticalMetricEntries(ctx.experimentOutput);
  const hasRealMetrics = analyticalMetrics.length > 0;
  const hasRealTables = ctx.experimentOutput?.tables && ctx.experimentOutput.tables.length > 0;
  let dataManifest = "";
  if (hasRealMetrics || hasRealTables) {
    dataManifest = `\n\n## ANTI-HALLUCINATION DATA MANIFEST\nThe following is the COMPLETE set of numerical results computed from the actual dataset.\nYou MUST use ONLY these values in the Results section. Do NOT invent, extrapolate, or add ANY numbers not listed here.\n`;
    if (hasRealMetrics) {
      dataManifest += `\nComputed Analytical Metrics:\n${analyticalMetrics.map(([k, v]) => `  ${k} = ${v}`).join("\n")}\n`;
    }
    if (hasRealTables) {
      dataManifest += `\nComputed Tables (use these exact values in LaTeX tables):\n${ctx.experimentOutput!.tables.map((t, i) => `  Table ${i + 1}: ${t.name}\n${t.data?.substring(0, 1200)}`).join("\n\n")}\n`;
    }
    dataManifest += `\nMethod feasibility contract:\n${formatMethodContract(ctx.methodContract)}\n`;
    dataManifest += `\nExecution diagnostics:\n${formatExecutionDiagnostics(ctx.executionDiagnostics)}\n`;
    dataManifest += `\nMethod execution integrity:\n${ctx.methodIntegrityNote || "No integrity note available."}\n`;
    if (ctx.claimVerificationReport) {
      dataManifest += `\nClaim verification report:\n${ctx.claimVerificationReport}\n`;
    }
    const econometricGuidance = buildEconometricWritingGuidance(ctx);
    if (econometricGuidance) {
      dataManifest += `\n${econometricGuidance}\n`;
    }
    dataManifest += `\nRULES:\n- Every number in the Results/Discussion sections MUST come from the list above.\n- If a statistic is not listed above, do NOT include it.\n- Do NOT add p-values, effect sizes, confidence intervals, or any other statistics unless they appear above.\n- Tables must reproduce the exact values from "Computed Tables" above.\n- If the data is insufficient, state the limitation rather than fabricating values.\n- Any method not explicitly supported by the method execution integrity note must be presented as planned/future work only.`;
  } else {
    dataManifest = `\n\n## ANTI-HALLUCINATION NOTICE (NO DATASET)\nNo empirical metrics were computed from the data. The LaTeX document MUST:\n- Frame the paper as a methodological framework/protocol, NOT as an empirical study\n- Describe the analytical framework without fabricating any numbers\n- Use conditional language ("would", "is expected to")\n- NOT contain any specific numerical results, p-values, correlations, means, or standard deviations\n- NOT include tables with empty/placeholder cells (dashes "---", "N/A", or blank cells). If table structures are needed, describe them in prose instead.\n- NOT include a "DATA ANALYSIS STATUS" text block or "Research Classification" section\n- NOT include an "Execution Limitations" section — discuss limitations naturally within the Discussion section`;
  }

  const result = await callLLM(
    `You are a LaTeX expert. ${buildFieldContext(ctx)} Convert the paper to a professional academic LaTeX document.

CRITICAL DOCUMENT CLASS RULE:
- You MUST use \\documentclass[11pt,a4paper]{article} as the document class.
- Do NOT use any conference-specific or journal-specific class files (e.g., neurips_2024, icml2025, elsarticle, apa7). These .cls files are NOT available and will cause compilation errors.
- Instead, replicate the conference style using ONLY standard LaTeX packages (geometry, titling, amsmath, graphicx, booktabs, hyperref, tabularx, adjustbox, etc.).

CRITICAL ANTI-HALLUCINATION RULE:
- You MUST NOT invent, fabricate, or generate ANY numerical values (means, standard deviations, p-values, correlations, effect sizes, percentages, sample sizes) that are not explicitly provided in the data manifest below.
- If a number does not appear in the data manifest, it MUST NOT appear in the paper.
- Copy numerical values EXACTLY as provided — do not round, adjust, or "improve" them.
- If no data manifest is provided, the Results section must state that analysis is pending.

CRITICAL REFERENCE INTEGRITY RULE:
- You MUST ONLY cite references that appear in the BibTeX references provided below.
- Do NOT invent, fabricate, or hallucinate ANY references, authors, titles, or publication years.
- Do NOT add references with future publication years (e.g., 2026 or later).
- Every \cite{key} command MUST have a corresponding \bibitem{key} in the bibliography.
- Every \bibitem MUST correspond to a real paper from the provided BibTeX entries.
- If you need more references than provided, state the limitation rather than fabricating citations.

Output ONLY the raw LaTeX source code. Do NOT wrap it in markdown code blocks (no \`\`\`latex or \`\`\`). Start directly with \\documentclass and end with \\end{document}.
You MUST include \\usepackage{graphicx}, \\usepackage{float}, \\usepackage{tabularx}, and \\usepackage{adjustbox} in the preamble.
ALL content — including figures, tables, and equations — MUST fit within A4 portrait page margins (\\textwidth). Never allow any element to overflow the page width.`,
    `Convert this paper to complete LaTeX format for a professional academic publication in ${inferResearchField(ctx)}:\n\nAbstract: ${ctx.abstract}\n\nBody (with numbered citations [1], [2], etc.):\n${ctx.paperBody || ""}\n\nTables:\n${ctx.tables.join("\n")}\n\nBibTeX references:\n${ctx.references || ""}${figureInstructions}${dataManifest}\n\nGenerate complete LaTeX source with:\n1. \\documentclass[11pt,a4paper]{article} — NEVER use conference-specific .cls files\n2. \\usepackage[a4paper, margin=2.5cm]{geometry} for A4 layout\n3. \\usepackage{graphicx}, \\usepackage{float}, \\usepackage{amsmath}, \\usepackage{amssymb}, \\usepackage{booktabs}, \\usepackage{hyperref}, \\usepackage{tabularx}, \\usepackage{adjustbox} in preamble\n4. Professional title formatting with \\title{}, \\author{}, \\date{}, \\maketitle\n5. All sections with proper \\cite{} commands for every reference\n6. Actual \\includegraphics commands for each data analysis figure (using the exact keys provided above)\n7. Table environments using booktabs (\\toprule, \\midrule, \\bottomrule)\n8. \\begin{thebibliography}{99} section at the end with all cited \\bibitem entries\n\n## TABLE WIDTH CONSTRAINTS (ABSOLUTELY CRITICAL — MUST FOLLOW):\nEvery table MUST fit within the A4 page width (\\textwidth = approximately 16cm with 2.5cm margins).\nFor tables with 4 or more columns, you MUST use one of these approaches:\n\nApproach 1 (PREFERRED): Wrap the entire tabular in \\resizebox:\n\\begin{table}[H]\n  \\centering\n  \\caption{...}\n  \\resizebox{\\textwidth}{!}{%\n    \\begin{tabular}{lcccc}\n      ...\n    \\end{tabular}%\n  }\n\\end{table}\n\nApproach 2: Use tabularx with X columns that auto-wrap:\n\\begin{table}[H]\n  \\centering\n  \\caption{...}\n  \\begin{tabularx}{\\textwidth}{lXXXX}\n    ...\n  \\end{tabularx}\n\\end{table}\n\nApproach 3: Use adjustbox:\n\\begin{table}[H]\n  \\centering\n  \\caption{...}\n  \\begin{adjustbox}{max width=\\textwidth}\n    \\begin{tabular}{lcccc}\n      ...\n    \\end{tabular}\n  \\end{adjustbox}\n\\end{table}\n\nRULES:\n- NEVER use plain \\begin{tabular} without \\resizebox, tabularx, or adjustbox for tables with 4+ columns\n- NEVER use sisetup or S column type (these cause width issues)\n- Use SHORT column headers (abbreviate long names, e.g., \"Female Mgmt Ratio\" instead of \"Female Management Ratio\")\n- Use \\footnotesize inside tables if needed for extra space\n- For correlation matrices and wide data tables, ALWAYS use \\resizebox{\\textwidth}{!}{...}\n\nA4 PAGE WIDTH CONSTRAINTS (OTHER ELEMENTS):\n- ALL figures MUST use width=\\textwidth or smaller (e.g., width=0.85\\textwidth) in \\includegraphics. Never use absolute widths.\n- ALL equations MUST fit within \\textwidth. For long equations, use split, multline, or aligned environments.\n- Never use \\hspace or manual spacing that pushes content beyond margins.\n\nIMPORTANT:\n- Convert all [1], [2] style citations to \\cite{key} commands with corresponding \\bibitem entries.\n- Output ONLY raw LaTeX code. Start with \\documentclass[11pt,a4paper]{article} and end with \\end{document}.\n- Each figure MUST use \\includegraphics with the exact key provided (e.g., figure_1, figure_2). Do NOT use placeholder paths or URLs.\n- Do NOT use \\usepackage{natbib} — use \\begin{thebibliography} with \\bibitem instead.\n- Do NOT use \\usepackage{siunitx} or S column type — they cause width overflow issues.`,
    32768
  );
  // Strip any code block markers the LLM might have added
  let latex = stripCodeBlockMarkers(result);
  latex = postProcessLatexSource(latex);

  // ─── Citation normalisation post-processing ───
  // Build a mapping from all known BibTeX keys (from any source) to the stable ref1..refN keys.
  // This catches cases where the LLM used raw source IDs instead of stable numbered keys.
  const citationKeyMap = new Map<string, string>();
  ctx.papers.slice(0, 20).forEach((p, i) => {
    const stableKey = `ref${i + 1}`;
    // Map from source-specific BibTeX keys that the LLM might have used
    if (p.bibtex) {
      const bibtexKeyMatch = p.bibtex.match(/@\w+\{([^,]+),/);
      if (bibtexKeyMatch) citationKeyMap.set(bibtexKeyMatch[1].trim(), stableKey);
    }
    // Map from common auto-generated key patterns
    const doi = p.doi || "";
    if (doi) citationKeyMap.set(`crossref_${doi.replace(/[./]/g, "_")}`, stableKey);
    if (doi) citationKeyMap.set(`springer_${doi.replace(/[./]/g, "_")}`, stableKey);
    const arxivId = p.arxivId || "";
    if (arxivId) citationKeyMap.set(`arxiv_${arxivId.replace(/[./]/g, "_")}`, stableKey);
    if (p.paperId?.startsWith("pubmed:")) {
      const pmid = p.paperId.replace("pubmed:", "");
      citationKeyMap.set(`pubmed_${pmid}`, stableKey);
    }
    if (p.paperId?.startsWith("s2:")) {
      const s2id = p.paperId.replace("s2:", "").substring(0, 12);
      citationKeyMap.set(`s2_${s2id}`, stableKey);
    }
    // Also map the first-author-year format that was previously used
    const firstAuthor = (p.authors || "Unknown").split(",")[0].split(" ").pop() || "unknown";
    citationKeyMap.set(`${firstAuthor.toLowerCase()}${p.year || "nd"}_${i + 1}`, stableKey);
  });

  // Replace \cite{oldKey} with \cite{refN} for all known key mappings
  citationKeyMap.forEach((newKey, oldKey) => {
    if (oldKey && oldKey !== newKey) {
      const escaped = oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      latex = latex.replace(new RegExp(`\\\\cite\\{${escaped}\\}`, "g"), `\\cite{${newKey}}`);
    }
  });

  // Convert remaining Markdown-style [N] citations to \cite{refN}
  // Only convert [N] patterns that look like citation numbers (1-99), not arbitrary brackets
  latex = latex.replace(/\[(\d{1,2})\]/g, (_match, num) => {
    const n = parseInt(num);
    if (n >= 1 && n <= ctx.papers.slice(0, 20).length) {
      return `\\cite{ref${n}}`;
    }
    return _match; // Leave non-citation brackets as-is
  });

  // Remove any \cite{} with broken/empty keys (e.g., \cite{pubmed_} or \cite{})
  latex = latex.replace(/\\cite\{[^}]*_\}/g, ""); // keys ending in underscore (broken IDs)
  latex = latex.replace(/\\cite\{\}/g, ""); // empty cite

  // Also fix \bibitem keys to match the stable ref1..refN scheme
  // Replace any \bibitem{oldKey} with \bibitem{refN} if found in the mapping
  citationKeyMap.forEach((newKey, oldKey) => {
    if (oldKey && oldKey !== newKey) {
      const escaped = oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      latex = latex.replace(new RegExp(`\\\\bibitem\\{${escaped}\\}`, "g"), `\\bibitem{${newKey}}`);
    }
  });

  if (ctx.executionDiagnostics?.executionStatus !== "success") {
    const failureReasons = ctx.executionDiagnostics?.failureReasons || [];
    const limitationSection = [
      "\\section*{Execution Limitations}",
      "The empirical execution did not complete all planned analyses.",
      "\\begin{itemize}",
      ...failureReasons.slice(0, 8).map((reason) => `  \\item ${reason.replace(/[_%$#&{}]/g, " ")}`),
      "\\end{itemize}",
      "Methods without evidence are treated as planned future work.",
    ].join("\n");
    if (latex.includes("\\end{document}") && !latex.includes("\\section*{Execution Limitations}")) {
      latex = latex.replace("\\end{document}", `${limitationSection}\n\n\\end{document}`);
    }
  }

  // ─── Strip internal metadata that should not appear in the paper ───
  // These are pipeline-internal annotations that the LLM sometimes includes in the output.
  // Remove "DATA ANALYSIS STATUS: ..." lines
  latex = latex.replace(/\\textbf\{DATA ANALYSIS STATUS[^}]*\}[^\n]*/g, "");
  latex = latex.replace(/DATA ANALYSIS STATUS[^\n]*/g, "");
  // Remove "Research Classification" section if present as a visible section
  latex = latex.replace(/\\section\*?\{Research Classification\}[\s\S]*?(?=\\section|\\end\{document\})/g, "");
  latex = latex.replace(/\\subsection\*?\{Research Classification\}[\s\S]*?(?=\\section|\\subsection|\\end\{document\})/g, "");
  // Remove standalone "methodological_protocol" or "empirical" classification labels
  latex = latex.replace(/^methodological[_\s]protocol\s*$/gm, "");
  latex = latex.replace(/^empirical\s*$/gm, "");
  // Remove "Execution Limitations" from within the body (it gets re-added below in a controlled way)
  // but only if we're about to re-inject it
  // Clean up any double blank lines created by removals
  latex = latex.replace(/\n{3,}/g, "\n\n");

  // Ensure bibliography is present in LaTeX output
  if (!latex.includes("\\begin{thebibliography}") && ctx.references) {
    console.log("[Pipeline] LaTeX missing bibliography, injecting from BibTeX references...");
    // Convert BibTeX entries to \bibitem format
    const bibEntries = ctx.references.split(/\n\n+/).filter(e => e.trim().startsWith("@"));
    if (bibEntries.length > 0) {
      const bibItems = bibEntries.map((entry, i) => {
        const keyMatch = entry.match(/@\w+\{([^,]+),/);
        const titleMatch = entry.match(/title\s*=\s*\{([^}]+)\}/i);
        const authorMatch = entry.match(/author\s*=\s*\{([^}]+)\}/i);
        const yearMatch = entry.match(/year\s*=\s*\{([^}]+)\}/i);
        const journalMatch = entry.match(/(?:journal|booktitle|venue)\s*=\s*\{([^}]+)\}/i);
        const key = keyMatch ? keyMatch[1].trim() : `ref${i + 1}`;
        const title = titleMatch ? titleMatch[1] : "Unknown title";
        const author = authorMatch ? authorMatch[1] : "Unknown";
        const year = yearMatch ? yearMatch[1] : "n.d.";
        const journal = journalMatch ? journalMatch[1] : "";
        return `\\bibitem{${key}} ${author}. \\textit{${title}}. ${journal}${journal ? ", " : ""}${year}.`;
      }).join("\n\n");

      const bibliography = `\n\n\\begin{thebibliography}{${bibEntries.length}}\n${bibItems}\n\\end{thebibliography}`;

      // Insert before \end{document}
      if (latex.includes("\\end{document}")) {
        latex = latex.replace("\\end{document}", `${bibliography}\n\n\\end{document}`);
      } else {
        latex += bibliography;
      }
      console.log(`[Pipeline] Injected ${bibEntries.length} bibliography entries into LaTeX`);
    }
  }

  // Ensure \end{document} is present
  if (!latex.includes("\\end{document}")) {
    latex += "\n\n\\end{document}";
  }

  ctx.latex = latex;
  await persistStageAudit(ctx, 20, {
    hasRealMetrics,
    hasRealTables: !!hasRealTables,
    methodContract: ctx.methodContract,
    executionDiagnostics: ctx.executionDiagnostics,
    claimVerificationReport: ctx.claimVerificationReport || "",
    latexLength: ctx.latex.length,
  });
  return ctx.latex;
}

async function stage21_peerReview(ctx: PipelineContext): Promise<string> {
  const result = await callLLM(
    `You are a specialist review panel for a leading academic venue in ${inferResearchField(ctx)}. ${buildFieldContext(ctx)} The panel consists of:
1. An econometrics reviewer focused on estimands, equations, identification, and inference.
2. A causal inference reviewer focused on assumptions, threats to validity, and design diagnostics.
3. An empirical research design reviewer focused on data quality, operationalisation, and robustness.
4. A writing/positioning reviewer focused on clarity, novelty, and venue fit.

Provide detailed, technically serious reviews.`,
    `Review this paper submission:

Title: ${ctx.topic}
Abstract: ${ctx.abstract}
Method feasibility contract:
${formatMethodContract(ctx.methodContract)}
Execution diagnostics:
${formatExecutionDiagnostics(ctx.executionDiagnostics)}
Body: ${ctx.paperBody || ""}

Provide 4 independent reviews, one from each specialist reviewer above. For each review include:
1. Summary (2-3 sentences)
2. Strengths (3-5 points)
3. Weaknesses (3-5 points)
4. Questions for authors
5. Required revisions
6. Specific comments on statistical validity / identification / robustness where relevant
7. Overall score (1-10)
8. Confidence (1-5)
9. Recommendation (Accept/Weak Accept/Borderline/Weak Reject/Reject)

Then provide a meta-review containing:
1. Consensus summary
2. Whether the paper is best classified as empirical or methodological_protocol
3. Highest-priority blocking issues
4. Final recommendation`
  );
  ctx.reviewReport = result;
  return result;
}

async function stage22_revision(ctx: PipelineContext): Promise<string> {
  const result = await callLLM(
    "You are the paper author revising based on peer review feedback.",
    `Revise the paper based on these reviews:\n\nReviews:\n${ctx.reviewReport?.substring(0, 8000)}\n\nOriginal paper:\n${ctx.paperBody || ""}\n\nProvide:\n1. Point-by-point response to reviewers\n2. Revised sections (showing changes)\n3. Additional experiments or analysis if requested\n4. Summary of all changes made`
  );
  ctx.revision = result;
  return result;
}

async function stage23_finalCompilation(ctx: PipelineContext): Promise<string> {
  const suffix = nanoid(8);
  const experimentArtifact = describeExperimentArtifact(ctx.experimentCode);

  try {
    if (ctx.latex) {
      const { url } = await storagePut(`runs/${ctx.runId}/paper-${suffix}.tex`, ctx.latex, "text/x-tex");
      await db.insertArtifact({ runId: ctx.runId, stageNumber: 23, artifactType: "paper_tex", fileName: "paper.tex", fileUrl: url, fileKey: `runs/${ctx.runId}/paper-${suffix}.tex`, mimeType: "text/x-tex" });
    }
    if (ctx.references) {
      const { url } = await storagePut(`runs/${ctx.runId}/references-${suffix}.bib`, ctx.references, "text/plain");
      await db.insertArtifact({ runId: ctx.runId, stageNumber: 23, artifactType: "references_bib", fileName: "references.bib", fileUrl: url, fileKey: `runs/${ctx.runId}/references-${suffix}.bib`, mimeType: "text/plain" });
    }
    if (ctx.experimentCode) {
      const experimentStorageKey = `runs/${ctx.runId}/${experimentArtifact.storageFileName.replace(/\.(json|py)$/i, `-${suffix}.$1`)}`;
      const { url } = await storagePut(experimentStorageKey, ctx.experimentCode, experimentArtifact.mimeType);
      await db.insertArtifact({
        runId: ctx.runId,
        stageNumber: 23,
        artifactType: "experiment_code",
        fileName: experimentArtifact.fileName,
        fileUrl: url,
        fileKey: experimentStorageKey,
        mimeType: experimentArtifact.mimeType,
      });
    }
    if (ctx.reviewReport) {
      const { url } = await storagePut(`runs/${ctx.runId}/review-${suffix}.md`, ctx.reviewReport, "text/markdown");
      await db.insertArtifact({ runId: ctx.runId, stageNumber: 23, artifactType: "review_report", fileName: "review_report.md", fileUrl: url, fileKey: `runs/${ctx.runId}/review-${suffix}.md`, mimeType: "text/markdown" });
    }

    // Refresh chart URLs (S3 pre-signed URLs may have expired since stage 11)
    const charts = ctx.experimentOutput?.charts || [];
    await Promise.all(charts.map(async (chart) => {
      const candidates = [
        chart.fileKey,
        `experiments/${ctx.runId}/${chart.name}.png`,
        `experiments/${ctx.runId}/${chart.name}.svg`,
      ].filter((key): key is string => !!key);
      let refreshedUrl: string | null = null;
      let refreshedKey: string | null = null;
      for (const key of candidates) {
        try {
          const refreshed = await storageGet(key);
          refreshedUrl = refreshed.url;
          refreshedKey = key;
          break;
        } catch {
          // try next candidate
        }
      }
      if (refreshedUrl && refreshedKey) {
        chart.url = refreshedUrl;
        chart.fileKey = refreshedKey;
        if (!chart.format) {
          chart.format = refreshedKey.endsWith(".svg") ? "svg" : "png";
        }
        if (!chart.mimeType) {
          chart.mimeType = chart.format === "svg" ? "image/svg+xml" : "image/png";
        }
      } else {
        console.warn(`[Pipeline] Could not refresh URL for chart ${chart.name}, using original`);
      }
    }));
    if (charts.length > 0) {
      console.log(`[Pipeline] Refreshed ${charts.length} chart URLs for PDF generation`);
    }

    // Build chart images array for PDF embedding
    const chartImages: ChartImage[] = charts.map((c, i) => ({
      key: `figure_${i + 1}`,
      url: c.url,
      fileKey: c.fileKey,
      name: c.name,
      description: c.description,
    }));

    // Ensure chart images are saved as individual artifacts (even if stage11 already did this,
    // we do it again in stage23 to guarantee they appear in the Artifacts tab)
    const existingArtifacts = await db.getArtifactsForRun(ctx.runId);
    const existingChartKeys = new Set(
      existingArtifacts
        .filter(a => a.artifactType === "experiment_chart")
        .flatMap(a => [a.fileKey || "", a.fileUrl || ""])
        .filter(Boolean)
    );
    for (const chart of (ctx.experimentOutput?.charts || [])) {
      try {
        const inferredFormat = chart.format || (chart.mimeType === "image/svg+xml" || chart.url.includes(".svg") ? "svg" : "png");
        const inferredMime = chart.mimeType || (inferredFormat === "svg" ? "image/svg+xml" : "image/png");
        const inferredKey = chart.fileKey || `experiments/${ctx.runId}/${chart.name}.${inferredFormat}`;
        const alreadyExists = existingChartKeys.has(inferredKey) || existingChartKeys.has(chart.url);
        if (!alreadyExists) {
          await db.insertArtifact({
            runId: ctx.runId,
            stageNumber: 23,
            artifactType: "experiment_chart",
            fileName: `${chart.name}.${inferredFormat}`,
            fileUrl: chart.url,
            fileKey: inferredKey,
            mimeType: inferredMime,
          });
          existingChartKeys.add(inferredKey);
          existingChartKeys.add(chart.url);
          console.log(`[Pipeline] Chart artifact saved: ${chart.name}`);
        }
      } catch (chartErr: any) {
        console.warn(`[Pipeline] Failed to save chart artifact ${chart.name}:`, chartErr?.message);
      }
    }

    if (chartImages.length > 0) {
      console.log(`[Pipeline] ${chartImages.length} chart images will be embedded in PDF`);
    }

    // Generate PDF – prefer LaTeX→HTML→PDF, fall back to Markdown→HTML→PDF
    const paperMdForPdf = `# ${ctx.topic}\n\n## Abstract\n${ctx.abstract}\n\n${ctx.paperBody}`;
    try {
      console.log("[Pipeline] Generating PDF...");
      const pdfBuffer = await generatePaperPdf(
        paperMdForPdf,
        ctx.topic,
        ctx.config.targetConference,
        ctx.latex || undefined,
        chartImages
      );
      const { url: pdfUrl } = await storagePut(`runs/${ctx.runId}/paper-${suffix}.pdf`, pdfBuffer, "application/pdf");
      await db.insertArtifact({ runId: ctx.runId, stageNumber: 23, artifactType: "paper_pdf", fileName: "paper.pdf", fileUrl: pdfUrl, fileKey: `runs/${ctx.runId}/paper-${suffix}.pdf`, mimeType: "application/pdf" });
      console.log(`[Pipeline] PDF generated successfully (${(pdfBuffer.length / 1024).toFixed(1)} KiB)`);
      await notifyPipelineOwner("Auto Research PDF generated", `PDF report generated for run ${ctx.runId}: ${ctx.topic}`);
    } catch (pdfErr: any) {
      // Log the full error for debugging
      console.error("[Pipeline] PDF generation FAILED:", pdfErr);
      console.error("[Pipeline] PDF error stack:", pdfErr?.stack);
      // Save an error artifact so the user knows PDF generation failed
      try {
        const errorMsg = `PDF generation failed: ${pdfErr?.message || "Unknown error"}\n\nStack trace:\n${pdfErr?.stack || "N/A"}\n\nChromium paths tried: /usr/bin/chromium-browser, /usr/bin/chromium, /usr/bin/google-chrome, etc.\nTimestamp: ${new Date().toISOString()}`;
        const { url: errUrl } = await storagePut(`runs/${ctx.runId}/pdf-error-${suffix}.txt`, errorMsg, "text/plain");
        await db.insertArtifact({ runId: ctx.runId, stageNumber: 23, artifactType: "pdf_error_log", fileName: "pdf-error.txt", fileUrl: errUrl, fileKey: `runs/${ctx.runId}/pdf-error-${suffix}.txt`, mimeType: "text/plain" });
      } catch {}
    }
  } catch (e) {
    console.warn("[Pipeline] Failed to upload some artifacts:", e);
  }

  const paperMd = `# ${ctx.topic}\n\n## Abstract\n${ctx.abstract}\n\n${ctx.paperBody}`;
  await db.updatePipelineRun(ctx.runId, {
    paperMarkdown: paperMd,
    paperLatex: ctx.latex,
    referencesBib: ctx.references,
    experimentCode: ctx.experimentCode,
    reviewReport: ctx.reviewReport,
  });

  ctx.finalPaper = paperMd;
  return `Final compilation complete. Generated artifacts:\n- Paper (Markdown)\n- Paper (PDF)\n- LaTeX source\n- BibTeX references\n- Experiment code\n- Review report${ctx.experimentOutput?.charts.length ? `\n- ${ctx.experimentOutput.charts.length} data analysis charts` : ""}`;
}

const STAGE_HANDLERS: Record<number, (ctx: PipelineContext) => Promise<string>> = {
  1: stage1_topicAnalysis, 2: stage2_literatureSearch, 3: stage3_paperScreening,
  4: stage4_deepAnalysis, 5: stage5_gapIdentification, 6: stage6_hypothesisGeneration,
  7: stage7_methodDesign, 8: stage8_methodValidation, 9: stage9_codeGeneration,
  10: stage10_codeReview, 11: stage11_experimentExecution, 12: stage12_resultCollection,
  13: stage13_statisticalAnalysis, 14: stage14_figureGeneration, 15: stage15_tableGeneration,
  16: stage16_outlineGeneration, 17: stage17_abstractWriting, 18: stage18_bodyWriting,
  19: stage19_referenceFormatting, 20: stage20_latexCompilation, 21: stage21_peerReview,
  22: stage22_revision, 23: stage23_finalCompilation,
};

/**
 * Wait for user approval in manual mode.
 * Returns the (possibly edited) output string.
 */
async function waitForApproval(runId: string, stageNumber: number, output: string, emit: EventEmitter): Promise<string> {
  // Update DB to awaiting_approval
  await db.updatePipelineRun(runId, { status: "awaiting_approval" });
  await db.updateStageLog(runId, stageNumber, { status: "blocked_approval" });

  emit({
    type: "stage_awaiting_approval",
    runId,
    stageNumber,
    stageName: PIPELINE_STAGES[stageNumber - 1]?.name,
    message: `Stage ${stageNumber} complete. Awaiting your approval to proceed.`,
    data: { output: output.substring(0, 2000) },
    timestamp: Date.now(),
  });

  if (isWorkerExecutionMode()) {
    // In worker mode, approval requests are handled by the API process,
    // so we synchronise via DB status instead of process-local waiters.
    while (true) {
      const run = await db.getPipelineRun(runId);
      if (!run) throw new Error("Pipeline run no longer exists");

      if (run.status === "running") {
        const stageLog = await db.getStageLog(runId, stageNumber);
        return stageLog?.output || output;
      }

      if (run.status === "failed" || run.status === "stopped") {
        throw new Error(run.errorMessage || "Stage rejected by user");
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return new Promise<string>((resolve, reject) => {
    approvalWaiters.set(runId, {
      resolve: (editedOutput?: string) => {
        resolve(editedOutput || output);
      },
      reject: (reason?: string) => {
        reject(new Error(reason || "Stage rejected by user"));
      },
    });
  });
}

export async function executePipeline(
  runId: string,
  topic: string,
  config: RunConfig,
  emit: EventEmitter,
  startStage = 1
): Promise<void> {
  // Load dataset files if any were assigned
  const datasetFiles: DatasetInfo[] = [];
  if (config.datasetFileIds && config.datasetFileIds.length > 0) {
    const dbFiles = await db.getDatasetFilesForRun(runId);
    for (const f of dbFiles) {
      datasetFiles.push({
        originalName: f.originalName,
        fileUrl: f.fileUrl,
        fileKey: f.fileKey,
        sizeBytes: f.sizeBytes ?? undefined,
        fileType: f.fileType,
        columnNames: f.columnNames as string[] | undefined,
        rowCount: f.rowCount ?? undefined,
      });
    }
    if (datasetFiles.length > 0) {
      emit({
        type: "log", runId, message: `Loaded ${datasetFiles.length} dataset file(s) for analysis`,
        timestamp: Date.now(),
      });
    }
  }

  const ctx: PipelineContext = {
    runId, topic, config, emit,
    papers: [], hypothesis: "", methodology: "", methodValidation: "", experimentCode: "",
    experimentResults: "", statisticalAnalysis: "", figures: [], tables: [],
    outline: "", abstract: "", paperBody: "", references: "",
    latex: "", reviewReport: "", revision: "", finalPaper: "",
    datasetFiles,
    experimentOutput: null,
    evidenceProfile: null,
    methodContract: null,
    executionDiagnostics: null,
    methodIntegrityNote: "",
    claimVerificationReport: "",
  };

  await db.updatePipelineRun(runId, { status: "running", currentStage: startStage });

  for (let i = startStage; i <= 23; i++) {
    const stageDef = PIPELINE_STAGES[i - 1];
    const handler = STAGE_HANDLERS[i];
    if (!handler) continue;

    // Check if pipeline was stopped
    const currentRun = await db.getPipelineRun(runId);
    if (currentRun?.status === "stopped") {
      emit({ type: "run_fail", runId, message: "Pipeline stopped by user", timestamp: Date.now() });
      return;
    }

    await db.createStageLog({
      runId, stageNumber: i, stageName: stageDef.name, phaseName: stageDef.phase,
      status: "running", startedAt: new Date(),
    });

    emit({ type: "stage_start", runId, stageNumber: i, stageName: stageDef.name, message: `Starting: ${stageDef.description}`, timestamp: Date.now() });

    const startTime = Date.now();
    let retries = 0;

    while (retries <= config.maxRetries) {
      try {
        let output = await handler(ctx);
        const duration = Date.now() - startTime;

        // In manual mode (autoApprove=false), pause for user approval after each stage
        if (!config.autoApprove && i < 23) {
          await db.updateStageLog(runId, i, {
            status: "done", output: output?.substring(0, 60000), durationMs: duration, completedAt: new Date(),
          });

          try {
            const approvedOutput = await waitForApproval(runId, i, output, emit);

            // If user edited the output, update the stage log and context
            if (approvedOutput !== output) {
              output = approvedOutput;
              await db.updateStageLog(runId, i, { output: approvedOutput?.substring(0, 60000) });
              // Update context fields based on stage
              updateContextFromEdit(ctx, i, approvedOutput);
            }

            emit({ type: "stage_approved", runId, stageNumber: i, stageName: stageDef.name, message: `Stage ${i} approved`, timestamp: Date.now() });
            await db.updatePipelineRun(runId, { status: "running", currentStage: i, stagesDone: i });
          } catch (rejectError: any) {
            // User rejected the stage
            await db.updateStageLog(runId, i, { status: "failed", errorMessage: rejectError?.message });
            await db.updatePipelineRun(runId, { status: "failed", errorMessage: `Stage ${i} rejected: ${rejectError?.message}` });
            await notifyPipelineOwner("Auto Research pipeline error", `Run ${runId} was rejected at stage ${i} (${stageDef.name}): ${rejectError?.message || "No reason provided"}`);
            emit({ type: "stage_rejected", runId, stageNumber: i, stageName: stageDef.name, message: `Stage ${i} rejected: ${rejectError?.message}`, timestamp: Date.now() });
            emit({ type: "run_fail", runId, message: `Pipeline stopped: Stage ${i} rejected`, timestamp: Date.now() });
            return;
          }
        } else {
          // Auto-approve mode: proceed immediately
          await db.updateStageLog(runId, i, {
            status: "done", output: output?.substring(0, 60000), durationMs: duration, completedAt: new Date(),
          });
          await db.updatePipelineRun(runId, { currentStage: i, stagesDone: i });
          emit({ type: "stage_complete", runId, stageNumber: i, stageName: stageDef.name, message: `Completed: ${stageDef.description}`, data: { durationMs: duration }, timestamp: Date.now() });
          if (i === 11) {
            await notifyPipelineOwner("Auto Research experiment finished", `Experiment execution completed for run ${runId}: ${topic}`);
          }
        }

        break; // success
      } catch (error: any) {
        retries++;
        if (retries > config.maxRetries) {
          const errMsg = error?.message || String(error);
          await db.updateStageLog(runId, i, {
            status: "failed", errorMessage: errMsg, durationMs: Date.now() - startTime, completedAt: new Date(),
          });
          await db.updatePipelineRun(runId, {
            status: "failed", currentStage: i, errorMessage: `Stage ${i} (${stageDef.name}) failed: ${errMsg}`,
            stagesFailed: (await db.getPipelineRun(runId))?.stagesFailed ? (await db.getPipelineRun(runId))!.stagesFailed + 1 : 1,
          });
          await notifyPipelineOwner("Auto Research pipeline error", `Run ${runId} failed at stage ${i} (${stageDef.name}): ${errMsg}`);
          emit({ type: "stage_fail", runId, stageNumber: i, stageName: stageDef.name, message: `Failed: ${errMsg}`, timestamp: Date.now() });
          emit({ type: "run_fail", runId, message: `Pipeline failed at stage ${i}: ${stageDef.name}`, timestamp: Date.now() });
          return;
        }
        emit({ type: "log", runId, stageNumber: i, message: `Retry ${retries}/${config.maxRetries}: ${error?.message}`, timestamp: Date.now() });
        await new Promise(r => setTimeout(r, 2000 * retries));
      }
    }
  }

  await db.updatePipelineRun(runId, { status: "completed", completedAt: new Date(), stagesDone: 23 });
  await notifyPipelineOwner("Auto Research pipeline completed", `Run ${runId} completed successfully for topic: ${topic}`);
  emit({ type: "run_complete", runId, message: "Pipeline completed successfully!", timestamp: Date.now() });
}

/** Update pipeline context when user edits stage output in manual mode */
function updateContextFromEdit(ctx: PipelineContext, stageNumber: number, editedOutput: string) {
  switch (stageNumber) {
    case 6: ctx.hypothesis = editedOutput; break;
    case 7: ctx.methodology = editedOutput; break;
    case 8:
      ctx.methodValidation = editedOutput;
      ctx.methodContract = parseMethodContract(editedOutput, ctx.methodology, ensureEvidenceProfile(ctx));
      break;
    case 9: ctx.experimentCode = editedOutput; break;
    case 11:
      ctx.experimentResults = editedOutput;
      if (!ctx.executionDiagnostics) {
        ctx.executionDiagnostics = {
          executionStatus: "partial",
          executableRequested: ctx.methodContract?.executableNow || [],
          executedMethods: [],
          missingRequested: ctx.methodContract?.executableNow || [],
          analyticalMetricCount: 0,
          chartCount: 0,
          tableCount: 0,
          failureReasons: ["Stage 11 output was manually edited."],
        };
      }
      break;
    case 13: ctx.statisticalAnalysis = editedOutput; break;
    case 16: ctx.outline = editedOutput; break;
    case 17: ctx.abstract = editedOutput; break;
    case 18:
      ctx.paperBody = editedOutput;
      ctx.claimVerificationReport = buildClaimVerificationReport(ctx, editedOutput).report;
      break;
    case 21: ctx.reviewReport = editedOutput; break;
    case 22: ctx.revision = editedOutput; break;
  }
}
