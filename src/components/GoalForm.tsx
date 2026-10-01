/**
 * Create or edit a goal — `Finance/src/components/GoalForm.tsx`.
 *
 * The web marked this `"use client"` "for one reason worth the JavaScript: it quotes
 * the straight-line monthly contribution as you type". Every component is a client
 * component here, so that reason is free — but it is still the only thing in the file
 * that needs state, and it is worth keeping for the same reason it was worth shipping
 * JavaScript for: "₹50,000 by December" means nothing until you see it is ₹4,200 a
 * month, and that is the number the pace chip will hold you to afterwards.
 *
 * Four changes from the web:
 *
 * **The icon grid and the colour swatches are components.** Both were written inline
 * as a hidden input plus a `.pickgrid` / row of `.swatch` buttons, and `HoldingForm`
 * had a second copy of each. `IconPicker` and `SwatchPicker` in `form.tsx` are those
 * two, with the same markup and the same submitted values.
 *
 * **The chips are tinted through a prop, not a custom property.** `style={{ "--pick":
 * color }}` set a CSS variable the `.pick` rule read; React Native has no custom
 * properties, so the colour is passed down as `tint` and `SwatchPicker` reports
 * changes through `onChange` so it stays in step.
 *
 * **`straightLine` validates its dates.** On the web both were `<input type="date">`,
 * so a non-empty value was always a real date. Here `DateField` is a text field, and
 * a half-typed "2027-1" would have reached `daysBetween`, produced `NaN` days, and
 * quoted "₹NaN a month" — so the shape is checked before the arithmetic. Everything
 * else in the function is unchanged, including `30.44` days to the month.
 *
 * **Cancel goes back rather than to a URL.** The web linked to `/goals/${goal.id}` or
 * `/goals`; `router.back()` lands on whichever of those the person actually came
 * from, which is the same place in both cases and one fewer screen in the stack.
 */

import { useState } from "react";
import { Text } from "react-native";
import type { TextStyle } from "react-native";
import { router } from "expo-router";

import {
  ActionButton,
  AmountInput,
  DateField,
  Field,
  Form,
  FormActions,
  FormGrid,
  IconPicker,
  Submit,
  SwatchPicker,
  TextField,
} from "./form";
import type { IconName } from "@/components/Icon";
import { Banner, Card } from "@/components/ui";
import type { FormState } from "@/lib/actions/shared";
import { daysBetween, fmtDate } from "@/lib/date";
import type { FormData } from "@/lib/form-data";
import { fmt, parseAmount } from "@/lib/money";
import type { GoalRow } from "@/lib/types";
import { useStyles, type Theme } from "@/theme/ThemeProvider";
import { weight } from "@/theme/tokens";

/**
 * `date.ts` is one of the files copied from the web byte for byte, so the shape check
 * lives here rather than being exported from it. `actions/shared.ts` keeps its own
 * private copy for the same reason.
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The twelve that cover almost every goal anyone writes down. Kept in step with
 * `goalIcon()` in `src/lib/goal-icon.ts`, which is the read side — it accepts a few
 * more names (a flame, a percent) that are not offered here, and falls back to the
 * target for the schema's `'flag'` default.
 */
const ICONS: { value: IconName; label: string; icon: IconName }[] = [
  { value: "target", label: "Target", icon: "target" },
  { value: "shield", label: "Safety net", icon: "shield" },
  { value: "home", label: "Home", icon: "home" },
  { value: "car", label: "Vehicle", icon: "car" },
  { value: "plane", label: "Travel", icon: "plane" },
  { value: "book", label: "Education", icon: "book" },
  { value: "heart", label: "Health", icon: "heart" },
  { value: "gift", label: "Gift", icon: "gift" },
  { value: "bag", label: "Purchase", icon: "bag" },
  { value: "coins", label: "Savings", icon: "coins" },
  { value: "bank", label: "Deposit", icon: "bank" },
  { value: "phone", label: "Gadget", icon: "phone" },
];

const COLORS = ["#0f9d58", "#1a73e8", "#f9ab00", "#d93025",
                "#9334e6", "#00897b", "#e8388a", "#3f51b5"];

export function GoalForm({
  action,
  goal,
  today,
  onDone,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  goal?: GoalRow | null;
  today: string;
  onDone?: (state: FormState) => void;
}) {
  const s = useStyles(styles);
  // Seeded once. `SwatchPicker` owns the value from here on and tells us about it;
  // this copy exists only to tint the icon chips.
  const [color, setColor] = useState(goal?.color ?? COLORS[0]);
  const [target, setTarget] = useState(goal ? String(goal.target_minor / 100) : "");
  const [start, setStart] = useState(goal?.started_on ?? today);
  const [deadline, setDeadline] = useState(goal?.target_date ?? "");

  const perMonth = straightLine(target, start, deadline);

  async function cancel() {
    if (router.canGoBack()) router.back();
    else router.replace("/goals");
  }

  return (
    <Form action={action} onDone={onDone}>
      {({ err }) => (
        <>
          <Card title="The goal">
            <FormGrid>
              <Field label="What you're saving for" name="name" error={err.name} span>
                <TextField
                  name="name"
                  defaultValue={goal?.name}
                  placeholder="Emergency fund"
                  maxLength={200}
                  autoFocus={!goal}
                />
              </Field>

              <Field
                label="Target amount"
                name="target"
                error={err.target}
                hint="Shorthand works: 50k, 2.5L, 1cr"
              >
                <AmountInput
                  name="target"
                  defaultMinor={goal?.target_minor}
                  onChange={setTarget}
                />
              </Field>

              <Field
                label="Started on"
                name="started_on"
                error={err.started_on}
                hint="Backdate it if you've been saving for a while — the pace line starts here"
              >
                <DateField
                  name="started_on"
                  defaultValue={goal?.started_on ?? today}
                  onChange={setStart}
                />
              </Field>

              <Field
                label="Target date"
                name="target_date"
                error={err.target_date}
                hint="Optional. Without one there's progress but no pace."
              >
                <DateField
                  name="target_date"
                  defaultValue={goal?.target_date}
                  onChange={setDeadline}
                />
              </Field>

              <Field label="Icon" name="icon" error={err.icon} span>
                <IconPicker
                  name="icon"
                  options={ICONS}
                  defaultValue={pickIcon(goal?.icon)}
                  tint={color}
                />
              </Field>

              <Field
                label="Colour"
                name="color"
                error={err.color}
                hint="Used for this goal's ring, bar and dot"
                span
              >
                <SwatchPicker
                  name="color"
                  colors={COLORS}
                  defaultValue={goal?.color ?? COLORS[0]}
                  onChange={setColor}
                />
              </Field>

              <Field label="Notes" name="notes" error={err.notes} span>
                <TextField
                  name="notes"
                  defaultValue={goal?.notes}
                  placeholder="Why this goal, where the money sits, anything you'll want to remember."
                  maxLength={2000}
                  multiline
                />
              </Field>
            </FormGrid>
          </Card>

          {perMonth !== null ? (
            <Banner tone="info" icon="target">
              A straight line from {fmtDate(start)} to {fmtDate(deadline)} is{" "}
              <Text style={s.strong}>{fmt(perMonth)} a month</Text>. That's the line the
              pace chip measures you against.
            </Banner>
          ) : null}

          <FormActions>
            <ActionButton action={cancel} variant="ghost">
              Cancel
            </ActionButton>
            <Submit>{goal ? "Save changes" : "Add goal"}</Submit>
          </FormActions>
        </>
      )}
    </Form>
  );
}

/** The schema's default is `'flag'`, which is not on offer — so it lands on Target. */
function pickIcon(name: string | null | undefined): IconName {
  const found = ICONS.find((i) => i.value === name);
  return found ? found.value : "target";
}

/**
 * What it takes per month to arrive on time, in a straight line.
 *
 * Verbatim from the web apart from the two date checks — see the header. `30.44` is
 * the average month, so "three months" is not quietly thirteen weeks.
 */
function straightLine(target: string, start: string, deadline: string): number | null {
  if (!ISO.test(start) || !ISO.test(deadline)) return null;
  const minor = parseAmount(target);
  if (minor === null || minor <= 0) return null;
  const days = daysBetween(start, deadline);
  if (!Number.isFinite(days) || days <= 0) return null;
  return Math.ceil(minor / (days / 30.44));
}

/**
 * One style, for the `<strong>` inside the pace banner. `Banner` puts its children in
 * a single `<Text>`, and a nested `<Text>` inherits everything it does not override —
 * which is how one word comes out heavier without restating the colour or the size.
 */
const styles = (_t: Theme) => ({
  strong: { fontWeight: weight.semi } as TextStyle,
});
