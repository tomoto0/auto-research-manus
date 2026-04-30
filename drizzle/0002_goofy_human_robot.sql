CREATE TABLE `dataset_files` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` varchar(128),
	`userId` int,
	`originalName` varchar(512) NOT NULL,
	`fileKey` varchar(512) NOT NULL,
	`fileUrl` text NOT NULL,
	`mimeType` varchar(128),
	`sizeBytes` int,
	`fileType` enum('csv','excel','dta','json','tsv','other') NOT NULL DEFAULT 'other',
	`columnNames` json,
	`rowCount` int,
	`preview` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dataset_files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `experiment_results` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` varchar(128) NOT NULL,
	`stageNumber` int,
	`executionStatus` enum('pending','running','success','error') NOT NULL DEFAULT 'pending',
	`pythonCode` text,
	`stdout` text,
	`stderr` text,
	`exitCode` int,
	`executionTimeMs` int,
	`generatedCharts` json,
	`generatedTables` json,
	`metrics` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `experiment_results_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `pipeline_runs` MODIFY COLUMN `status` enum('pending','running','completed','failed','stopped','awaiting_approval') NOT NULL DEFAULT 'pending';