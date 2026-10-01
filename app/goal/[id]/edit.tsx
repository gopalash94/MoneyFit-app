/**
 * Edit a goal — `Finance/src/app/goals/[id]/edit/page.tsx`. Forty-one lines there, and
 * the same three substitutions `app/bill/[id]/edit.tsx` sets out at length: the read
 * becomes `useLive` + `Screen`, `notFound()` becomes a `{ goal: null }` loader result
 * and a `<NotFound/>` render, and the action's redirect becomes `onDone`.
 *
 * `replace` rather than `back()` for the same reason the bill editor gives — and here
 * there is a second reason on top of it. This screen is reachable from the goal's own
 * page *and* from the Goals list, and popping the second lands you on a list rather
 * than the goal you just renamed.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";

import { GoalForm } from "@/components/GoalForm";
import { Screen } from "@/components/Screen";
import { NotFound, PageHead } from "@/components/ui";
import { saveGoal } from "@/lib/actions/goals";
import { today } from "@/lib/date";
import { useLive } from "@/lib/live";
import { getGoal } from "@/lib/queries/goals";
import type { GoalRow } from "@/lib/types";

async function load(n: number): Promise<{ goal: GoalRow | null }> {
  if (!Number.isInteger(n) || n <= 0) return { goal: null };
  return { goal: await getGoal(n) };
}

export default function EditGoalScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const n = Number(typeof params.id === "string" ? params.id : "");
  const live = useLive(() => load(n), [n]);

  return (
    <>
      <Stack.Screen options={{ title: "Edit goal" }} />
      <Screen live={live}>
        {({ goal }) =>
          goal ? (
            <>
              <PageHead title="Edit goal" sub={goal.name} />
              <GoalForm
                action={(prev, fd) => saveGoal(goal.id, prev, fd)}
                goal={goal}
                today={today()}
                onDone={(state) => {
                  if (state?.savedId === undefined) return;
                  router.replace({ pathname: "/goal/[id]", params: { id: String(state.savedId) } });
                }}
              />
            </>
          ) : (
            <NotFound
              what="goal"
              onBack={() => {
                if (router.canGoBack()) router.back();
                else router.replace("/goals");
              }}
            />
          )
        }
      </Screen>
    </>
  );
}
