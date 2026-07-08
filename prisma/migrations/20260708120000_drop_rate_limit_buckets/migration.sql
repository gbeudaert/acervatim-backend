-- Retrait des buckets à jetons SQL (`TokenBucketService`), remplacés par les limiters BullMQ
-- (throttle des appels sortants par file — cf. src/oauth/providers/*.processor.ts et
-- src/common/sources/googlebooks/*). Plus aucun code ne lit cette table.

-- DropTable
DROP TABLE `rate_limit_buckets`;
