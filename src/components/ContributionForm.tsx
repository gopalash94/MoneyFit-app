/**
 * The inline "put money in" form — `Finance/src/components/ContributionForm.tsx`.
 *
 * Shared by a goal and a holding, and it stays on the screen rather than navigating
 * away, because logging three months of back-dated contributions in a row is the
 * normal way this gets used and a redirect after each one would be hostile. Both of
 * its actions already return `null` on success for exactly that reason.
 *
 * Three changes from the web:
 *
 * **The reset is a remount**, as in `ValuationForm` — `onDone` bumps `gen` and `gen`
 * is the `<Form>`'s key. The web's version kept a `ref` to the `<form>`, watched the
 * falling edge of `pending` and called `ref.current?.reset()`; the note it left about
 * *when* to clear still holds and the mechanism keeps it, since `onDone` runs on
 * success only. Clearing on submit instead would throw away an amount the server had
 * just rejected.
 *
 * **The withdrawal switch is its own row.** On the web it sat in a `.row-between`
 * with the submit button, a checkbox on the left and "Add" on the right. A labelled
 * switch and a button do not share a phone's width comfortably, and `CheckField` is
 * built to fill a row — label left, control right, the whole thing tappable — so it
 * goes above the actions instead. Same name, same `"on"` value, same `bool()` read.
 *
 * **`withdrawLabel` decides whether it appears at all**, unchanged: a goal and a
 * holding can both go down, and the screens that pass no label are the ones where
 * money only goes one way.
 */

import { useState } from "react";

import {
  AmountInput,
  CheckField,
  DateField,
  Field,
  Form,
  FormActions,
  FormGrid,
  Submit,
  TextField,
} from "./form";
import type { FormState } from "@/lib/actions/shared";
import type { FormData } from "@/lib/form-data";

export function ContributionForm({
  action,
  today,
  verb = "Add",
  withdrawLabel,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  today: string;
  /** "Add" for a goal, "Record" for a holding. */
  verb?: string;
  /** Label for the negative-amount switch. Omitted for things that only go up. */
  withdrawLabel?: string;
}) {
  const [gen, setGen] = useState(0);

  return (
    <Form key={gen} action={action} onDone={() => setGen((g) => g + 1)}>
      {({ err }) => (
        <>
          <FormGrid>
            <Field label="Amount" name="amount" error={err.amount}>
              {/* No `name` — `AmountInput` defaults to "amount", as on the web. */}
              <AmountInput />
            </Field>

            <Field label="Date" name="txn_date" error={err.txn_date}>
              <DateField name="txn_date" defaultValue={today} />
            </Field>

            <Field label="Note" name="note" error={err.note} span>
              <TextField
                name="note"
                placeholder="Optional — where it came from, or which fund it went into"
                maxLength={500}
              />
            </Field>
          </FormGrid>

          {withdrawLabel ? (
            <CheckField
              name="withdraw"
              label={withdrawLabel}
              hint="Records it as a negative amount, so the totals and the pace line both know."
            />
          ) : null}

          <FormActions>
            <Submit>{verb}</Submit>
          </FormActions>
        </>
      )}
    </Form>
  );
}
