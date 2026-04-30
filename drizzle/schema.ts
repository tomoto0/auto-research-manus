import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, bigint } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/** Pipeline runs - each represents one full research pipeline execution */
export const pipelineRuns = mysqlTable("pipeline_runs", {
  id: int("id").autoincrement().primaryKey(),
  runId: varchar("runId", { length: 128 }).notNull().unique(),
  userId: int("userId"),
  topic: text("topic").notNull(),
  status: mysqlEnum("status", ["pending", "running", "completed", "failed", "stopped", "awaiting_approval"]).default("pending").notNull(),
  currentStage: int("currentStage").default(0).notNull(),
  totalStages: int("totalStages").default(23).notNull(),
  stagesDone: int("stagesDone").default(0).notNull(),
  stagesFailed: int("stagesFailed").default(0).notNull(),
  autoApprove: int("autoApprove").default(1).notNull(),
  config: json("config"),
  errorMessage: text("errorMessage"),
  paperMarkdown: text("paperMarkdown"),
  paperLatex: text("paperLatex"),
  referencesBib: text("referencesBib"),
  experimentCode: text("experimentCode"),
  reviewReport: text("reviewReport"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type InsertPipelineRun = typeof pipelineRuns.$inferInsert;

/** Stage logs - tracks each stage execution within a pipeline run */
export const stageLogs = mysqlTable("stage_logs", {
  id: int("id").autoincrement().primaryKey(),
  runId: varchar("runId", { length: 128 }).notNull(),
  stageNumber: int("stageNumber").notNull(),
  stageName: varchar("stageName", { length: 128 }).notNull(),
  phaseName: varchar("phaseName", { length: 128 }).notNull(),
  status: mysqlEnum("status", ["pending", "running", "done", "failed", "blocked_approval", "skipped"]).default("pending").notNull(),
  output: text("output"),
  errorMessage: text("errorMessage"),
  metrics: json("metrics"),
  durationMs: int("durationMs"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type StageLog = typeof stageLogs.$inferSelect;
export type InsertStageLog = typeof stageLogs.$inferInsert;

/** Papers found during literature search */
export const papers = mysqlTable("papers", {
  id: int("id").autoincrement().primaryKey(),
  runId: varchar("runId", { length: 128 }).notNull(),
  paperId: varchar("paperId", { length: 256 }).notNull(),
  title: text("title").notNull(),
  authors: text("authors"),
  year: int("year"),
  abstract: text("abstract"),
  venue: varchar("venue", { length: 512 }),
  citationCount: int("citationCount").default(0),
  doi: varchar("doi", { length: 256 }),
  arxivId: varchar("arxivId", { length: 128 }),
  url: text("url"),
  source: varchar("source", { length: 64 }),
  bibtex: text("bibtex"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Paper = typeof papers.$inferSelect;
export type InsertPaper = typeof papers.$inferInsert;

/** Generated artifacts (charts, code files, etc.) */
export const artifacts = mysqlTable("artifacts", {
  id: int("id").autoincrement().primaryKey(),
  runId: varchar("runId", { length: 128 }).notNull(),
  stageNumber: int("stageNumber"),
  artifactType: varchar("artifactType", { length: 64 }).notNull(),
  fileName: varchar("fileName", { length: 256 }).notNull(),
  fileUrl: text("fileUrl"),
  fileKey: varchar("fileKey", { length: 512 }),
  mimeType: varchar("mimeType", { length: 128 }),
  sizeBytes: int("sizeBytes"),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Artifact = typeof artifacts.$inferSelect;
export type InsertArtifact = typeof artifacts.$inferInsert;

/** User settings for pipeline configuration */
export const userSettings = mysqlTable("user_settings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId"),
  settingKey: varchar("settingKey", { length: 128 }).notNull(),
  settingValue: text("settingValue"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type UserSetting = typeof userSettings.$inferSelect;
export type InsertUserSetting = typeof userSettings.$inferInsert;

/** Uploaded dataset files for pipeline runs */
export const datasetFiles = mysqlTable("dataset_files", {
  id: int("id").autoincrement().primaryKey(),
  runId: varchar("runId", { length: 128 }),
  userId: int("userId"),
  originalName: varchar("originalName", { length: 512 }).notNull(),
  fileKey: varchar("fileKey", { length: 512 }).notNull(),
  fileUrl: text("fileUrl").notNull(),
  mimeType: varchar("mimeType", { length: 128 }),
  sizeBytes: int("sizeBytes"),
  fileType: mysqlEnum("fileType", ["csv", "excel", "dta", "json", "tsv", "other"]).default("other").notNull(),
  columnNames: json("columnNames"),
  rowCount: int("rowCount"),
  preview: text("preview"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DatasetFile = typeof datasetFiles.$inferSelect;
export type InsertDatasetFile = typeof datasetFiles.$inferInsert;

/** Experiment execution results */
export const experimentResults = mysqlTable("experiment_results", {
  id: int("id").autoincrement().primaryKey(),
  runId: varchar("runId", { length: 128 }).notNull(),
  stageNumber: int("stageNumber"),
  executionStatus: mysqlEnum("executionStatus", ["pending", "running", "success", "error"]).default("pending").notNull(),
  pythonCode: text("pythonCode"),
  stdout: text("stdout"),
  stderr: text("stderr"),
  exitCode: int("exitCode"),
  executionTimeMs: int("executionTimeMs"),
  generatedCharts: json("generatedCharts"),
  generatedTables: json("generatedTables"),
  metrics: json("metrics"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ExperimentResult = typeof experimentResults.$inferSelect;
export type InsertExperimentResult = typeof experimentResults.$inferInsert;
