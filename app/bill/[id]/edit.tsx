/**
 * Edit a bill — `Finance/src/app/journal/[id]/edit/page.tsx`, which was thirty lines and
 * is still about thirty. It loads the row and the categories, and hands both to the same
 * `BillForm` the new-bill screen uses.
 *
 * Three substitutions, all of them the standard ones: the two awaits become `useLive` +
 * `Screen`, `notFound()` becomes a `{ bill: null }` loader result and a `<NotFound/>`
 * render, and the action's `redirect(`/journal/${n}`)` becomes the `onDone` below.
 *
 * **Why `replace` and not `back()`.** Popping the editor would also work in the common
 * case — you came from the bill, the bill is still underneath, and `refreshAll()` has
 * already bumped the live version so it re-reads the row you just saved. But this screen
 * has a second entry point: "Duplicate" on the detail screen pushes the *copy's* editor,
 * and popping that lands you on the original with no sign of the copy. `replace` puts you
 * on the bill you actually saved from both directions, which is what the web did. The
 * cost is one redundant stack entry when you edited the bill you came from — back shows
 * that bill once more before the Journal.
 *
 * `getCategories()` excludes archived ones, exactly as on the web: editing an old bill
 * filed under a category you have since archived will not offer that category back.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";

import { BillForm } from "@/components/BillForm";
import { Screen } from "@/components/Screen";
import { NotFound, PageHead } from "@/components/ui";
import { saveBill } from "@/lib/actions/bills";
import { today } from "@/lib/date";
import { useLive } from "@/lib/live";
import { getBill, getCategories } from "@/lib/queries/bills";
import { listPaymentAccounts } from "@/lib/queries/holdings";
import type { BillRow, Category, PaymentAccount } from "@/lib/types";

type Loaded = { bill: BillRow | null; categories: Category[]; accounts: PaymentAccount[] };

async function load(n: number): Promise<Loaded> {
  if (!Number.isInteger(n) || n <= 0) return { bill: null, categories: [], accounts: [] };
  const [bill, categories, accounts] = await Promise.all([
    getBill(n),
    getCategories(),
    listPaymentAccounts(),
  ]);
  return { bill, categories, accounts };
}

export default function EditBillScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const n = Number(typeof params.id === "string" ? params.id : "");
  const live = useLive(() => load(n), [n]);

  return (
    <>
      <Stack.Screen options={{ title: "Edit bill" }} />
      <Screen live={live}>
        {({ bill, categories, accounts }) =>
          bill ? (
            <>
              <PageHead title="Edit bill" sub={bill.merchant} />
              <BillForm
                action={(prev, fd) => saveBill(n, prev, fd)}
                categories={categories}
                accounts={accounts}
                bill={bill}
                today={today()}
                onDone={(state) => {
                  if (state?.savedId === undefined) return;
                  router.replace({ pathname: "/bill/[id]", params: { id: String(state.savedId) } });
                }}
              />
            </>
          ) : (
            <NotFound
              what="bill"
              onBack={() => {
                if (router.canGoBack()) router.back();
                else router.replace("/journal");
              }}
            />
          )
        }
      </Screen>
    </>
  );
}
