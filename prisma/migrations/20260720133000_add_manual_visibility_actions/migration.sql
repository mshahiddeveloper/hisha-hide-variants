-- Preserve existing manual rules as HIDE rules while adding explicit SHOW overrides.
ALTER TABLE "ManualVisibilityOverride"
ADD COLUMN "visibilityAction" TEXT NOT NULL DEFAULT 'HIDE';
