-- DropForeignKey
-- L'ancien index unique (user_id, source, source_id) sert d'index support à la FK
-- items_user_id_fkey ; il faut donc lâcher la FK avant de pouvoir le supprimer.
ALTER TABLE `items` DROP FOREIGN KEY `items_user_id_fkey`;

-- DropIndex
DROP INDEX `items_user_id_source_source_id_key` ON `items`;

-- AlterTable
ALTER TABLE `items` DROP COLUMN `raw_data`,
    DROP COLUMN `source`,
    DROP COLUMN `source_id`,
    ADD COLUMN `node_id` CHAR(36) NULL,
    ADD COLUMN `sources` JSON NOT NULL,
    ADD COLUMN `volume` INTEGER NULL;

-- CreateTable
CREATE TABLE `collection_nodes` (
    `id` CHAR(36) NOT NULL,
    `collection_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `parent_id` CHAR(36) NULL,
    `level` VARCHAR(32) NOT NULL,
    `unified_data` JSON NOT NULL,
    `sources` JSON NOT NULL,
    `user_data` JSON NOT NULL,
    `is_wishlist` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `collection_nodes_collection_id_level_idx`(`collection_id`, `level`),
    INDEX `collection_nodes_parent_id_idx`(`parent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `items_node_id_idx` ON `items`(`node_id`);

-- CreateIndex
CREATE UNIQUE INDEX `items_user_id_node_id_volume_key` ON `items`(`user_id`, `node_id`, `volume`);

-- AddForeignKey
-- Recrée la FK user_id (désormais supportée par le préfixe user_id du nouvel index unique).
ALTER TABLE `items` ADD CONSTRAINT `items_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_node_id_fkey` FOREIGN KEY (`node_id`) REFERENCES `collection_nodes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_nodes` ADD CONSTRAINT `collection_nodes_collection_id_fkey` FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_nodes` ADD CONSTRAINT `collection_nodes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `collection_nodes` ADD CONSTRAINT `collection_nodes_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `collection_nodes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
