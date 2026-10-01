/**
 * Add a holding — `Finance/src/app/invest/new/page.tsx`. The goals twin of this file
 * explains the three substitutions it shares: no load so `PlainScreen`, the bound
 * action becomes a closure, and `redirect()` becomes `onDone` with `replace`.
 *
 * `today()` is passed in rather than read inside the form for the same reason it was on
 * the web, where the comment said it came from the server "so the opening-position date
 * matches the container's timezone rather than the browser's". On the phone there is
 * only one clock, but the shape is worth keeping: the date a holding starts from is a
 * prop the screen decides, which is what lets the edit screen pass a different one.
 */

import { Stack, useRouter } from "expo-router";

import { HoldingForm } from "@/components/HoldingForm";
import { PlainScreen } from "@/components/Screen";
import { PageHead } from "@/components/ui";
import { saveHolding } from "@/lib/actions/holdings";
import { today } from "@/lib/date";

export default function NewHoldingScreen() {
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: "Add holding" }} />
      <PlainScreen>
        <PageHead title="Add holding" sub="Something you own, or something you owe" />
        <HoldingForm
          action={(prev, fd) => saveHolding(null, prev, fd)}
          today={today()}
          onDone={(state) => {
            if (state?.savedId === undefined) return;
            router.replace({ pathname: "/holding/[id]", params: { id: String(state.savedId) } });
          }}
        />
      </PlainScreen>
    </>
  );
}
