-- AlterTable
ALTER TABLE `items` ADD COLUMN `user_data` JSON NOT NULL DEFAULT ('{}');
