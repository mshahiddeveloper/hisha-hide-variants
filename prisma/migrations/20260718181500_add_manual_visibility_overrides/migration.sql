-- CreateTable
CREATE TABLE "ManualVisibilityOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceGid" TEXT NOT NULL,
    "legacyResourceId" TEXT NOT NULL,
    "parentProductGid" TEXT,
    "displayName" TEXT NOT NULL,
    "productTitle" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualVisibilityOverride_shop_resourceType_resourceGid_key"
ON "ManualVisibilityOverride"("shop", "resourceType", "resourceGid");

-- CreateIndex
CREATE INDEX "ManualVisibilityOverride_shop_resourceType_idx"
ON "ManualVisibilityOverride"("shop", "resourceType");
