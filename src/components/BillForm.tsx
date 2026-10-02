/**
 * The one form that matters — `Finance/src/components/BillForm.tsx`.
 *
 * Everything the web component did, it still does: three ways in (a fresh bill, an
 * existing row, a scan), the category tiles filtered by expense-vs-income, the due
 * date appearing only for a bill that has not been paid, the scan's confidence chip
 * and its "check the amount before saving" warning, and the already-uploaded file
 * shown as a row you cannot remove because it is not yours to remove yet.
 *
 * Four things changed, and they are all the same change: there is no `<form>`
 * element, so everything that element used to provide now comes from `<Form>`.
 *
 * **The action is called the same way.** `useActionState(action, null)` became
 * `<Form action={action}>`, which holds the same `(prev, fd) => Promise<FormState>`
 * and hands the field errors back through its render prop. The `state?.error` banner
 * is gone from here because `<Form>` renders it itself — see its header.
 *
 * **Navigation is the screen's.** The web's action ended in `redirect()` and never
 * returned. Here a successful save returns `{ savedId }`, so `onDone` is a prop and
 * `app/bill/new.tsx` and `app/bill/[id]/edit.tsx` decide where to go. This file names
 * no route at all — "Cancel" is `router.back()`, which is what Cancel means on a
 * phone and which is correct for both callers without either of them saying so.
 *
 * **`discard` is an `ActionButton`.** On the web it had to be `formAction={discard}`
 * with `formNoValidate`, because `ActionButton` rendered its own `<form>` and a form
 * inside a form is not a thing. Neither problem exists here: `ActionButton` is a
 * button, and there is no browser validation to opt out of — the fields are validated
 * by the action, and `discard` never reaches it. Whatever navigation throwing the scan
 * away should cause belongs inside the function the screen passes.
 *
 * **`<select>` became `<Select>`** and the two `<input>`s became `<TextField>`s. Same
 * names, same `maxLength`s, same placeholders.
 */

import { useState } from "react";
import { Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import { useRouter } from "expo-router";

import {
  AccountSelect,
  ActionButton,
  AmountInput,
  AttachmentPicker,
  CategoryPicker,
  DateField,
  Field,
  Form,
  FormActions,
  FormGrid,
  Hidden,
  Segmented,
  Select,
  Submit,
  TextField,
} from "./form";
import { Banner, Card, Chip, IconTile } from "./ui";
import { RECURRENCE_LABEL, type Recurrence } from "@/lib/recurrence";
import { fmtBytes } from "@/lib/upload-meta";
import type { FormState } from "@/lib/actions/shared";
// Ours, not the global — the same rule every module touching a `FormData` follows.
// Type-only here, which is all this file needs: it never constructs one.
import type { FormData } from "@/lib/form-data";
// Type-only on the web so the queries module never entered the browser bundle. There
// is no bundle split here, but the import stays type-only because that is all it is.
import type { ScanDraft } from "@/lib/queries/scan";
import type { BillRow, BillStatus, Category, Kind, PaymentAccount } from "@/lib/types";
import { useStyles, type Theme } from "@/theme/ThemeProvider";
import { font, radius, weight } from "@/theme/tokens";

const RECURRENCES: Recurrence[] = ["none", "weekly", "monthly", "quarterly", "yearly"];

/** What both an existing bill and a scanned draft can supply. */
type Defaults = {
  merchant: string;
  amount_minor: number;
  txn_date: string;
  due_date: string | null;
  status: BillStatus;
  kind: Kind;
  category_id: number | null;
  notes: string | null;
  recurrence: Recurrence;
  /** Optional so a caller with only the bill's own fields still satisfies the type. */
  holding_id?: number | null;
};

const CONFIDENCE: Record<ScanDraft["confidence"], { tone: "good" | "warn" | "bad"; label: string }> = {
  high: { tone: "good", label: "Read cleanly" },
  medium: { tone: "warn", label: "Partly inferred" },
  low: { tone: "bad", label: "Hard to read" },
};

export function BillForm({
  action,
  categories,
  accounts = [],
  bill,
  scan,
  discard,
  today,
  onDone,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  categories: Category[];
  /** Cards, wallets and loans this can be tagged to. Empty is a valid state. */
  accounts?: PaymentAccount[];
  /** Absent when creating. */
  bill?: BillRow | null;
  /** A draft read off a photo or PDF, waiting to be confirmed. */
  scan?: ScanDraft | null;
  /**
   * Bound to the scan's stored name — throws the upload away instead of saving.
   * Navigation afterwards belongs to the screen that supplies this.
   */
  discard?: () => Promise<void>;
  /**
   * Passed in rather than computed here, so the default date matches the one the
   * action would fall back to. `date.ts`'s `today()` is local-time explicit, so both
   * ends now agree by construction rather than by luck.
   */
  today: string;
  /**
   * Called with the returned state once the save succeeds — `{ savedId }` on create.
   * This is what `redirect()` used to do at the end of the action.
   */
  onDone?: (state: FormState) => void;
}) {
  const s = useStyles(styles);
  const router = useRouter();

  // `bill` wins: there is no route where both arrive, and if there ever is, the
  // saved row is the one with an id to update.
  const pre: Defaults | null = bill ?? scan?.values ?? null;

  const [kind, setKind] = useState<Kind>(pre?.kind ?? "expense");
  const [status, setStatus] = useState<BillStatus>(pre?.status ?? "paid");

  /** Back to wherever this was opened from; the Journal if it was opened cold. */
  async function cancel() {
    if (router.canGoBack()) router.back();
    else router.replace("/journal");
  }

  return (
    <Form action={action} onDone={onDone}>
      {({ err }) => (
        <>
          {scan ? (
            <>
              {/* The action reads the file's identity back out of its own record, so
                  this is a pointer, not the metadata itself — editing it can only
                  point at a scan that does not exist. */}
              <Hidden name="scan" value={scan.file.file_name} />
              <Banner tone={CONFIDENCE[scan.confidence].tone} icon="sparkle">
                {`Filled in from ${scan.file.original_name}. Check the amount and the date before saving — nothing is stored until you press Add.${
                  scan.caveat ? ` ${scan.caveat}` : ""
                }`}
              </Banner>
            </>
          ) : null}

          <Card
            title={kind === "income" ? "Money in" : "Money out"}
            action={
              scan ? (
                <Chip tone={CONFIDENCE[scan.confidence].tone}>{CONFIDENCE[scan.confidence].label}</Chip>
              ) : undefined
            }
          >
            <FormGrid>
              <Field label="Amount" name="amount" error={err.amount} hint="Shorthand works: 45k, 1.2L, 2cr">
                <AmountInput defaultMinor={pre?.amount_minor} autoFocus={!bill} />
              </Field>

              <Field label="Direction">
                <Segmented<Kind>
                  name="kind"
                  defaultValue={kind}
                  onChange={setKind}
                  options={[
                    { value: "expense", label: "Expense", icon: "arrowUp" },
                    { value: "income", label: "Income", icon: "arrowDown" },
                  ]}
                />
              </Field>

              <Field
                label={kind === "income" ? "From" : "Paid to"}
                name="merchant"
                error={err.merchant}
                hint={kind === "income" ? "Employer, client, source" : "Shop, biller or person"}
              >
                {/* `required` is gone with the browser that enforced it; `reqText`
                    already returns "Merchant is required." for an empty field, and
                    that message lands in `err.merchant` above. */}
                <TextField
                  name="merchant"
                  defaultValue={pre?.merchant ?? ""}
                  placeholder={kind === "income" ? "Salary" : "Airtel"}
                  maxLength={200}
                  autoCapitalize="words"
                />
              </Field>

              <Field label="State">
                <Segmented<BillStatus>
                  name="status"
                  defaultValue={status}
                  onChange={setStatus}
                  options={[
                    { value: "paid", label: "Already paid", icon: "check" },
                    { value: "upcoming", label: "Due later", icon: "clock" },
                  ]}
                />
              </Field>

              <Field
                label={status === "paid" ? (kind === "income" ? "Received on" : "Paid on") : "Bill date"}
                name="txn_date"
                error={err.txn_date}
              >
                <DateField name="txn_date" defaultValue={pre?.txn_date ?? today} />
              </Field>

              {status === "upcoming" ? (
                <Field
                  label="Due on"
                  name="due_date"
                  error={err.due_date}
                  hint="Leave blank to use the bill date"
                >
                  <DateField name="due_date" defaultValue={pre?.due_date ?? ""} />
                </Field>
              ) : (
                // Keeps a due date that already exists when a paid bill is edited,
                // rather than silently clearing history the field no longer shows.
                <Hidden name="due_date" value={pre?.due_date ?? ""} />
              )}

              <Field label="Category" name="category_id" error={err.category_id} span>
                <CategoryPicker categories={categories} defaultId={pre?.category_id} kind={kind} />
              </Field>

              <Field label="Repeats" name="recurrence" hint="A recurring bill rolls forward when you mark it paid">
                <Select<Recurrence>
                  name="recurrence"
                  label="Repeats"
                  defaultValue={pre?.recurrence ?? "none"}
                  options={RECURRENCES.map((r) => ({ value: r, label: RECURRENCE_LABEL[r] }))}
                />
              </Field>

              <Field
                label="Paid from"
                name="holding_id"
                hint="Optional — lets Ask answer “how much went on this card”"
              >
                <AccountSelect accounts={accounts} defaultId={pre?.holding_id} />
              </Field>

              <Field label="Notes" name="notes" span>
                <TextField
                  name="notes"
                  multiline
                  defaultValue={pre?.notes ?? ""}
                  placeholder="Anything you'll want to search for later — invoice number, what it was for."
                  maxLength={2000}
                />
              </Field>
            </FormGrid>
          </Card>

          <Card
            title={scan ? "The scanned bill" : bill ? "Attach more" : "The bill itself"}
            note="Stored in the app's own storage — nothing is uploaded anywhere else."
          >
            {scan ? (
              <View style={s.entry}>
                <IconTile
                  color="#1a73e8"
                  icon={scan.file.mime_type === "application/pdf" ? "file" : "image"}
                />
                <View style={s.entryMain}>
                  <Text style={s.strong}>{scan.file.original_name}</Text>
                  <Text style={s.dim}>
                    {`${fmtBytes(scan.file.size_bytes)} — already uploaded, attaches when you save`}
                  </Text>
                </View>
              </View>
            ) : null}
            <AttachmentPicker />
          </Card>

          <FormActions>
            {scan && discard ? (
              <ActionButton action={discard} variant="ghost" icon="trash">
                Discard scan
              </ActionButton>
            ) : (
              <ActionButton action={cancel} variant="ghost">
                Cancel
              </ActionButton>
            )}
            <Submit>{bill ? "Save changes" : "Add bill"}</Submit>
          </FormActions>
        </>
      )}
    </Form>
  );
}

const styles = (t: Theme) => ({
  // `.entry` with the web's inline `marginBottom: 14`. No hover state and nothing to
  // press: this row is a statement about a file that is already stored.
  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
    marginBottom: 14,
  } as ViewStyle,
  // `minWidth: 0` is what kept a long filename from pushing the row wide on the web;
  // `flex: 1` does the same job here. Android breaks an over-long unspaced word
  // rather than overflowing, which is what `.wrap-anywhere` was for.
  entryMain: { flex: 1, minWidth: 0, gap: 3 } as ViewStyle,
  strong: { ...font.body, fontWeight: weight.medium, color: t.c.text } as TextStyle,
  dim: { ...font.small, color: t.c.text3 } as TextStyle,
});
