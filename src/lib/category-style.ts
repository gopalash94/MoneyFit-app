/**
 * The icons and colours a category may be given.
 *
 * Pure, so the Settings picker (a client component) and the server can share one
 * list. The icons here are real `PATHS` keys only — `catIcon()` will resolve the
 * aliases the seed uses, but offering an alias in a picker means offering
 * something whose name does not match what gets drawn.
 *
 * The colours are the ones `db/020_seed.sql` already assigns, deduplicated and
 * ordered by hue. A palette rather than a colour input on purpose: two categories
 * three hex digits apart are indistinguishable in a donut chart, and the donut is
 * the point of giving them colours at all.
 */

import type { IconName } from "@/components/Icon";

export const CATEGORY_ICONS: readonly IconName[] = [
  "receipt", "home", "cart", "bolt", "droplet", "flame", "wifi", "phone",
  "car", "fuel", "utensils", "repeat", "heart", "shield", "book", "bag",
  "film", "plane", "wrench", "gift", "bank", "percent", "coins", "wallet",
  "undo", "tag", "clock", "search", "target", "sparkle",
];

export const CATEGORY_COLORS: readonly string[] = [
  "#1A73E8", "#1967D2", "#3F51B5", "#039BE5", "#12B5CB", "#00897B",
  "#1E8E3E", "#0B8043", "#F9AB00", "#E8710A", "#FF7043", "#D93025",
  "#EA4335", "#C5221F", "#F06292", "#AB47BC", "#9334E6", "#7B1FA2",
  "#795548", "#455A64", "#5F6368", "#80868B",
];

/** Anything the picker did not offer falls back rather than reaching the table. */
export function safeColor(value: string): string {
  return /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : "#80868B";
}
