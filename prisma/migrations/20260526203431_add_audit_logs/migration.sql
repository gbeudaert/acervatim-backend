-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NULL,
    `action` VARCHAR(64) NOT NULL,
    `target` VARCHAR(128) NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `audit_logs_action_created_at_idx`(`action`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invitations` (
    `code_hash` CHAR(64) NOT NULL,
    `reason` VARCHAR(32) NOT NULL,
    `grants_premium` BOOLEAN NOT NULL DEFAULT false,
    `premium_expires_at` BIGINT NULL,
    `max_uses` INTEGER NOT NULL DEFAULT 1,
    `used_count` INTEGER NOT NULL DEFAULT 0,
    `expires_at` BIGINT NULL,
    `created_by` VARCHAR(64) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `invitations_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`code_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invitation_redemptions` (
    `invitation_code_hash` CHAR(64) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `redeemed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `invitation_redemptions_user_id_idx`(`user_id`),
    PRIMARY KEY (`invitation_code_hash`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `invitation_redemptions` ADD CONSTRAINT `invitation_redemptions_invitation_code_hash_fkey` FOREIGN KEY (`invitation_code_hash`) REFERENCES `invitations`(`code_hash`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invitation_redemptions` ADD CONSTRAINT `invitation_redemptions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
