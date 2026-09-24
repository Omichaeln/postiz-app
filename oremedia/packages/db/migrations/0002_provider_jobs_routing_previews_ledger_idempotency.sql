CREATE TABLE `preview_exports` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`render_job_id` varchar(32) NOT NULL,
	`page_id` varchar(40) NOT NULL,
	`format_key` varchar(40) NOT NULL,
	`mime` varchar(40) NOT NULL,
	`width` int NOT NULL,
	`height` int NOT NULL,
	`bytes` bigint NOT NULL,
	`storage_key` varchar(300) NOT NULL,
	`content_hash` char(64) NOT NULL,
	`renderer_version` varchar(40) NOT NULL,
	`manifest` json NOT NULL,
	`validation` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `preview_exports_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_preview_export_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `render_previews` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`render_job_id` varchar(32) NOT NULL,
	`base_revision_id` varchar(32) NOT NULL,
	`snapshot` json NOT NULL,
	`content_hash` char(64) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `render_previews_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_render_preview_job` UNIQUE(`tenant_id`,`render_job_id`),
	CONSTRAINT `uq_render_preview_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `model_routing_policies` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`document` json NOT NULL,
	`updated_by_kind` varchar(30) NOT NULL,
	`updated_by_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `model_routing_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_model_routing_policy_tenant` UNIQUE(`tenant_id`)
);
--> statement-breakpoint
CREATE TABLE `provider_jobs` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`run_id` varchar(32) NOT NULL,
	`step_id` varchar(32) NOT NULL,
	`tool_name` varchar(80) NOT NULL,
	`tool_call_id` varchar(128) NOT NULL,
	`provider` varchar(40) NOT NULL,
	`provider_job_id` varchar(200) NOT NULL,
	`status` enum('submitted','succeeded','failed') NOT NULL DEFAULT 'submitted',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `provider_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_provider_job_call` UNIQUE(`tenant_id`,`run_id`,`step_id`,`tool_name`,`tool_call_id`),
	CONSTRAINT `uq_provider_job_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `usage_ledger` ADD `idempotency_key` varchar(200);--> statement-breakpoint
ALTER TABLE `render_jobs` ADD CONSTRAINT `uq_render_job_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`);--> statement-breakpoint
ALTER TABLE `usage_ledger` ADD CONSTRAINT `uq_usage_idempotency` UNIQUE(`tenant_id`,`idempotency_key`);--> statement-breakpoint
ALTER TABLE `preview_exports` ADD CONSTRAINT `fk_preview_export_job` FOREIGN KEY (`tenant_id`,`brand_id`,`render_job_id`) REFERENCES `render_jobs`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `render_previews` ADD CONSTRAINT `fk_render_preview_job` FOREIGN KEY (`tenant_id`,`brand_id`,`render_job_id`) REFERENCES `render_jobs`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `render_previews` ADD CONSTRAINT `fk_render_preview_revision` FOREIGN KEY (`tenant_id`,`brand_id`,`base_revision_id`) REFERENCES `creative_revisions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_routing_policies` ADD CONSTRAINT `fk_model_routing_policy_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `provider_jobs` ADD CONSTRAINT `fk_provider_job_run` FOREIGN KEY (`tenant_id`,`brand_id`,`run_id`) REFERENCES `agent_runs`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_preview_export_job` ON `preview_exports` (`tenant_id`,`brand_id`,`render_job_id`);--> statement-breakpoint
CREATE INDEX `ix_render_preview_job` ON `render_previews` (`tenant_id`,`brand_id`,`render_job_id`);--> statement-breakpoint
CREATE INDEX `ix_render_preview_revision` ON `render_previews` (`tenant_id`,`brand_id`,`base_revision_id`);--> statement-breakpoint
CREATE INDEX `ix_provider_job_run` ON `provider_jobs` (`tenant_id`,`brand_id`,`run_id`);