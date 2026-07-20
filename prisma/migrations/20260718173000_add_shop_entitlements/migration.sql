-- CreateTable
CREATE TABLE "ShopEntitlement" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "shopGid" TEXT NOT NULL,
    "entitled" BOOLEAN NOT NULL DEFAULT false,
    "billingPeriod" TEXT,
    "trialEndsAt" DATETIME,
    "currentPeriodEndsAt" DATETIME,
    "cancelAtEndOfCycle" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopEntitlement_shopGid_key" ON "ShopEntitlement"("shopGid");
