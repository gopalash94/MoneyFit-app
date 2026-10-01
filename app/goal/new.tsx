/**
 * New goal — `Finance/src/app/goals/new/page.tsx`, which was twenty-seven lines and is
 * about the same here. Nothing to load: the form is blank, so it is `PlainScreen`
 * rather than `Screen` and there is no `DbUnavailable` path to worry about. The first
 * thing that touches the database is the submit, and `<Form>` already renders whatever
 * that throws as a banner.
 *
 * Two substitutions, both of them the standard ones.
 *
 * **`saveGoal.bind(null, null)` becomes a closure.** The web bound the action because a
 * bound Server Action reference is serializable across the client boundary and a plain
 * function is not. There is no boundary here, so `(prev, fd) => saveGoal(null, prev, fd)`
 * says the same thing — `null` for "no id, this is an insert" — and reads better.
 *
 * **`redirect()` becomes `onDone`.** `saveGoal` returns `{ savedId }`; `replace` and not
 * `push`, so the back gesture cannot return you to a form you have already saved. The
 * same reasoning `app/bill/new.tsx` sets out at more length.
 *
 * The web's breadcrumb — a muted "Goals ·" link above the title — is gone, as on every
 * pushed screen: the header's back button is the breadcrumb, and it is a real one.
 */

import { Stack, useRouter } from "expo-router";

import { GoalForm } from "@/components/GoalForm";
import { PlainScreen } from "@/components/Screen";
import { PageHead } from "@/components/ui";
import { saveGoal } from "@/lib/actions/goals";
import { today } from "@/lib/date";

export default function NewGoalScreen() {
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: "New goal" }} />
      <PlainScreen>
        <PageHead title="New goal" sub="Something to save toward" />
        <GoalForm
          action={(prev, fd) => saveGoal(null, prev, fd)}
          today={today()}
          onDone={(state) => {
            if (state?.savedId === undefined) return;
            router.replace({ pathname: "/goal/[id]", params: { id: String(state.savedId) } });
          }}
        />
      </PlainScreen>
    </>
  );
}
