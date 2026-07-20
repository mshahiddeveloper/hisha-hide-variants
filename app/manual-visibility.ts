export const MAX_MANUAL_OVERRIDES_PER_TYPE = 100;

export type ManualVisibilityItem = {
  resourceGid: string;
  legacyResourceId: string;
  visibilityAction: "HIDE" | "SHOW";
  displayName: string;
  productTitle: string | null;
  parentProductGid: string | null;
};
