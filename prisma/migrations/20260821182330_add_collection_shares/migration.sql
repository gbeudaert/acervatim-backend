-- CreateTable
CREATE TABLE `collection_shares` (
    `id` CHAR(36) NOT NULL,
    `collection_id` CHAR(36) NOT NULL,
    `owner_user_id` CHAR(36) NOT NULL,
    `code_hash` CHAR(64) NOT NULL,
    `scope` VARCHAR(16) NOT NULL,
    `max_uses` INTEGER NOT NULL DEFAULT 1,
    `used_count` INTEGER NOT NULL DEFAULT 0,
    `expires_at` BIGINT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `collection_shares_code_hash_key`(`code_hash`),
    INDEX `collection_shares_collection_id_idx`(`collection_id`),
    INDEX `collection_shares_owner_user_id_idx`(`owner_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_share_members` (
    `share_id` CHAR(36) NOT NULL,
    `member_user_id` CHAR(36) NOT NULL,
    `redeemed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_at` DATETIME(3) NULL,

    INDEX `collection_share_members_member_user_id_idx`(`member_user_id`),
    PRIMARY KEY (`share_id`, `member_user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `collection_shares` ADD CONSTRAINT `collection_shares_collection_id_fkey` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_share_members` ADD CONSTRAINT `collection_share_members_share_id_fkey` FOREIGN KEY (`share_id`) REFERENCES `collection_shares`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_share_members` ADD CONSTRAINT `collection_share_members_member_user_id_fkey` FOREIGN KEY (`member_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
