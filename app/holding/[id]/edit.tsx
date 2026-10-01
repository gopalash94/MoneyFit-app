/**
 * Edit a holding — `Finance/src/app/invest/[id]/edit/page.tsx`. The goal editor beside
 * it explains the substitutions; they are identical.
 *
 * The web left a comment here worth keeping: there is **no opening-position block on
 * edit**. `HoldingForm` decides that itself from whether it was given a holding, and
 * the reason is that the opening figures are not fields on the row — they became a
 * contribution and a valuation, which by now may have others after them. Editing them
 * is editing those rows, on the holding's own page.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";

import { HoldingForm } from "@/components/HoldingForm";
import { Screen } from "@/components/Screen";
import { NotFound, PageHead } from "@/components/ui";
import { saveHolding } from "@/lib/actions/holdings";
import { today } from "@/lib/date";
import { useLive } from "@/lib/live";
import { getHolding } from "@/lib/queries/holdings";
import type { HoldingRow } from "@/lib/types";

async function load(n: number): Promise<{ holding: HoldingRow | null }> {
  if (!Number.isInteger(n) || n <= 0) return { holding: null };
  return { holding: await getHolding(n) };
}

export default function EditHoldingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const n = Number(typeof params.id === "string" ? params.id : "");
  const live = useLive(() => load(n), [n]);

  return (
    <>
      <Stack.Screen options={{ title: "Edit holding" }} />
      <Screen live={live}>
        {({ holding }) =>
          holding ? (
            <>
              <PageHead title="Edit holding" sub={holding.name} />
              <HoldingForm
                action={(prev, fd) => saveHolding(holding.id, prev, fd)}
                holding={holding}
                today={today()}
                onDone={(state) => {
                  if (state?.savedId === undefined) return;
                  router.replace({
                    pathname: "/holding/[id]",
                    params: { id: String(state.savedId) },
                  });
                }}
              />
            </>
          ) : (
            <NotFound
              what="holding"
              onBack={() => {
                if (router.canGoBack()) router.back();
                else router.replace("/invest");
              }}
            />
          )
        }
      </Screen>
    </>
  );
}
