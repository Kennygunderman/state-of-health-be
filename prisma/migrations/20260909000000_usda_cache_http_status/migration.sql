-- Retrieval evidence: record the upstream HTTP status of a cached USDA response.
--
-- Review finding OBSEV-F12 (retrieval http_status null everywhere): the status
-- of a USDA exchange was observed by `usda.service.ts` and then discarded,
-- because `usda_api_cache` had no column able to hold it. Every identity
-- evidence record the catalog import wrote therefore had to invent one, so all
-- published validation records carry a null or a hardcoded 200 where Agent
-- Action Plan §0.3.2 requires the observed upstream status.
--
-- The column is NULLABLE with no default and no backfill. Rows written before
-- it existed carry no observed status, and stamping them 200 would manufacture
-- exactly the evidence this column exists to record — so they keep NULL, which
-- reads as "this recorded response predates the status ledger".
--
-- `usda_api_cache` is created by 20260706000000_init, which is why this is its
-- own migration rather than an edit to the meal-planning one.

-- AlterTable
ALTER TABLE "usda_api_cache" ADD COLUMN "http_status" INTEGER;
