CREATE TABLE `api_clients` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`service_principal_id` varchar(32) NOT NULL,
	`key_hash` char(64) NOT NULL,
	`key_prefix` varchar(12) NOT NULL,
	`scopes` json NOT NULL,
	`last_used_at` datetime(3),
	`expires_at` datetime(3),
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `api_clients_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_api_client_key` UNIQUE(`key_hash`)
);
--> statement-breakpoint
CREATE TABLE `brand_grants` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`membership_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`roles` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `brand_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_brand_grant` UNIQUE(`tenant_id`,`membership_id`,`brand_id`)
);
--> statement-breakpoint
CREATE TABLE `external_reviewer_links` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`review_request_id` varchar(32) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`email` varchar(320) NOT NULL,
	`email_verified_at` datetime(3),
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`last_used_at` datetime(3),
	`created_by_user_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `external_reviewer_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_reviewer_link_token` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`user_id` varchar(32) NOT NULL,
	`role` enum('owner','admin','brand_manager','creator','reviewer','publisher','analyst','community') NOT NULL,
	`status` enum('invited','active','disabled') NOT NULL,
	`all_brands` boolean NOT NULL DEFAULT false,
	`invited_email` varchar(320),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `memberships_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_membership` UNIQUE(`tenant_id`,`user_id`),
	CONSTRAINT `uq_membership_ti` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `service_principals` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`kind` enum('agent','api_client','mcp_client','integration') NOT NULL,
	`name` varchar(120) NOT NULL,
	`grants` json NOT NULL,
	`max_autonomy` enum('assist','create','prepare_release','managed_autopublish') NOT NULL DEFAULT 'create',
	`status` enum('active','revoked') NOT NULL,
	`created_by_user_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `service_principals_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_service_principal_ti` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(32) NOT NULL,
	`user_id` varchar(32) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`selected_tenant_id` varchar(32),
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`ip_hash` varchar(64),
	`user_agent_hash` varchar(64),
	`created_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_session_token` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `support_sessions` (
	`id` varchar(32) NOT NULL,
	`operator_id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`reason` text NOT NULL,
	`ticket_ref` varchar(80) NOT NULL,
	`consent_recorded` boolean NOT NULL DEFAULT false,
	`mode` enum('read_only','escalated') NOT NULL DEFAULT 'read_only',
	`escalated_by_operator_id` varchar(32),
	`expires_at` datetime(3) NOT NULL,
	`closed_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `support_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` varchar(32) NOT NULL,
	`name` varchar(200) NOT NULL,
	`slug` varchar(80) NOT NULL,
	`billing_account_id` varchar(32),
	`data_region` varchar(16) NOT NULL DEFAULT 'default',
	`status` enum('active','suspended','closing') NOT NULL DEFAULT 'active',
	`policy` json,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenants_slug` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(32) NOT NULL,
	`email` varchar(320) NOT NULL,
	`name` varchar(200) NOT NULL,
	`locale` varchar(16) NOT NULL DEFAULT 'en',
	`status` enum('active','disabled','deleted') NOT NULL DEFAULT 'active',
	`mfa_enrolled` boolean NOT NULL DEFAULT false,
	`password_hash` varchar(255),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_users_email` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `approved_facts` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`kind` enum('product','claim','offer','contact','price','statistic','legal') NOT NULL,
	`statement` text NOT NULL,
	`evidence` json NOT NULL,
	`valid_from` datetime(3),
	`valid_until` datetime(3),
	`state` enum('proposed','approved','revoked') NOT NULL,
	`proposed_by_kind` enum('user','agent') NOT NULL,
	`proposed_by_id` varchar(32) NOT NULL,
	`approved_by_user_id` varchar(32),
	`revoked_by_user_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `approved_facts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_fact_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `brand_objectives` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`name` varchar(160) NOT NULL,
	`primary_metric_key` varchar(80) NOT NULL,
	`guardrail_metric_keys` json NOT NULL,
	`engagement_quality_weights` json,
	`active_from` datetime(3) NOT NULL,
	`active_until` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `brand_objectives_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_objective_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `brand_versions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`number` int NOT NULL,
	`state` enum('draft','in_review','published','retired') NOT NULL,
	`document` json NOT NULL,
	`content_hash` char(64) NOT NULL,
	`published_at` datetime(3),
	`published_by_user_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `brand_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_brand_version_number` UNIQUE(`tenant_id`,`brand_id`,`number`),
	CONSTRAINT `uq_brand_version_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `brands` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`name` varchar(200) NOT NULL,
	`timezone` varchar(64) NOT NULL,
	`default_locale` varchar(16) NOT NULL,
	`published_version_id` varchar(32),
	`active_policy_version_id` varchar(32),
	`status` enum('setup','active','archived') NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `brands_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_brand_tenant_id` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `design_tokens` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`brand_version_id` varchar(32) NOT NULL,
	`token_set` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `design_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_design_tokens_version` UNIQUE(`tenant_id`,`brand_version_id`)
);
--> statement-breakpoint
CREATE TABLE `policy_versions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`number` int NOT NULL,
	`document` json NOT NULL,
	`state` enum('draft','active','retired') NOT NULL,
	`created_by_user_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `policy_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_policy_version_number` UNIQUE(`tenant_id`,`brand_id`,`number`),
	CONSTRAINT `uq_policy_version_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `asset_derivatives` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`asset_version_id` varchar(32) NOT NULL,
	`purpose` varchar(40) NOT NULL,
	`transform` json NOT NULL,
	`storage_key` varchar(300) NOT NULL,
	`content_hash` char(64) NOT NULL,
	`mime` varchar(100) NOT NULL,
	`width` int,
	`height` int,
	`bytes` bigint NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `asset_derivatives_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `asset_grants` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`asset_id` varchar(32) NOT NULL,
	`grantee_brand_id` varchar(32) NOT NULL,
	`purpose` varchar(40) NOT NULL,
	`expires_at` datetime(3),
	`created_by_user_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `asset_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_asset_grant` UNIQUE(`tenant_id`,`asset_id`,`grantee_brand_id`,`purpose`)
);
--> statement-breakpoint
CREATE TABLE `asset_usages` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`asset_version_id` varchar(32) NOT NULL,
	`used_by_type` varchar(40) NOT NULL,
	`used_by_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `asset_usages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_asset_usage` UNIQUE(`tenant_id`,`asset_version_id`,`used_by_type`,`used_by_id`)
);
--> statement-breakpoint
CREATE TABLE `asset_versions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`asset_id` varchar(32) NOT NULL,
	`number` int NOT NULL,
	`storage_key` varchar(300) NOT NULL,
	`content_hash` char(64) NOT NULL,
	`mime` varchar(100) NOT NULL,
	`bytes` bigint NOT NULL,
	`width` int,
	`height` int,
	`duration_ms` int,
	`colour_profile` varchar(40),
	`focal_point` json,
	`alt_text` varchar(1000),
	`provenance` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `asset_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_asset_version_number` UNIQUE(`tenant_id`,`asset_id`,`number`),
	CONSTRAINT `uq_asset_version_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`kind` enum('logo','photo','icon','illustration','font','video','audio','template','reference') NOT NULL,
	`semantic_role` varchar(40),
	`name` varchar(200) NOT NULL,
	`current_version_id` varchar(32),
	`state` enum('pending_review','approved','rejected','retired') NOT NULL,
	`rights_state` enum('unknown','recorded') NOT NULL DEFAULT 'unknown',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_asset_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`asset_ids` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `collections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `upload_intents` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`kind` enum('logo','photo','icon','illustration','font','video','audio','template','reference') NOT NULL,
	`declared_mime` varchar(100) NOT NULL,
	`declared_bytes` bigint NOT NULL,
	`max_bytes` bigint NOT NULL,
	`storage_key` varchar(300) NOT NULL,
	`original_filename` varchar(255) NOT NULL,
	`state` enum('issued','uploaded','quarantined','accepted','rejected') NOT NULL,
	`rejection_reason` varchar(200),
	`result_asset_id` varchar(32),
	`created_by_user_id` varchar(32) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `upload_intents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `usage_rights` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`asset_id` varchar(32) NOT NULL,
	`owner` varchar(200) NOT NULL,
	`licence_ref` varchar(500),
	`permitted_channels` json NOT NULL,
	`territories` json NOT NULL,
	`expires_at` datetime(3),
	`releases` json NOT NULL,
	`restrictions` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `usage_rights_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_usage_rights_asset` UNIQUE(`tenant_id`,`asset_id`)
);
--> statement-breakpoint
CREATE TABLE `creative_documents` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`content_package_id` varchar(32),
	`title` varchar(200) NOT NULL,
	`current_revision_id` varchar(32),
	`schema_version` int NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `creative_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_creative_doc_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `creative_revisions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`document_id` varchar(32) NOT NULL,
	`parent_revision_id` varchar(32),
	`number` int NOT NULL,
	`brand_version_id` varchar(32) NOT NULL,
	`agent_run_id` varchar(32),
	`author_kind` enum('user','agent') NOT NULL,
	`author_id` varchar(32) NOT NULL,
	`change_summary` varchar(500) NOT NULL,
	`operations` json NOT NULL,
	`snapshot` json NOT NULL,
	`content_hash` char(64) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `creative_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_rev_number` UNIQUE(`tenant_id`,`document_id`,`number`),
	CONSTRAINT `uq_rev_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `element_comments` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`document_id` varchar(32) NOT NULL,
	`revision_id` varchar(32) NOT NULL,
	`element_id` varchar(40) NOT NULL,
	`body` text NOT NULL,
	`author_kind` enum('user','external_reviewer','agent') NOT NULL,
	`author_id` varchar(32) NOT NULL,
	`state` enum('open','resolved','outdated') NOT NULL DEFAULT 'open',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `element_comments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `render_jobs` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`revision_id` varchar(32) NOT NULL,
	`format_keys` json NOT NULL,
	`state` enum('pending','rendering','ready','failed') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`error` varchar(2000),
	`requested_by_kind` enum('user','agent','system') NOT NULL,
	`requested_by_id` varchar(32) NOT NULL,
	`export_ids` json,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `render_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rendered_exports` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`revision_id` varchar(32) NOT NULL,
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
	CONSTRAINT `rendered_exports_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_export_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `template_versions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`template_id` varchar(32) NOT NULL,
	`number` int NOT NULL,
	`slots` json NOT NULL,
	`constraints` json NOT NULL,
	`formats` json NOT NULL,
	`document` json NOT NULL,
	`content_hash` char(64) NOT NULL,
	`state` enum('draft','approved','retired') NOT NULL DEFAULT 'draft',
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `template_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_template_version_number` UNIQUE(`tenant_id`,`template_id`,`number`),
	CONSTRAINT `uq_template_version_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`name` varchar(200) NOT NULL,
	`current_version_id` varchar(32),
	`state` enum('draft','active','retired') NOT NULL DEFAULT 'draft',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_template_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `briefs` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`campaign_id` varchar(32),
	`audience` text NOT NULL,
	`message` text NOT NULL,
	`offer_fact_ids` json NOT NULL,
	`channel_connection_ids` json NOT NULL,
	`constraints` json NOT NULL,
	`state` enum('draft','accepted','in_progress','delivered','cancelled') NOT NULL DEFAULT 'draft',
	`created_by_kind` enum('user','agent') NOT NULL,
	`created_by_id` varchar(32) NOT NULL,
	`agent_run_id` varchar(32),
	`recommendation_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `briefs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_brief_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`objective_id` varchar(32),
	`name` varchar(200) NOT NULL,
	`starts_at` datetime(3) NOT NULL,
	`ends_at` datetime(3) NOT NULL,
	`state` enum('draft','active','completed','archived') NOT NULL DEFAULT 'draft',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `campaigns_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_campaign_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `channel_variants` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`content_revision_id` varchar(32) NOT NULL,
	`channel_connection_id` varchar(32) NOT NULL,
	`text` text NOT NULL,
	`alt_texts` json NOT NULL,
	`settings` json NOT NULL,
	`export_ids` json NOT NULL,
	`capability_version` int NOT NULL,
	`validation` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `channel_variants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_variant_target` UNIQUE(`tenant_id`,`content_revision_id`,`channel_connection_id`),
	CONSTRAINT `uq_variant_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `content_packages` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`brief_id` varchar(32),
	`title` varchar(200) NOT NULL,
	`current_revision_id` varchar(32),
	`state` enum('draft','in_review','approved','scheduled','published','archived') NOT NULL DEFAULT 'draft',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `content_packages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_package_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `content_revisions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`package_id` varchar(32) NOT NULL,
	`number` int NOT NULL,
	`brand_version_id` varchar(32) NOT NULL,
	`policy_version_id` varchar(32) NOT NULL,
	`copy` json NOT NULL,
	`creative_revision_ids` json NOT NULL,
	`fact_refs` json NOT NULL,
	`content_hash` char(64) NOT NULL,
	`state` enum('draft','in_review','changes_requested','approved','superseded') NOT NULL DEFAULT 'draft',
	`author_kind` enum('user','agent') NOT NULL,
	`author_id` varchar(32) NOT NULL,
	`agent_run_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `content_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_content_rev_number` UNIQUE(`tenant_id`,`package_id`,`number`),
	CONSTRAINT `uq_content_rev_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `creative_attributes` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`content_revision_id` varchar(32),
	`channel_variant_id` varchar(32),
	`attributes` json NOT NULL,
	`source` enum('captured','human_corrected','inferred') NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `creative_attributes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `publishing_mandates` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`owner_user_id` varchar(32) NOT NULL,
	`service_principal_id` varchar(32) NOT NULL,
	`channel_connection_ids` json NOT NULL,
	`allowed_content_classes` json NOT NULL,
	`source_rules` json NOT NULL,
	`max_posts_per_day` int NOT NULL,
	`window_start` datetime(3) NOT NULL,
	`window_end` datetime(3) NOT NULL,
	`state` enum('active','paused','revoked','expired') NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `publishing_mandates_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_mandate_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `release_approvals` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`content_revision_id` varchar(32) NOT NULL,
	`review_request_id` varchar(32) NOT NULL,
	`approver_kind` enum('user','external_reviewer') NOT NULL,
	`approver_id` varchar(32) NOT NULL,
	`binding_hash` char(64) NOT NULL,
	`binding` json NOT NULL,
	`valid_until` datetime(3),
	`state` enum('valid','invalidated','consumed','expired') NOT NULL,
	`invalidated_reason` varchar(80),
	`created_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `release_approvals_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_approval_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `review_decisions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`review_request_id` varchar(32) NOT NULL,
	`decider_kind` enum('user','external_reviewer') NOT NULL,
	`decider_id` varchar(32) NOT NULL,
	`decision` enum('approve','request_changes','reject') NOT NULL,
	`comment` text,
	`manifest_hash` char(64) NOT NULL,
	`verified_email` varchar(320),
	`ip_hash` varchar(64),
	`user_agent_hash` varchar(64),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `review_decisions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `review_requests` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`content_revision_id` varchar(32) NOT NULL,
	`frozen_manifest` json NOT NULL,
	`manifest_hash` char(64) NOT NULL,
	`assignees` json NOT NULL,
	`due_at` datetime(3),
	`state` enum('open','stale','decided','cancelled') NOT NULL DEFAULT 'open',
	`stale_reason` varchar(200),
	`requested_by_kind` enum('user','agent') NOT NULL,
	`requested_by_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `review_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_review_request_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `evaluation_results` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32),
	`suite_id` varchar(32) NOT NULL,
	`skill_version_id` varchar(32) NOT NULL,
	`model_version` varchar(80) NOT NULL,
	`runs` int NOT NULL,
	`scores` json NOT NULL,
	`variance` json NOT NULL,
	`deterministic_checks` json NOT NULL,
	`passed` boolean NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `evaluation_results_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `evaluation_suites` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32),
	`skill_version_id` varchar(32) NOT NULL,
	`cases` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `evaluation_suites_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `skill_bindings` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`skill_version_id` varchar(32) NOT NULL,
	`task_kind` varchar(40) NOT NULL,
	`priority` int NOT NULL DEFAULT 100,
	`created_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `skill_bindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_skill_binding` UNIQUE(`tenant_id`,`brand_id`,`task_kind`,`skill_version_id`)
);
--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32),
	`skill_id` varchar(32) NOT NULL,
	`number` int NOT NULL,
	`manifest` json NOT NULL,
	`instructions` text NOT NULL,
	`references` json NOT NULL,
	`package_hash` char(64) NOT NULL,
	`state` enum('draft','sandbox_evaluation','in_review','published','retired') NOT NULL DEFAULT 'draft',
	`rollout_percent` int NOT NULL DEFAULT 0,
	`published_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `skill_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_skill_version_number` UNIQUE(`skill_id`,`number`)
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32),
	`scope` enum('platform','tenant','brand') NOT NULL,
	`brand_id` varchar(32),
	`key` varchar(80) NOT NULL,
	`title` varchar(200) NOT NULL,
	`owner_user_id` varchar(32),
	`active_version_id` varchar(32),
	`state` enum('active','retired') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `skills_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_skill_key` UNIQUE(`scope`,`tenant_id`,`brand_id`,`key`)
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`initiator_kind` enum('user','system','recommendation') NOT NULL,
	`initiator_id` varchar(32) NOT NULL,
	`service_principal_id` varchar(32) NOT NULL,
	`autonomy_mode` enum('assist','create','prepare_release','managed_autopublish') NOT NULL,
	`task_kind` varchar(40) NOT NULL,
	`brief` json NOT NULL,
	`context_snapshot_hash` char(64),
	`skill_version_ids` json NOT NULL,
	`model_config` json NOT NULL,
	`state` enum('planned','running','waiting_for_review','completed','failed','cancelled','budget_exhausted','policy_denied','waiting_expired') NOT NULL,
	`budget_reservation_id` varchar(32),
	`cost_micros` bigint NOT NULL DEFAULT 0,
	`deadline_at` datetime(3) NOT NULL,
	`workflow_id` varchar(120),
	`correlation_id` varchar(64) NOT NULL,
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `agent_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_run_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_steps` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`run_id` varchar(32) NOT NULL,
	`index` int NOT NULL,
	`kind` enum('plan','model_call','tool_call','validation') NOT NULL,
	`summary` varchar(1000) NOT NULL,
	`tokens_in` int NOT NULL DEFAULT 0,
	`tokens_out` int NOT NULL DEFAULT 0,
	`cost_micros` bigint NOT NULL DEFAULT 0,
	`duration_ms` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `agent_steps_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_step` UNIQUE(`tenant_id`,`run_id`,`index`)
);
--> statement-breakpoint
CREATE TABLE `tool_invocations` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`run_id` varchar(32) NOT NULL,
	`step_id` varchar(32) NOT NULL,
	`tool_name` varchar(80) NOT NULL,
	`input_hash` char(64) NOT NULL,
	`input_redacted` json NOT NULL,
	`policy_decision` enum('allowed','denied','invalid') NOT NULL,
	`policy_reason` varchar(80),
	`outcome` enum('ok','error','denied','invalid','proposal') NOT NULL,
	`output_ref` varchar(200),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `tool_invocations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `channel_connections` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`provider_key` varchar(40) NOT NULL,
	`remote_account_id` varchar(200) NOT NULL,
	`display_name` varchar(200) NOT NULL,
	`credential_ref_id` varchar(32) NOT NULL,
	`granted_scopes` json NOT NULL,
	`missing_scopes` json NOT NULL DEFAULT ('[]'),
	`status` enum('active','refresh_needed','reconnect_needed','disabled') NOT NULL,
	`token_expires_at` datetime(3),
	`capability_version` int NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `channel_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_channel_remote` UNIQUE(`tenant_id`,`provider_key`,`remote_account_id`),
	CONSTRAINT `uq_channel_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `credential_refs` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`kms_key_id` varchar(200) NOT NULL,
	`wrapped_data_key` varbinary(512) NOT NULL,
	`ciphertext` varbinary(8192) NOT NULL,
	`iv` varbinary(12) NOT NULL,
	`auth_tag` varbinary(16) NOT NULL,
	`aad` varchar(200) NOT NULL,
	`rotated_at` datetime(3),
	`destroyed_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `credential_refs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_credential_ref_ti` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `provider_capabilities` (
	`key` varchar(40) NOT NULL,
	`version` int NOT NULL,
	`capability` json NOT NULL,
	`certified_at` datetime(3),
	`enabled` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `uq_provider_capability` UNIQUE(`key`,`version`)
);
--> statement-breakpoint
CREATE TABLE `publication_attempts` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`publication_id` varchar(32) NOT NULL,
	`attempt_number` int NOT NULL,
	`fencing_token` int NOT NULL,
	`request_fingerprint` char(64) NOT NULL,
	`provider_idempotency_key` varchar(120),
	`started_at` datetime(3) NOT NULL,
	`sent_at` datetime(3),
	`finished_at` datetime(3),
	`outcome` enum('accepted','pending','rejected','retryable_error','unknown') NOT NULL,
	`error_code` varchar(80),
	`error_detail` varchar(2000),
	`remote_job_id` varchar(200),
	`remote_post_id` varchar(200),
	`pending_state` json,
	CONSTRAINT `publication_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_attempt_fence` UNIQUE(`tenant_id`,`publication_id`,`fencing_token`)
);
--> statement-breakpoint
CREATE TABLE `publications` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`content_package_id` varchar(32) NOT NULL,
	`content_revision_id` varchar(32) NOT NULL,
	`channel_variant_id` varchar(32) NOT NULL,
	`channel_connection_id` varchar(32) NOT NULL,
	`occurrence_key` varchar(120) NOT NULL,
	`authority` enum('approval','mandate') NOT NULL,
	`approval_id` varchar(32),
	`mandate_id` varchar(32),
	`scheduled_for` datetime(3) NOT NULL,
	`state` enum('scheduled','dispatching','processing','published','failed','outcome_unknown','retry_eligible','cancelled','held') NOT NULL,
	`state_reason` varchar(120),
	`hold_reasons` json,
	`remote_post_id` varchar(200),
	`remote_url` varchar(1000),
	`fencing_token` int NOT NULL DEFAULT 0,
	`claimant` varchar(160),
	`claimed_at` datetime(3),
	`scheduled_by_kind` enum('user','service_principal') NOT NULL,
	`scheduled_by_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `publications_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_publication_occurrence` UNIQUE(`tenant_id`,`occurrence_key`),
	CONSTRAINT `uq_publication_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`),
	CONSTRAINT `uq_publication_ti` UNIQUE(`tenant_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `remote_evidence` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`publication_id` varchar(32) NOT NULL,
	`attempt_id` varchar(32),
	`kind` enum('accepted_response','status_poll','reconciliation','human_confirmation','metrics_readback') NOT NULL,
	`remote_post_id` varchar(200),
	`remote_url` varchar(1000),
	`payload` json NOT NULL,
	`payload_hash` char(64) NOT NULL,
	`captured_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `remote_evidence_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`source` enum('crm','pixel','form') NOT NULL,
	`external_ref` varchar(200) NOT NULL,
	`attributed_link_id` varchar(32),
	`attribution_method` varchar(40) NOT NULL DEFAULT 'last_tracked_touch',
	`qualified` boolean NOT NULL DEFAULT false,
	`value_micros` bigint,
	`currency` varchar(3),
	`occurred_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `conversions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_conversion_ref` UNIQUE(`tenant_id`,`source`,`external_ref`)
);
--> statement-breakpoint
CREATE TABLE `link_clicks` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`tracked_link_id` varchar(32) NOT NULL,
	`visitor_hash` varchar(64) NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `link_clicks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `metric_definitions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32),
	`key` varchar(80) NOT NULL,
	`provider_key` varchar(40),
	`native_name` varchar(120) NOT NULL,
	`unit` varchar(40) NOT NULL,
	`aggregation` enum('sum','max','last','avg','series') NOT NULL,
	`comparable_group` varchar(40) NOT NULL,
	`definition_version` int NOT NULL,
	`separates_paid_organic` boolean NOT NULL DEFAULT false,
	`definition` varchar(1000),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `metric_definitions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_metric_definition` UNIQUE(`key`,`provider_key`,`definition_version`,`tenant_id`)
);
--> statement-breakpoint
CREATE TABLE `metric_snapshots` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`subject_type` enum('publication','channel','campaign','link') NOT NULL,
	`subject_id` varchar(32) NOT NULL,
	`metric_key` varchar(80) NOT NULL,
	`value` double,
	`series` json,
	`window_start` datetime(3) NOT NULL,
	`window_end` datetime(3) NOT NULL,
	`fetched_at` datetime(3) NOT NULL,
	`source` varchar(80) NOT NULL,
	`completeness` enum('complete','partial','unavailable') NOT NULL,
	`definition_version` int NOT NULL,
	`numerator_snapshot_id` varchar(32),
	`denominator_snapshot_id` varchar(32),
	`brand_timezone` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `metric_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tracked_links` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`publication_id` varchar(32),
	`variant_id` varchar(32),
	`experiment_id` varchar(32),
	`experiment_variant_id` varchar(32),
	`destination` varchar(2000) NOT NULL,
	`utm` json NOT NULL,
	`short_code` varchar(16) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `tracked_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tracked_link_code` UNIQUE(`short_code`)
);
--> statement-breakpoint
CREATE TABLE `anomalies` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`signal` varchar(120) NOT NULL,
	`baseline` double NOT NULL,
	`observed` double NOT NULL,
	`severity` enum('low','medium','high') NOT NULL,
	`detected_at` datetime(3) NOT NULL,
	`state` enum('open','acknowledged','resolved') NOT NULL DEFAULT 'open',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `anomalies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customer_voice_clusters` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`label` varchar(200) NOT NULL,
	`kind` enum('question','objection','praise','need','complaint') NOT NULL,
	`size` int NOT NULL DEFAULT 0,
	`sample_message_refs` json NOT NULL,
	`centroid` json,
	`linked_recommendation_ids` json NOT NULL DEFAULT ('[]'),
	`first_seen` datetime(3) NOT NULL,
	`last_seen` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `customer_voice_clusters_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `insights` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`kind` enum('change','anomaly','association','experimental_finding') NOT NULL,
	`statement` text NOT NULL,
	`evidence` json NOT NULL,
	`strength` enum('observed','directional','experimentally_supported') NOT NULL,
	`period_start` datetime(3) NOT NULL,
	`period_end` datetime(3) NOT NULL,
	`state` enum('active','superseded','dismissed') NOT NULL DEFAULT 'active',
	`agent_run_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `insights_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_insight_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `learning_records` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`recommendation_id` varchar(32) NOT NULL,
	`context_ref` varchar(200) NOT NULL,
	`evidence_ref` varchar(200) NOT NULL,
	`hypothesis` text NOT NULL,
	`action` varchar(40) NOT NULL,
	`human_decision` enum('accepted','modified','rejected','pending') NOT NULL DEFAULT 'pending',
	`executed_revision_id` varchar(32),
	`observed_outcome_ref` varchar(200),
	`verdict` enum('supported','not_supported','inconclusive','pending') NOT NULL DEFAULT 'pending',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `learning_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_learning_record_recommendation` UNIQUE(`tenant_id`,`recommendation_id`)
);
--> statement-breakpoint
CREATE TABLE `listening_sources` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`kind` enum('keyword','competitor_account','rss','subreddit') NOT NULL,
	`config` json NOT NULL,
	`coverage` json,
	`state` enum('active','paused') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `listening_sources_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `playbook_entries` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`practice` text NOT NULL,
	`evidence_ids` json NOT NULL,
	`strength` enum('observed','directional','experimentally_supported') NOT NULL,
	`approved_by_user_id` varchar(32),
	`review_after` datetime(3) NOT NULL,
	`state` enum('proposed','approved','retired') NOT NULL DEFAULT 'proposed',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `playbook_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recommendations` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`insight_ids` json NOT NULL,
	`proposed_action` enum('create_brief','generate_variants','open_canvas','prepare_test','assign_response','propose_playbook_update') NOT NULL,
	`title` varchar(200) NOT NULL,
	`rationale` text NOT NULL,
	`expected_benefit` json NOT NULL,
	`effort` enum('low','medium','high') NOT NULL,
	`uncertainty` enum('low','medium','high') NOT NULL,
	`rank` int NOT NULL DEFAULT 0,
	`ranking_policy` varchar(40) NOT NULL DEFAULT 'baseline',
	`state` enum('proposed','accepted','dismissed','executed') NOT NULL DEFAULT 'proposed',
	`dismissal_reason` varchar(500),
	`decided_by_user_id` varchar(32),
	`downstream_type` varchar(40),
	`downstream_id` varchar(32),
	`agent_run_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `recommendations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_recommendation_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `experiment_assignments` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`experiment_id` varchar(32) NOT NULL,
	`unit_type` enum('visitor','publication_slot') NOT NULL,
	`unit_id_hash` varchar(64) NOT NULL,
	`variant_id` varchar(32) NOT NULL,
	`assigned_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `experiment_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_experiment_assignment` UNIQUE(`tenant_id`,`experiment_id`,`unit_type`,`unit_id_hash`)
);
--> statement-breakpoint
CREATE TABLE `experiment_results` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`experiment_id` varchar(32) NOT NULL,
	`computed_at` datetime(3) NOT NULL,
	`pre_registration_hash` char(64) NOT NULL,
	`per_variant` json NOT NULL,
	`estimate` double,
	`interval_low` double,
	`interval_high` double,
	`p_value` double,
	`guardrail_breached` json NOT NULL,
	`verdict` enum('supported','not_supported','inconclusive') NOT NULL,
	`verdict_reason` varchar(200) NOT NULL,
	`method_version` varchar(40) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `experiment_results_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `experiment_variants` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`experiment_id` varchar(32) NOT NULL,
	`label` varchar(80) NOT NULL,
	`content_revision_id` varchar(32) NOT NULL,
	`allocation_weight` double NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `experiment_variants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_experiment_variant_label` UNIQUE(`tenant_id`,`experiment_id`,`label`)
);
--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`recommendation_id` varchar(32),
	`hypothesis` text NOT NULL,
	`mode` enum('randomised','structured_comparison') NOT NULL,
	`primary_metric_key` varchar(80) NOT NULL,
	`guardrail_metric_keys` json NOT NULL,
	`allocation_method` varchar(40) NOT NULL,
	`min_sample` json NOT NULL,
	`observation_window` json NOT NULL,
	`stopping_rule` json NOT NULL,
	`pre_registration` json,
	`pre_registration_hash` char(64),
	`pre_registered_at` datetime(3),
	`state` enum('designed','pre_registered','running','stopped','analysed') NOT NULL DEFAULT 'designed',
	`started_at` datetime(3),
	`stopped_at` datetime(3),
	`created_by_kind` enum('user','agent') NOT NULL,
	`created_by_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `experiments_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_experiment_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `community_assignments` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`conversation_id` varchar(32) NOT NULL,
	`assigned_to_user_id` varchar(32) NOT NULL,
	`assigned_by_kind` enum('user','recommendation','rule') NOT NULL,
	`assigned_by_id` varchar(32) NOT NULL,
	`due_at` datetime(3),
	`state` enum('open','done','reassigned') NOT NULL DEFAULT 'open',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `community_assignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`channel_connection_id` varchar(32) NOT NULL,
	`publication_id` varchar(32),
	`remote_thread_id` varchar(200) NOT NULL,
	`state` enum('open','assigned','resolved','escalated','archived') NOT NULL DEFAULT 'open',
	`assigned_to_user_id` varchar(32),
	`last_message_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_conversation_remote` UNIQUE(`tenant_id`,`channel_connection_id`,`remote_thread_id`),
	CONSTRAINT `uq_conversation_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`conversation_id` varchar(32) NOT NULL,
	`remote_message_id` varchar(200) NOT NULL,
	`direction` enum('inbound','outbound') NOT NULL,
	`author_hash` varchar(64) NOT NULL,
	`author_handle` varchar(200),
	`text` text NOT NULL,
	`sentiment` enum('positive','neutral','negative'),
	`classification` enum('question','objection','praise','need','complaint','spam','other'),
	`substantive` enum('yes','no'),
	`cluster_id` varchar(32),
	`remote_created_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_message_remote` UNIQUE(`tenant_id`,`conversation_id`,`remote_message_id`)
);
--> statement-breakpoint
CREATE TABLE `response_drafts` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`conversation_id` varchar(32) NOT NULL,
	`author_kind` enum('user','agent') NOT NULL,
	`author_id` varchar(32) NOT NULL,
	`text` text NOT NULL,
	`fact_refs` json NOT NULL,
	`state` enum('draft','sent','discarded') NOT NULL DEFAULT 'draft',
	`sent_by_user_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `response_drafts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `budget_reservations` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`run_id` varchar(32) NOT NULL,
	`reserved_micros` bigint NOT NULL,
	`consumed_micros` bigint NOT NULL DEFAULT 0,
	`state` enum('held','settled','released') NOT NULL DEFAULT 'held',
	`period_key` varchar(16) NOT NULL,
	`day_key` varchar(10) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `budget_reservations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_budget_reservation_run` UNIQUE(`tenant_id`,`run_id`)
);
--> statement-breakpoint
CREATE TABLE `entitlements` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`feature` varchar(60) NOT NULL,
	`limit_value` int,
	`enabled` enum('yes','no'),
	`reason` varchar(300) NOT NULL,
	`expires_at` datetime(3),
	`granted_by_user_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `entitlements_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_entitlement_feature` UNIQUE(`tenant_id`,`feature`)
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` varchar(32) NOT NULL,
	`key` varchar(40) NOT NULL,
	`name` varchar(120) NOT NULL,
	`limits` json NOT NULL,
	`price_micros_month` bigint NOT NULL DEFAULT 0,
	`currency` varchar(3) NOT NULL DEFAULT 'USD',
	`state` enum('active','grandfathered','retired') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `plans_key_unique` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `spend_limits` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL DEFAULT '',
	`period` enum('day','month') NOT NULL,
	`limit_micros` bigint NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `spend_limits_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_spend_limit` UNIQUE(`tenant_id`,`brand_id`,`period`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`plan_id` varchar(32) NOT NULL,
	`state` enum('trial','active','past_due','grace','cancelled') NOT NULL,
	`trial_ends_at` datetime(3),
	`grace_ends_at` datetime(3),
	`current_period_start` datetime(3) NOT NULL,
	`current_period_end` datetime(3) NOT NULL,
	`external_ref` varchar(200),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_subscription_tenant` UNIQUE(`tenant_id`)
);
--> statement-breakpoint
CREATE TABLE `usage_ledger` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`kind` enum('model_tokens','tool_call','image_generation','render_minutes','storage_bytes') NOT NULL,
	`quantity` int NOT NULL,
	`unit` varchar(20) NOT NULL,
	`cost_micros` bigint NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'USD',
	`source_ref` varchar(200) NOT NULL,
	`reservation_id` varchar(32),
	`period_key` varchar(16) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `usage_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`actor_kind` varchar(24) NOT NULL,
	`actor_id` varchar(32) NOT NULL,
	`support_session_id` varchar(32),
	`action` varchar(80) NOT NULL,
	`resource_type` varchar(60) NOT NULL,
	`resource_id` varchar(32) NOT NULL,
	`decision` enum('allowed','denied') NOT NULL,
	`reason` varchar(120),
	`correlation_id` varchar(64) NOT NULL,
	`metadata` json,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `deletion_requests` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`subject_type` enum('user','asset','brand','tenant','channel_connection','customer_voice') NOT NULL,
	`subject_id` varchar(32) NOT NULL,
	`reason` varchar(500) NOT NULL,
	`requested_by_kind` varchar(24) NOT NULL,
	`requested_by_id` varchar(32) NOT NULL,
	`state` enum('requested','in_progress','completed','blocked') NOT NULL DEFAULT 'requested',
	`fanout` json NOT NULL,
	`blocked_reason` varchar(500),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `deletion_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `external_refs` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`source_system` varchar(40) NOT NULL,
	`source_type` varchar(60) NOT NULL,
	`source_id` varchar(200) NOT NULL,
	`target_type` varchar(60) NOT NULL,
	`target_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `external_refs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_external_ref` UNIQUE(`tenant_id`,`source_system`,`source_type`,`source_id`)
);
--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`key` varchar(80) NOT NULL,
	`enabled_default` boolean NOT NULL DEFAULT false,
	`targeting` json NOT NULL,
	`owner` varchar(120) NOT NULL,
	`removal_date` datetime(3) NOT NULL,
	`success_metric` varchar(200) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `feature_flags_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`tenant_id` varchar(32) NOT NULL,
	`principal_id` varchar(32) NOT NULL,
	`key` varchar(120) NOT NULL,
	`request_hash` char(64) NOT NULL,
	`path` varchar(120) NOT NULL,
	`response_status` int,
	`response_body` json,
	`state` enum('in_progress','completed') NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `idempotency_keys_tenant_id_principal_id_key_pk` PRIMARY KEY(`tenant_id`,`principal_id`,`key`)
);
--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`severity` enum('sev1','sev2','sev3','sev4') NOT NULL,
	`title` varchar(200) NOT NULL,
	`summary` text NOT NULL,
	`state` enum('open','mitigated','resolved','postmortem_done') NOT NULL DEFAULT 'open',
	`opened_by_user_id` varchar(32) NOT NULL,
	`resolved_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `incidents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `kill_switches` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL DEFAULT '',
	`scope` enum('agent_starts','release_dispatch') NOT NULL,
	`engaged` boolean NOT NULL DEFAULT false,
	`reason` varchar(500),
	`engaged_by_user_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `kill_switches_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_kill_switch` UNIQUE(`tenant_id`,`brand_id`,`scope`)
);
--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`aggregate_type` varchar(60) NOT NULL,
	`aggregate_id` varchar(32) NOT NULL,
	`aggregate_version` int NOT NULL,
	`event_type` varchar(80) NOT NULL,
	`schema_version` int NOT NULL,
	`payload` json NOT NULL,
	`correlation_id` varchar(64) NOT NULL,
	`available_at` datetime(3) NOT NULL,
	`claimed_by` varchar(80),
	`claim_expires_at` datetime(3),
	`dispatched_at` datetime(3),
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` varchar(1000),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `outbox_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `retention_policies` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`data_class` enum('user_identity','asset_files','creative_revisions','agent_transcripts','audit_and_evidence','social_tokens','metrics','customer_voice_raw') NOT NULL,
	`retention_days` int,
	`basis` varchar(40) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `retention_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_retention_class` UNIQUE(`tenant_id`,`data_class`)
);
--> statement-breakpoint
ALTER TABLE `api_clients` ADD CONSTRAINT `fk_api_client_sp` FOREIGN KEY (`tenant_id`,`service_principal_id`) REFERENCES `service_principals`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `brand_grants` ADD CONSTRAINT `fk_brand_grant_membership` FOREIGN KEY (`tenant_id`,`membership_id`) REFERENCES `memberships`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memberships` ADD CONSTRAINT `fk_membership_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memberships` ADD CONSTRAINT `fk_membership_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_principals` ADD CONSTRAINT `fk_sp_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `fk_session_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approved_facts` ADD CONSTRAINT `fk_fact_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `brand_objectives` ADD CONSTRAINT `fk_objective_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `brand_versions` ADD CONSTRAINT `fk_brand_version_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `brands` ADD CONSTRAINT `fk_brand_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `design_tokens` ADD CONSTRAINT `fk_design_tokens_version` FOREIGN KEY (`tenant_id`,`brand_id`,`brand_version_id`) REFERENCES `brand_versions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `policy_versions` ADD CONSTRAINT `fk_policy_version_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_derivatives` ADD CONSTRAINT `fk_asset_derivative_version` FOREIGN KEY (`tenant_id`,`brand_id`,`asset_version_id`) REFERENCES `asset_versions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_grants` ADD CONSTRAINT `fk_asset_grant_asset` FOREIGN KEY (`tenant_id`,`brand_id`,`asset_id`) REFERENCES `assets`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_grants` ADD CONSTRAINT `fk_asset_grant_grantee` FOREIGN KEY (`tenant_id`,`grantee_brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_usages` ADD CONSTRAINT `fk_asset_usage_version` FOREIGN KEY (`tenant_id`,`brand_id`,`asset_version_id`) REFERENCES `asset_versions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_versions` ADD CONSTRAINT `fk_asset_version_asset` FOREIGN KEY (`tenant_id`,`brand_id`,`asset_id`) REFERENCES `assets`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `fk_asset_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collections` ADD CONSTRAINT `fk_collection_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `upload_intents` ADD CONSTRAINT `fk_upload_intent_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_rights` ADD CONSTRAINT `fk_usage_rights_asset` FOREIGN KEY (`tenant_id`,`brand_id`,`asset_id`) REFERENCES `assets`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `creative_documents` ADD CONSTRAINT `fk_creative_doc_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `creative_revisions` ADD CONSTRAINT `fk_rev_document` FOREIGN KEY (`tenant_id`,`brand_id`,`document_id`) REFERENCES `creative_documents`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `element_comments` ADD CONSTRAINT `fk_comment_document` FOREIGN KEY (`tenant_id`,`brand_id`,`document_id`) REFERENCES `creative_documents`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `render_jobs` ADD CONSTRAINT `fk_render_job_revision` FOREIGN KEY (`tenant_id`,`brand_id`,`revision_id`) REFERENCES `creative_revisions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rendered_exports` ADD CONSTRAINT `fk_export_revision` FOREIGN KEY (`tenant_id`,`brand_id`,`revision_id`) REFERENCES `creative_revisions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `template_versions` ADD CONSTRAINT `fk_template_version_template` FOREIGN KEY (`tenant_id`,`brand_id`,`template_id`) REFERENCES `templates`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `templates` ADD CONSTRAINT `fk_template_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `briefs` ADD CONSTRAINT `fk_brief_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `campaigns` ADD CONSTRAINT `fk_campaign_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `channel_variants` ADD CONSTRAINT `fk_variant_revision` FOREIGN KEY (`tenant_id`,`brand_id`,`content_revision_id`) REFERENCES `content_revisions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_packages` ADD CONSTRAINT `fk_package_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_revisions` ADD CONSTRAINT `fk_content_rev_package` FOREIGN KEY (`tenant_id`,`brand_id`,`package_id`) REFERENCES `content_packages`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `creative_attributes` ADD CONSTRAINT `fk_creative_attr_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publishing_mandates` ADD CONSTRAINT `fk_mandate_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `release_approvals` ADD CONSTRAINT `fk_approval_revision` FOREIGN KEY (`tenant_id`,`brand_id`,`content_revision_id`) REFERENCES `content_revisions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `review_decisions` ADD CONSTRAINT `fk_review_decision_request` FOREIGN KEY (`tenant_id`,`brand_id`,`review_request_id`) REFERENCES `review_requests`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `review_requests` ADD CONSTRAINT `fk_review_request_revision` FOREIGN KEY (`tenant_id`,`brand_id`,`content_revision_id`) REFERENCES `content_revisions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD CONSTRAINT `fk_agent_run_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `channel_connections` ADD CONSTRAINT `fk_channel_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `channel_connections` ADD CONSTRAINT `fk_channel_credential` FOREIGN KEY (`tenant_id`,`credential_ref_id`) REFERENCES `credential_refs`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publication_attempts` ADD CONSTRAINT `fk_attempt_publication` FOREIGN KEY (`tenant_id`,`publication_id`) REFERENCES `publications`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publications` ADD CONSTRAINT `fk_publication_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publications` ADD CONSTRAINT `fk_publication_channel` FOREIGN KEY (`tenant_id`,`brand_id`,`channel_connection_id`) REFERENCES `channel_connections`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversions` ADD CONSTRAINT `fk_conversion_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD CONSTRAINT `fk_snapshot_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tracked_links` ADD CONSTRAINT `fk_tracked_link_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `anomalies` ADD CONSTRAINT `fk_anomaly_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer_voice_clusters` ADD CONSTRAINT `fk_voice_cluster_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `insights` ADD CONSTRAINT `fk_insight_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learning_records` ADD CONSTRAINT `fk_learning_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `listening_sources` ADD CONSTRAINT `fk_listening_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `playbook_entries` ADD CONSTRAINT `fk_playbook_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `recommendations` ADD CONSTRAINT `fk_recommendation_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `experiment_variants` ADD CONSTRAINT `fk_experiment_variant_experiment` FOREIGN KEY (`tenant_id`,`brand_id`,`experiment_id`) REFERENCES `experiments`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `experiments` ADD CONSTRAINT `fk_experiment_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `fk_conversation_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `fk_message_conversation` FOREIGN KEY (`tenant_id`,`brand_id`,`conversation_id`) REFERENCES `conversations`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `entitlements` ADD CONSTRAINT `fk_entitlement_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `spend_limits` ADD CONSTRAINT `fk_spend_limit_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `fk_subscription_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_api_client_prefix` ON `api_clients` (`key_prefix`);--> statement-breakpoint
CREATE INDEX `ix_reviewer_link_request` ON `external_reviewer_links` (`tenant_id`,`review_request_id`);--> statement-breakpoint
CREATE INDEX `ix_membership_user` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_session_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_support_session_tenant` ON `support_sessions` (`tenant_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `ix_fact_state` ON `approved_facts` (`tenant_id`,`brand_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_asset_derivative_version` ON `asset_derivatives` (`tenant_id`,`asset_version_id`,`purpose`);--> statement-breakpoint
CREATE INDEX `ix_asset_version_hash` ON `asset_versions` (`tenant_id`,`brand_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `ix_asset_state` ON `assets` (`tenant_id`,`brand_id`,`state`,`kind`);--> statement-breakpoint
CREATE INDEX `ix_upload_intent_state` ON `upload_intents` (`tenant_id`,`brand_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_comment_document` ON `element_comments` (`tenant_id`,`document_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_render_job_revision` ON `render_jobs` (`tenant_id`,`revision_id`);--> statement-breakpoint
CREATE INDEX `ix_export_revision` ON `rendered_exports` (`tenant_id`,`revision_id`,`format_key`);--> statement-breakpoint
CREATE INDEX `ix_creative_attr_revision` ON `creative_attributes` (`tenant_id`,`content_revision_id`);--> statement-breakpoint
CREATE INDEX `ix_creative_attr_variant` ON `creative_attributes` (`tenant_id`,`channel_variant_id`);--> statement-breakpoint
CREATE INDEX `ix_approval_revision` ON `release_approvals` (`tenant_id`,`content_revision_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_review_decision_request` ON `review_decisions` (`tenant_id`,`review_request_id`);--> statement-breakpoint
CREATE INDEX `ix_review_request_revision` ON `review_requests` (`tenant_id`,`content_revision_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_eval_result_version` ON `evaluation_results` (`skill_version_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_eval_suite_version` ON `evaluation_suites` (`skill_version_id`);--> statement-breakpoint
CREATE INDEX `ix_skill_binding_task` ON `skill_bindings` (`tenant_id`,`brand_id`,`task_kind`,`priority`);--> statement-breakpoint
CREATE INDEX `ix_skill_version_state` ON `skill_versions` (`skill_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_agent_run_state` ON `agent_runs` (`tenant_id`,`brand_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_tool_invocation_run` ON `tool_invocations` (`tenant_id`,`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_attempt_publication` ON `publication_attempts` (`tenant_id`,`publication_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `ix_publication_due` ON `publications` (`state`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `ix_publication_brand_state` ON `publications` (`tenant_id`,`brand_id`,`state`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `ix_remote_evidence_publication` ON `remote_evidence` (`tenant_id`,`publication_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `ix_link_click_link` ON `link_clicks` (`tenant_id`,`tracked_link_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_snapshot_subject` ON `metric_snapshots` (`tenant_id`,`brand_id`,`subject_type`,`subject_id`,`metric_key`,`fetched_at`);--> statement-breakpoint
CREATE INDEX `ix_snapshot_window` ON `metric_snapshots` (`tenant_id`,`brand_id`,`metric_key`,`window_start`);--> statement-breakpoint
CREATE INDEX `ix_tracked_link_publication` ON `tracked_links` (`tenant_id`,`publication_id`);--> statement-breakpoint
CREATE INDEX `ix_anomaly_state` ON `anomalies` (`tenant_id`,`brand_id`,`state`,`detected_at`);--> statement-breakpoint
CREATE INDEX `ix_voice_cluster_brand` ON `customer_voice_clusters` (`tenant_id`,`brand_id`,`kind`,`size`);--> statement-breakpoint
CREATE INDEX `ix_insight_period` ON `insights` (`tenant_id`,`brand_id`,`period_end`);--> statement-breakpoint
CREATE INDEX `ix_playbook_state` ON `playbook_entries` (`tenant_id`,`brand_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_recommendation_state` ON `recommendations` (`tenant_id`,`brand_id`,`state`,`rank`);--> statement-breakpoint
CREATE INDEX `ix_experiment_result` ON `experiment_results` (`tenant_id`,`experiment_id`,`computed_at`);--> statement-breakpoint
CREATE INDEX `ix_experiment_state` ON `experiments` (`tenant_id`,`brand_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_assignment_user` ON `community_assignments` (`tenant_id`,`assigned_to_user_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_message_brand_time` ON `messages` (`tenant_id`,`brand_id`,`remote_created_at`);--> statement-breakpoint
CREATE INDEX `ix_response_draft_conversation` ON `response_drafts` (`tenant_id`,`conversation_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_budget_reservation_period` ON `budget_reservations` (`tenant_id`,`brand_id`,`period_key`,`state`);--> statement-breakpoint
CREATE INDEX `ix_budget_reservation_day` ON `budget_reservations` (`tenant_id`,`brand_id`,`day_key`,`state`);--> statement-breakpoint
CREATE INDEX `ix_usage_period` ON `usage_ledger` (`tenant_id`,`brand_id`,`period_key`,`kind`);--> statement-breakpoint
CREATE INDEX `ix_audit_resource` ON `audit_events` (`tenant_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_actor` ON `audit_events` (`tenant_id`,`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_deletion_state` ON `deletion_requests` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_idempotency_expiry` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE INDEX `ix_incident_state` ON `incidents` (`tenant_id`,`state`);--> statement-breakpoint
CREATE INDEX `ix_outbox_ready` ON `outbox_events` (`dispatched_at`,`available_at`);--> statement-breakpoint
CREATE INDEX `ix_outbox_claim` ON `outbox_events` (`claimed_by`,`dispatched_at`);