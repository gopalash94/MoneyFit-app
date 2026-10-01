/**
 * Create or edit a holding — `Finance/src/components/HoldingForm.tsx`.
 *
 * The web marked this `"use client"` for two reasons, and both survive: an asset and a
 * liability do not offer the same types, and the opening position quotes its own
 * implied gain as you type. The second is the one worth the code — "I put in ₹2,00,000
 * and it's worth ₹2,40,000" is a sentence about a percentage, and seeing +20.0% before
 * you save is how you catch having typed one of the two figures into the wrong field.
 *
 * Four changes from the web:
 *
 * **The type grid is `IconPicker`**, which `GoalForm` also uses — it was a hidden
 * input plus a `.pickgrid` written inline in both files. The colour comes from
 * `ASSET_TYPE_COLOR` per option rather than a `--pick` custom property, and the icon
 * from `ASSET_TYPE_ICON`; both maps are unchanged.
 *
 * **Switching side remounts the grid.** `IconPicker` owns its selection, so the web's
 * `if (!list.includes(type)) setType(list[0])` became: keep the selection up here too,
 * correct it when the side changes, and key the grid on `side` so it starts again from
 * the corrected value. The batched pair of `setState` calls means the remount already
 * sees the new type. The server check in `actions/holdings.ts` is still the one that
 * matters — this only stops you reaching for a type that would be rejected.
 *
 * **The gain line is guarded by `parseAmount`**, as on the web, so a half-typed figure
 * quotes nothing rather than a wrong percentage. Nothing else needed adding: both
 * fields go through `parseAmount`, which returns null for anything it cannot read.
 *
 * **Cancel goes back** rather than to `/invest/${holding.id}` or `/invest` — the same
 * destination, one fewer screen in the stack. `GoalForm` explains this at more length.
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
  Segmented,
  Submit,
  TextField,
} from "./form";
import { Banner, Card } from "@/components/ui";
import type { FormState } from "@/lib/actions/shared";
import { ASSET_TYPE_ICON } from "@/lib/asset-icon";
import type { FormData } from "@/lib/form-data";
import { fmtSigned, parseAmount } from "@/lib/money";
import {
  ASSET_TYPE_COLOR,
  ASSET_TYPE_LABEL,
  type AssetType,
  type HoldingRow,
  type Side,
} from "@/lib/types";
import { useStyles, type Theme } from "@/theme/ThemeProvider";
import { weight } from "@/theme/tokens";

const ALL_TYPES = Object.keys(ASSET_TYPE_LABEL) as AssetType[];

/**
 * Kept in step with `LIABILITY_TYPES` in `src/lib/actions/holdings.ts` by hand — the
 * server check is the one that matters, this list only stops you reaching for a type
 * that will be rejected.
 */
const LIABILITY_TYPES: AssetType[] = ["loan", "credit_card", "other"];
const ASSET_TYPES = ALL_TYPES.filter((t) => t !== "loan" && t !== "credit_card");

export function HoldingForm({
  action,
  holding,
  today,
  onDone,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  holding?: HoldingRow | null;
  today: string;
  onDone?: (state: FormState) => void;
}) {
  const s = useStyles(styles);
  const [side, setSide] = useState<Side>(holding?.side ?? "asset");
  const [type, setType] = useState<AssetType>(holding?.asset_type ?? "mutual_fund");
  const [invested, setInvested] = useState("");
  const [worth, setWorth] = useState("");

  // The opening position is a create-time convenience. Editing it later would mean
  // rewriting a contribution and a valuation that may since have others after them,
  // which is what the holding's own page is for.
  const creating = !holding;
  const types = side === "liability" ? LIABILITY_TYPES : ASSET_TYPES;
  const gain = impliedGain(invested, worth);

  function switchSide(next: Side) {
    setSide(next);
    const list = next === "liability" ? LIABILITY_TYPES : ASSET_TYPES;
    if (!list.includes(type)) setType(list[0]);
  }

  async function cancel() {
    if (router.canGoBack()) router.back();
    else router.replace("/invest");
  }

  return (
    <Form action={action} onDone={onDone}>
      {({ err }) => (
        <>
          <Card
            title={side === "liability" ? "The liability" : "The holding"}
            note={
              side === "liability"
                ? "Its latest value is the balance outstanding, so net worth can subtract it."
                : "One row per thing you own. Value it as often as you like."
            }
          >
            <FormGrid>
              <Field label="Asset or liability" name="side" error={err.side} span>
                <Segmented<Side>
                  name="side"
                  defaultValue={side}
                  onChange={switchSide}
                  options={[
                    { value: "asset", label: "Something I own", icon: "invest" },
                    { value: "liability", label: "Something I owe", icon: "receipt" },
                  ]}
                />
              </Field>

              <Field
                label="Name"
                name="name"
                error={err.name}
                hint={
                  side === "liability" ? "“Home loan — HDFC”" : "“Parag Parikh Flexi Cap”"
                }
                span
              >
                <TextField
                  name="name"
                  defaultValue={holding?.name}
                  maxLength={200}
                  autoFocus={creating}
                />
              </Field>

              <Field label="Type" name="asset_type" error={err.asset_type} span>
                <IconPicker<AssetType>
                  key={side}
                  name="asset_type"
                  defaultValue={type}
                  onChange={setType}
                  options={types.map((ty) => ({
                    value: ty,
                    label: ASSET_TYPE_LABEL[ty],
                    icon: ASSET_TYPE_ICON[ty],
                    color: ASSET_TYPE_COLOR[ty],
                  }))}
                />
              </Field>

              <Field
                label="Where it's held"
                name="institution"
                error={err.institution}
                hint="Optional — the broker, bank or fund house"
              >
                <TextField
                  name="institution"
                  defaultValue={holding?.institution}
                  maxLength={200}
                />
              </Field>

              <Field
                label="Units"
                name="units"
                error={err.units}
                hint="Optional note to yourself — grams, shares, fund units. No maths uses it."
              >
                <TextField
                  name="units"
                  defaultValue={holding?.units == null ? null : String(holding.units)}
                  numeric
                  maxLength={40}
                />
              </Field>

              <Field label="Notes" name="notes" error={err.notes} span>
                <TextField
                  name="notes"
                  defaultValue={holding?.notes}
                  placeholder="Folio number, why you bought it, when you plan to sell."
                  maxLength={2000}
                  multiline
                />
              </Field>
            </FormGrid>
          </Card>

          {creating ? (
            <Card
              title={side === "liability" ? "Where it stands today" : "Where you're starting from"}
              note={
                side === "liability"
                  ? "Borrowed, and what is still outstanding."
                  : "Skip it and this holding starts at zero — every return figure on its page stays blank until you come back."
              }
            >
              <FormGrid>
                <Field
                  label={side === "liability" ? "Borrowed" : "Invested so far"}
                  name="opening_amount"
                  error={err.opening_amount}
                  hint="Everything you've put in up to now, as one figure"
                >
                  <AmountInput name="opening_amount" onChange={setInvested} />
                </Field>

                <Field
                  label={side === "liability" ? "Outstanding today" : "Worth today"}
                  name="opening_value"
                  error={err.opening_value}
                  hint="Leave blank and it starts equal to the amount above — no gain claimed"
                >
                  <AmountInput name="opening_value" onChange={setWorth} />
                </Field>

                <Field
                  label="As of"
                  name="opening_date"
                  error={err.opening_date}
                  hint="The date both figures are true on"
                  span
                >
                  <DateField name="opening_date" defaultValue={today} />
                </Field>
              </FormGrid>

              {gain ? (
                <Banner
                  tone={gain.minor < 0 ? "warn" : "info"}
                  icon={gain.minor < 0 ? "arrowDown" : "arrowUp"}
                >
                  That's <Text style={s.strong}>{fmtSigned(gain.minor)}</Text> on what went
                  in — <Text style={s.strong}>
                    {gain.pct > 0 ? "+" : ""}
                    {gain.pct.toFixed(1)}%
                  </Text>
                  {side === "liability" ? " of the original loan still owed." : " so far."}
                </Banner>
              ) : null}
            </Card>
          ) : null}

          <FormActions>
            <ActionButton action={cancel} variant="ghost">
              Cancel
            </ActionButton>
            <Submit>{holding ? "Save changes" : "Add holding"}</Submit>
          </FormActions>
        </>
      )}
    </Form>
  );
}

/** Verbatim from the web. Null unless both figures read as amounts and one went in. */
function impliedGain(invested: string, worth: string): { minor: number; pct: number } | null {
  const inMinor = parseAmount(invested);
  const valMinor = parseAmount(worth);
  if (inMinor === null || valMinor === null || inMinor <= 0) return null;
  return { minor: valMinor - inMinor, pct: ((valMinor - inMinor) / inMinor) * 100 };
}

/** The `<strong>` inside the gain banner — see the note in `GoalForm`. */
const styles = (_t: Theme) => ({
  strong: { fontWeight: weight.semi } as TextStyle,
});
