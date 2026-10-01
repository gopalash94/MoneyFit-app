import type { IconName } from "@/components/Icon";

/**
 * Goal and holding icons come out of the database as free text, so a hand-edited
 * row must not render a blank square.
 *
 * Deliberately not `catIcon()`: that falls back to the lined-receipt glyph, which
 * is right for a spending category and wrong for a goal. The schema default is
 * `flag`, which has no glyph of its own, so the fallback here is the one that
 * actually gets used most.
 */
const GOAL_ICONS = new Set<string>([
  "target", "shield", "home", "car", "plane", "book",
  "heart", "gift", "bag", "coins", "bank", "phone",
  "wallet", "flame", "percent",
]);

export function goalIcon(name: string | null | undefined): IconName {
  if (name && GOAL_ICONS.has(name)) return name as IconName;
  return "target";
}
