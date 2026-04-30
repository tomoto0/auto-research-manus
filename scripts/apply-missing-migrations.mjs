import mysql from 'mysql2/promise';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

function migrationHash(file) {
  const content = readFileSync(resolve(file), 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

const conn = await mysql.createConnection(url);
try {
  const statements = [
    `CREATE TABLE IF NOT EXISTS \`pipeline_runs\` (
      \`id\` int AUTO_INCREMENT NOT NULL,
      \`runId\` varchar(128) NOT NULL,
      \`userId\` int,
      \`topic\` text NOT NULL,
      \`status\` enum('pending','running','completed','failed','stopped','awaiting_approval') NOT NULL DEFAULT 'pending',
      \`currentStage\` int NOT NULL DEFAULT 0,
      \`totalStages\` int NOT NULL DEFAULT 23,
      \`stagesDone\` int NOT NULL DEFAULT 0,
      \`stagesFailed\` int NOT NULL DEFAULT 0,
      \`autoApprove\` int NOT NULL DEFAULT 1,
      \`config\` json,
      \`errorMessage\` text,
      \`paperMarkdown\` text,
      \`paperLatex\` text,
      \`referencesBib\` text,
      \`experimentCode\` text,
      \`reviewReport\` text,
      \`createdAt\` timestamp NOT NULL DEFAULT (now()),
      \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
      \`completedAt\` timestamp,
      CONSTRAINT \`pipeline_runs_id\` PRIMARY KEY(\`id\`),
      CONSTRAINT \`pipeline_runs_runId_unique\` UNIQUE(\`runId\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`stage_logs\` (
      \`id\` int AUTO_INCREMENT NOT NULL,
      \`runId\` varchar(128) NOT NULL,
      \`stageNumber\` int NOT NULL,
      \`stageName\` varchar(128) NOT NULL,
      \`phaseName\` varchar(128) NOT NULL,
      \`status\` enum('pending','running','done','failed','blocked_approval','skipped') NOT NULL DEFAULT 'pending',
      \`output\` text,
      \`errorMessage\` text,
      \`metrics\` json,
      \`durationMs\` int,
      \`startedAt\` timestamp,
      \`completedAt\` timestamp,
      \`createdAt\` timestamp NOT NULL DEFAULT (now()),
      CONSTRAINT \`stage_logs_id\` PRIMARY KEY(\`id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`papers\` (
      \`id\` int AUTO_INCREMENT NOT NULL,
      \`runId\` varchar(128) NOT NULL,
      \`paperId\` varchar(256) NOT NULL,
      \`title\` text NOT NULL,
      \`authors\` text,
      \`year\` int,
      \`abstract\` text,
      \`venue\` varchar(512),
      \`citationCount\` int DEFAULT 0,
      \`doi\` varchar(256),
      \`arxivId\` varchar(128),
      \`url\` text,
      \`source\` varchar(64),
      \`bibtex\` text,
      \`createdAt\` timestamp NOT NULL DEFAULT (now()),
      CONSTRAINT \`papers_id\` PRIMARY KEY(\`id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`artifacts\` (
      \`id\` int AUTO_INCREMENT NOT NULL,
      \`runId\` varchar(128) NOT NULL,
      \`stageNumber\` int,
      \`artifactType\` varchar(64) NOT NULL,
      \`fileName\` varchar(256) NOT NULL,
      \`fileUrl\` text,
      \`fileKey\` varchar(512),
      \`mimeType\` varchar(128),
      \`sizeBytes\` int,
      \`metadata\` json,
      \`createdAt\` timestamp NOT NULL DEFAULT (now()),
      CONSTRAINT \`artifacts_id\` PRIMARY KEY(\`id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`user_settings\` (
      \`id\` int AUTO_INCREMENT NOT NULL,
      \`userId\` int,
      \`settingKey\` varchar(128) NOT NULL,
      \`settingValue\` text,
      \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT \`user_settings_id\` PRIMARY KEY(\`id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`dataset_files\` (
      \`id\` int AUTO_INCREMENT NOT NULL,
      \`runId\` varchar(128),
      \`userId\` int,
      \`originalName\` varchar(512) NOT NULL,
      \`fileKey\` varchar(512) NOT NULL,
      \`fileUrl\` text NOT NULL,
      \`mimeType\` varchar(128),
      \`sizeBytes\` int,
      \`fileType\` enum('csv','excel','dta','json','tsv','other') NOT NULL DEFAULT 'other',
      \`columnNames\` json,
      \`rowCount\` int,
      \`preview\` text,
      \`createdAt\` timestamp NOT NULL DEFAULT (now()),
      CONSTRAINT \`dataset_files_id\` PRIMARY KEY(\`id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`experiment_results\` (
      \`id\` int AUTO_INCREMENT NOT NULL,
      \`runId\` varchar(128) NOT NULL,
      \`stageNumber\` int,
      \`executionStatus\` enum('pending','running','success','error') NOT NULL DEFAULT 'pending',
      \`pythonCode\` text,
      \`stdout\` text,
      \`stderr\` text,
      \`exitCode\` int,
      \`executionTimeMs\` int,
      \`generatedCharts\` json,
      \`generatedTables\` json,
      \`metrics\` json,
      \`createdAt\` timestamp NOT NULL DEFAULT (now()),
      CONSTRAINT \`experiment_results_id\` PRIMARY KEY(\`id\`)
    )`,
  ];

  for (const statement of statements) {
    await conn.query(statement);
  }

  try {
    await conn.query("ALTER TABLE `pipeline_runs` MODIFY COLUMN `status` enum('pending','running','completed','failed','stopped','awaiting_approval') NOT NULL DEFAULT 'pending'");
  } catch (error) {
    console.warn('pipeline_runs.status alter skipped:', error.message);
  }

  for (const file of ['drizzle/0001_wise_prima.sql', 'drizzle/0002_goofy_human_robot.sql']) {
    const hash = migrationHash(file);
    const [rows] = await conn.query('SELECT id FROM __drizzle_migrations WHERE hash = ? LIMIT 1', [hash]);
    if (!Array.isArray(rows) || rows.length === 0) {
      await conn.query('INSERT INTO __drizzle_migrations (`hash`, `created_at`) VALUES (?, ?)', [hash, Date.now()]);
      console.log(`Recorded migration hash for ${file}`);
    }
  }

  const [tables] = await conn.query('SHOW TABLES');
  console.log(JSON.stringify(tables, null, 2));
} finally {
  await conn.end();
}
