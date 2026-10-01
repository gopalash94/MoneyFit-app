import type { IconName } from "@/components/Icon";
import type { AssetType } from "./types";

/**
 * A glyph per asset type.
 *
 * Pure and client-safe, so the holding form and the server-rendered holdings list
 * read the same table — a fund that shows one icon while you are choosing it and
 * another once saved is a small thing that makes the whole app feel untrustworthy.
 *
 * Every value is a real key of `PATHS` in Icon.tsx, not an `ICON_ALIAS` entry:
 * aliases only resolve through `catIcon()`, and typing one as an `IconName` would
 * render an empty <svg>.
 */
export const ASSET_TYPE_ICON: Record<AssetType, IconName> = {
  equity: "invest",
  mutual_fund: "track",
  ppf: "shield",
  epf: "percent",
  nps: "target",
  fd: "bank",
  gold: "coins",
  real_estate: "home",
  crypto: "bolt",
  bonds: "file",
  cash: "wallet",
  loan: "receipt",
  credit_card: "cart",
  other: "more",
};

/** `asset_type` arrives from the database as free text, so guard the lookup. */
export function assetIcon(type: string | null | undefined): IconName {
  return (type && ASSET_TYPE_ICON[type as AssetType]) || "more";
}
