/** 23-stage research pipeline definition matching AutoResearchClaw */

export type StageStatus = "pending" | "running" | "done" | "failed" | "blocked_approval" | "skipped";
export type RunStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "awaiting_approval";

export interface StageDefinition {
  number: number;
  name: string;
  phase: string;
  description: string;
  icon: string;
  estimatedMinutes: number;
}

export const PIPELINE_STAGES: StageDefinition[] = [
  // Phase 1: Literature & Gap Analysis
  { number: 1, name: "topic_analysis", phase: "Literature & Gap Analysis", description: "Research topic analysis and keyword extraction", icon: "Search", estimatedMinutes: 2 },
  { number: 2, name: "literature_search", phase: "Literature & Gap Analysis", description: "Multi-source literature search (arXiv, Semantic Scholar, Springer, PubMed, CrossRef)", icon: "BookOpen", estimatedMinutes: 5 },
  { number: 3, name: "paper_screening", phase: "Literature & Gap Analysis", description: "Paper relevance screening and filtering", icon: "Filter", estimatedMinutes: 3 },
  { number: 4, name: "deep_analysis", phase: "Literature & Gap Analysis", description: "Deep analysis of selected papers", icon: "FileText", estimatedMinutes: 5 },
  { number: 5, name: "gap_identification", phase: "Literature & Gap Analysis", description: "Research gap identification", icon: "Target", estimatedMinutes: 3 },

  // Phase 2: Hypothesis & Method Design
  { number: 6, name: "hypothesis_generation", phase: "Hypothesis & Method Design", description: "Hypothesis generation from identified gaps", icon: "Lightbulb", estimatedMinutes: 3 },
  { number: 7, name: "method_design", phase: "Hypothesis & Method Design", description: "Methodology and experimental design", icon: "Compass", estimatedMinutes: 4 },
  { number: 8, name: "method_validation", phase: "Hypothesis & Method Design", description: "Method feasibility validation", icon: "CheckCircle", estimatedMinutes: 2 },

  // Phase 3: Experiment Execution
  { number: 9, name: "code_generation", phase: "Experiment Execution", description: "Experiment code generation", icon: "Code", estimatedMinutes: 8 },
  { number: 10, name: "code_review", phase: "Experiment Execution", description: "Code review and debugging", icon: "Bug", estimatedMinutes: 3 },
  { number: 11, name: "experiment_execution", phase: "Experiment Execution", description: "Experiment execution in sandbox", icon: "Play", estimatedMinutes: 15 },
  { number: 12, name: "result_collection", phase: "Experiment Execution", description: "Result collection and data processing", icon: "Database", estimatedMinutes: 3 },

  // Phase 4: Analysis & Visualization
  { number: 13, name: "statistical_analysis", phase: "Analysis & Visualization", description: "Statistical analysis of results", icon: "BarChart", estimatedMinutes: 4 },
  { number: 14, name: "figure_generation", phase: "Analysis & Visualization", description: "Figure and chart generation", icon: "Image", estimatedMinutes: 5 },
  { number: 15, name: "table_generation", phase: "Analysis & Visualization", description: "Result table generation", icon: "Table", estimatedMinutes: 2 },

  // Phase 5: Paper Writing
  { number: 16, name: "outline_generation", phase: "Paper Writing", description: "Paper outline generation", icon: "List", estimatedMinutes: 3 },
  { number: 17, name: "abstract_writing", phase: "Paper Writing", description: "Abstract writing", icon: "FileEdit", estimatedMinutes: 2 },
  { number: 18, name: "body_writing", phase: "Paper Writing", description: "Paper body writing (Introduction, Method, Results, Discussion)", icon: "PenTool", estimatedMinutes: 10 },
  { number: 19, name: "reference_formatting", phase: "Paper Writing", description: "Reference formatting and BibTeX generation", icon: "Link", estimatedMinutes: 2 },
  { number: 20, name: "latex_compilation", phase: "Paper Writing", description: "LaTeX paper compilation", icon: "FileCode", estimatedMinutes: 3 },

  // Phase 6: Review & Finalization
  { number: 21, name: "peer_review", phase: "Review & Finalization", description: "Multi-agent peer review simulation", icon: "Users", estimatedMinutes: 5 },
  { number: 22, name: "revision", phase: "Review & Finalization", description: "Paper revision based on review feedback", icon: "RotateCcw", estimatedMinutes: 5 },
  { number: 23, name: "final_compilation", phase: "Review & Finalization", description: "Final paper compilation and artifact packaging", icon: "Package", estimatedMinutes: 3 },
];

export const PIPELINE_PHASES = [
  "Literature & Gap Analysis",
  "Hypothesis & Method Design",
  "Experiment Execution",
  "Analysis & Visualization",
  "Paper Writing",
  "Review & Finalization",
] as const;

export type PipelinePhase = typeof PIPELINE_PHASES[number];

export interface PipelineEvent {
  type: "stage_start" | "stage_complete" | "stage_fail" | "stage_output" | "run_complete" | "run_fail" | "log" | "stage_awaiting_approval" | "stage_approved" | "stage_rejected";
  runId: string;
  stageNumber?: number;
  stageName?: string;
  message?: string;
  data?: unknown;
  timestamp: number;
}

export interface AnalysisInputs {
  outcome?: string;
  treatment?: string;
  entity?: string;
  time?: string;
  controls?: string[];
  subgroup?: string;
  missingDataMode?: "complete_case" | "mean_imputation";
  missingDataStrategy?: string;
  variableNotes?: string;
}

export interface RunConfig {
  autoApprove: boolean;
  targetConference: string;
  experimentMode: "simulated" | "sandbox";
  maxRetries: number;
  timeoutMinutes: number;
  qualityThreshold: number;
  dataSources: {
    arxiv: boolean;
    semanticScholar: boolean;
    springer: boolean;
    pubmed: boolean;
    crossref: boolean;
  };
  datasetFileIds?: number[];
  analysisInputs?: AnalysisInputs;
}

export const CONFERENCE_TEMPLATES = [
  // General / multi-disciplinary
  { id: "general", name: "General", description: "General academic paper format (auto-detects field)", documentClass: "article" },
  // ML / AI
  { id: "neurips", name: "NeurIPS", description: "Neural Information Processing Systems", documentClass: "neurips" },
  { id: "icml", name: "ICML", description: "International Conference on Machine Learning", documentClass: "icml" },
  { id: "iclr", name: "ICLR", description: "International Conference on Learning Representations", documentClass: "iclr" },
  { id: "aaai", name: "AAAI", description: "Association for the Advancement of AI", documentClass: "aaai" },
  // NLP
  { id: "acl", name: "ACL", description: "Association for Computational Linguistics", documentClass: "acl" },
  { id: "emnlp", name: "EMNLP", description: "Empirical Methods in NLP", documentClass: "emnlp" },
  // Computer Vision
  { id: "cvpr", name: "CVPR", description: "Computer Vision and Pattern Recognition", documentClass: "cvpr" },
  // Economics / Social Sciences
  { id: "aer", name: "AER", description: "American Economic Review", documentClass: "article" },
  { id: "qje", name: "QJE", description: "Quarterly Journal of Economics", documentClass: "article" },
  { id: "econometrica", name: "Econometrica", description: "Econometrica (Econometric Society)", documentClass: "article" },
  // Medicine / Public Health
  { id: "lancet", name: "Lancet", description: "The Lancet", documentClass: "article" },
  { id: "nejm", name: "NEJM", description: "New England Journal of Medicine", documentClass: "article" },
  { id: "bmj", name: "BMJ", description: "British Medical Journal", documentClass: "article" },
  // Natural Sciences
  { id: "nature", name: "Nature", description: "Nature", documentClass: "article" },
  { id: "science", name: "Science", description: "Science (AAAS)", documentClass: "article" },
  { id: "pnas", name: "PNAS", description: "Proceedings of the National Academy of Sciences", documentClass: "article" },
  // Social Sciences / Psychology
  { id: "apa", name: "APA", description: "APA style (Psychology / Social Sciences)", documentClass: "article" },
  // Education
  { id: "aera", name: "AERA", description: "American Educational Research Association", documentClass: "article" },
  // Environmental / Earth Sciences
  { id: "agu", name: "AGU", description: "American Geophysical Union", documentClass: "article" },
  // Engineering
  { id: "ieee", name: "IEEE", description: "IEEE Transactions", documentClass: "article" },
] as const;

export type ConferenceTemplateId = typeof CONFERENCE_TEMPLATES[number]["id"];

export const DEFAULT_RUN_CONFIG: RunConfig = {
  autoApprove: true,
  targetConference: "General",
  experimentMode: "simulated",
  maxRetries: 2,
  timeoutMinutes: 120,
  qualityThreshold: 0.7,
  dataSources: {
    arxiv: true,
    semanticScholar: true,
    springer: true,
    pubmed: true,
    crossref: true,
  },
};
