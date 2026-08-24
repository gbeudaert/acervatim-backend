/*
  Warnings:

  - You are about to drop the column `collection_id` on the `collection_shares` table. All the data in the column will be lost.
  - You are about to drop the column `scope` on the `collection_shares` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE `collection_shares` DROP FOREIGN KEY `collection_shares_collection_id_fkey`;

-- DropIndex
DROP INDEX `collection_shares_collection_id_idx` ON `collection_shares`;

-- AlterTable
ALTER TABLE `collection_share_members` ADD COLUMN `label` VARCHAR(200) NULL;

-- AlterTable
ALTER TABLE `collection_shares` DROP COLUMN `collection_id`,
    DROP COLUMN `scope`,
    ADD COLUMN `label` VARCHAR(200) NULL;

-- CreateTable
CREATE TABLE `collection_share_entries` (
    `share_id` CHAR(36) NOT NULL,
    `collection_id` CHAR(36) NOT NULL,
    `statuses` JSON NOT NULL,

    INDEX `collection_share_entries_collection_id_idx`(`collection_id`),
    PRIMARY KEY (`share_id`, `collection_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `collection_shares` ADD CONSTRAINT `collection_shares_owner_user_id_fkey` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_share_entries` ADD CONSTRAINT `collection_share_entries_share_id_fkey` FOREIGN KEY (`share_id`) REFERENCES `collection_shares`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_share_entries` ADD CONSTRAINT `collection_share_entries_collection_id_fkey` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
