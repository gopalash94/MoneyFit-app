/**
 * Add a bill — `Finance/src/app/journal/new/page.tsx`.
 *
 * Two ways in, exactly as on the web: cold, which is a blank form, or with
 * `?scan=<stored name>`, which is a draft Gemini read off a photo or a PDF waiting to
 * be confirmed. The page itself is thin — it loads the categories and the draft, picks
 * the heading, and hands both to `BillForm`.
 *
 * **The reads.** The web's `try { … } catch { return <DbUnavailable/> }` around two
 * awaits is `useLive` + `Screen`, the same substitution every screen makes. `scan` is
 * in the dependency list so arriving at this route with a different draft re-reads.
 *
 * **Navigation is here rather than in the action.** `saveBill` used to end in
 * `redirect(`/journal/${billId}`)`; now it returns `{ savedId }` and the three
 * `router.replace` calls in this file are what that `redirect` was. `discardScan` lost
 * its `redirect("/journal")` the same way, so the discard closure supplies it.
 *
 * `replace` and not `push` in both cases: a form you have finished with should not be
 * somewhere the back gesture can return you to, half-filled, with the row already
 * saved. That was free on the web, where the redirect replaced the history entry.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";

import { BillForm } from "@/components/BillForm";
import { Screen } from "@/components/Screen";
import { Banner, PageHead } from "@/components/ui";
import { saveBill } from "@/lib/actions/bills";
import { discardScan } from "@/lib/actions/scan";
import { today } from "@/lib/date";
import { useLive } from "@/lib/live";
import { getCategories } from "@/lib/queries/bills";
import { listPaymentAccounts } from "@/lib/queries/holdings";
import { getScanDraft } from "@/lib/queries/scan";

export default function NewBillScreen() {
  const router = useRouter();

  // Read without a generic argument on purpose. Expo's params type is
  // `Record<string, string | string[]>` — a query parameter can legitimately arrive
  // twice — so the narrowing below is the honest way to get `string | undefined`,
  // and it type-checks without asserting a shape the router does not promise.
  const params = useLocalSearchParams();
  const name = typeof params.scan === "string" ? params.scan : undefined;

  const live = useLive(
    async () => ({
      categories: await getCategories(),
      accounts: await listPaymentAccounts(),
      // `getScanDraft` gates the name against `STORED_NAME` itself, so a hand-typed
      // `?scan=%` reads nothing rather than going fishing in the cache table.
      scan: name ? await getScanDraft(name) : null,
    }),
    [name],
  );

  return (
    <>
      <Stack.Screen options={{ title: live.data?.scan ? "Check and save" : "Add bill" }} />
      <Screen live={live}>
        {({ categories, accounts, scan }) => (
          <>
            <PageHead
              title={scan ? "Check and save" : "Add bill"}
              sub={
                scan
                  ? "Read off the file you uploaded. Everything is editable, and nothing is saved yet."
                  : "Attach the bill, or type it in — both paths end in the same row."
              }
            />

            {/* A stale `?scan=` — the draft was saved or discarded, and this is the
                blank form rather than a dead end. Same sentence as the web's. */}
            {name && !scan ? (
              <Banner tone="neutral" icon="info">
                That scan is no longer waiting — it was either saved as a bill already or discarded.
                This is a blank form.
              </Banner>
            ) : null}

            <BillForm
              action={(prev, fd) => saveBill(null, prev, fd)}
              categories={categories}
              accounts={accounts}
              scan={scan}
              discard={
                scan
                  ? async () => {
                      await discardScan(scan.file.file_name);
                      router.replace("/journal");
                    }
                  : undefined
              }
              today={today()}
              onDone={(state) => {
                if (state?.savedId === undefined) return;
                router.replace({ pathname: "/bill/[id]", params: { id: String(state.savedId) } });
              }}
            />
          </>
        )}
      </Screen>
    </>
  );
}
