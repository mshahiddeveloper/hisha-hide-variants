import prisma from "../db.server";

export async function deleteShopData(shop: string) {
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { shop } }),
    prisma.shopSettings.deleteMany({ where: { shop } }),
    prisma.shopEntitlement.deleteMany({ where: { shop } }),
    prisma.manualVisibilityOverride.deleteMany({ where: { shop } }),
  ]);
}
