CREATE TABLE `artifacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` varchar(128) NOT NULL,
	`stageNumber` int,
	`artifactType` varchar(64) NOT NULL,
	`fileName` varchar(256) NOT NULL,
	`fileUrl` text,
	`fileKey` varchar(512),
	`mimeType` varchar(128),
	`sizeBytes` int,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `artifacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `papers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` varchar(128) NOT NULL,
	`paperId` varchar(256) NOT NULL,
	`title` text NOT NULL,
	`authors` text,
	`year` int,
	`abstract` text,
	`venue` varchar(512),
	`citationCount` int DEFAULT 0,
	`doi` varchar(256),
	`arxivId` varchar(128),
	`url` text,
	`source` varchar(64),
	`bibtex` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `papers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` varchar(128) NOT NULL,
	`userId` int,
	`topic` text NOT NULL,
	`status` enum('pending','running','completed','failed','stopped') NOT NULL DEFAULT 'pending',
	`currentStage` int NOT NULL DEFAULT 0,
	`totalStages` int NOT NULL DEFAULT 23,
	`stagesDone` int NOT NULL DEFAULT 0,
	`stagesFailed` int NOT NULL DEFAULT 0,
	`autoApprove` int NOT NULL DEFAULT 1,
	`config` json,
	`errorMessage` text,
	`paperMarkdown` text,
	`paperLatex` text,
	`referencesBib` text,
	`experimentCode` text,
	`reviewReport` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	CONSTRAINT `pipeline_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `pipeline_runs_runId_unique` UNIQUE(`runId`)
);
--> statement-breakpoint
CREATE TABLE `stage_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` varchar(128) NOT NULL,
	`stageNumber` int NOT NULL,
	`stageName` varchar(128) NOT NULL,
	`phaseName` varchar(128) NOT NULL,
	`status` enum('pending','running','done','failed','blocked_approval','skipped') NOT NULL DEFAULT 'pending',
	`output` text,
	`errorMessage` text,
	`metrics` json,
	`durationMs` int,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stage_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int,
	`settingKey` varchar(128) NOT NULL,
	`settingValue` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_settings_id` PRIMARY KEY(`id`)
);
