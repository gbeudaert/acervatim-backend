-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `google_sub_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_google_sub_hash_key`(`google_sub_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collections` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `type_id` CHAR(36) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `item_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `collections_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `collections_type_id_idx`(`type_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_types` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `label` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `collection_types_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `items` (
    `id` CHAR(36) NOT NULL,
    `collection_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `source_id` VARCHAR(128) NOT NULL,
    `unified_data` JSON NOT NULL,
    `raw_data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `items_collection_id_created_at_idx`(`collection_id`, `created_at`),
    UNIQUE INDEX `items_user_id_source_source_id_key`(`user_id`, `source`, `source_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_credentials` (
    `user_id` CHAR(36) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `access_token_encrypted` TEXT NOT NULL,
    `refresh_token_encrypted` TEXT NULL,
    `expires_at` BIGINT NOT NULL DEFAULT 0,
    `scopes` JSON NOT NULL,
    `encrypted_with_key_version` INTEGER NOT NULL DEFAULT 1,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`user_id`, `provider`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_cache` (
    `cache_key` VARCHAR(255) NOT NULL,
    `payload` JSON NOT NULL,
    `fetched_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `api_cache_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`cache_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rate_limit_buckets` (
    `bucket_key` VARCHAR(255) NOT NULL,
    `tokens` DOUBLE NOT NULL DEFAULT 0,
    `last_refill` BIGINT NOT NULL DEFAULT 0,
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `rate_limit_buckets_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`bucket_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscriptions` (
    `user_id` CHAR(36) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `product_id` VARCHAR(64) NOT NULL,
    `purchase_token` VARCHAR(512) NOT NULL,
    `expires_at` BIGINT NOT NULL,
    `auto_renew` BOOLEAN NOT NULL DEFAULT true,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_verified_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `cancel_reason` VARCHAR(64) NULL,

    UNIQUE INDEX `subscriptions_purchase_token_key`(`purchase_token`),
    INDEX `subscriptions_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `premium_grants` (
    `user_id` CHAR(36) NOT NULL,
    `reason` VARCHAR(32) NOT NULL,
    `granted_by` VARCHAR(64) NULL,
    `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` BIGINT NULL,
    `notes` TEXT NULL,

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `collections` ADD CONSTRAINT `collections_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collections` ADD CONSTRAINT `collections_type_id_fkey` FOREIGN KEY (`type_id`) REFERENCES `collection_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_collection_id_fkey` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `oauth_credentials` ADD CONSTRAINT `oauth_credentials_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `premium_grants` ADD CONSTRAINT `premium_grants_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
