/**
 * The "what is it worth now" form — `Finance/src/components/ValuationForm.tsx`.
 *
 * Deliberately separate from `ContributionForm` rather than a mode of it, and the
 * reason is worth repeating here because the two files look almost identical and the
 * temptation to merge them will come back. A contribution and a valuation have the
 * same shape — an amount and a date — and opposite meanings. Sharing one form would
 * invite entering a ₹5,000 SIP into the field that means "this fund is now worth
 * ₹5,000", which silently destroys every return figure on the page: the cost basis
 * would be right, the value would be wrong by an order of magnitude, and XIRR would
 * report a catastrophic loss with no indication anything had been mistyped.
 *
 * Two changes from the web, both consequences of `<Form>`:
 *
 * **The reset is a remount.** On the web this kept a `ref` to the `<form>` element
 * and called `ref.current?.reset()` on the falling edge of `pending` — the DOM
 * knowing how to clear itself. `<Form>` has no `reset()` and should not grow one:
 * its fields are uncontrolled and own their own text, so the honest way to clear
 * them is to build new ones. `onDone` bumps `gen`, `gen` is the `<Form>`'s key, and
 * React discards the subtree. That is safe by construction — `<Form>` publishes
 * itself into the module context during *render* and its cleanup only clears that
 * context if it is still the one holding it, so the new form is already current by
 * the time the old one tears down.
 *
 * The web's comment about *when* to clear still applies, and the mechanism above
 * preserves it: `onDone` is called on success only. Clearing on submit instead would
 * throw away an amount the server had just rejected, which is the one moment the
 * text is most worth keeping.
 *
 * **The footer is `FormActions`.** `.row-between` with an empty `<span />` on the
 * left pushed the button right; `FormActions` already justifies to the end, so the
 * spacer has nothing left to do.
 */

import { useState } from "react";

import { AmountInput, DateField, Field, Form, FormActions, FormGrid, Submit } from "./form";
import type { FormState } from "@/lib/actions/shared";
import type { FormData } from "@/lib/form-data";

export function ValuationForm({
  action,
  today,
  label = "Value",
  hint,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  today: string;
  /** "Value" for a holding, "Outstanding" for a liability. */
  label?: string;
  hint?: string;
}) {
  // Bumped on every successful save; it is the form's key, so the fields are new.
  const [gen, setGen] = useState(0);

  return (
    <Form key={gen} action={action} onDone={() => setGen((g) => g + 1)}>
      {({ err }) => (
        <>
          <FormGrid>
            <Field label={label} name="value" error={err.value} hint={hint}>
              <AmountInput name="value" />
            </Field>

            <Field
              label="As of"
              name="as_of"
              error={err.as_of}
              hint="One value per day — re-entering today's corrects it"
            >
              <DateField name="as_of" defaultValue={today} />
            </Field>
          </FormGrid>

          <FormActions>
            <Submit>Record value</Submit>
          </FormActions>
        </>
      )}
    </Form>
  );
}
