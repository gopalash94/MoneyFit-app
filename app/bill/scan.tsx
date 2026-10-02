/**
 * Read a bill off a photo or a PDF — `Finance/src/app/journal/scan/page.tsx` plus
 * `Finance/src/components/ScanForm.tsx`.
 *
 * **Two web files, one screen here**, and the merge is not a shortcut. On the web the
 * split was forced: the page is a Server Component because it has to ask the server
 * whether a key is configured, and the form needs `useActionState` and `useFormStatus`,
 * which only exist on the client. There is no such boundary on a phone — the key check
 * is a synchronous function call and `<Form>` hands its pending flag to a render prop —
 * so the two halves become the thing they always were, which is one screen.
 *
 * **The unconfigured branch is a real screen, not a 404.** Its reasoning is the web's,
 * verbatim: the Journal links here, and a dead link is a worse answer than an
 * explanation. So without a key this still renders, says what a key would buy, and
 * points at the form that needs none.
 *
 * **`aiConfigured()` is read directly, not through `useLive`.** Every other screen in
 * the app reads its state through `useLive` so a write anywhere refreshes it; this one
 * has nothing to read from the database at all, and `aiConfigured()` is a synchronous
 * look at the module cache `primeSecrets()` filled at launch. Routing it through
 * `useLive` would mean a `Loading` spinner on first frame in exchange for refreshing a
 * value that cannot change while this screen is on top of the stack — Settings is not
 * reachable from here. A fresh push re-evaluates it, which is the only moment that
 * matters.
 *
 * **The picker asks for `quality: 0.6`, and that number is this screen's whole reason
 * for touching `form.tsx`.** An attachment on an ordinary bill is only ever looked at,
 * so `AttachmentPicker`'s default of 0.8 is right there. A file sent to the Messages API
 * has a second ceiling: 5 MB for a single image, well under this app's own 12 MB upload
 * cap, so a high-megapixel phone photo at 0.8 can be accepted here and then rejected by
 * the API with a 400 that nothing on this screen could explain. `max={1}` is the other
 * half of the same prop: `scanBill` reads `pickedFiles(fd)[0]` and nothing else, so a
 * multi-select would silently discard whatever came after the first file.
 *
 * **The submit button is the shared one.** The web wrote a second button, `ScanSubmit`,
 * because "Saving…" is exactly the wrong promise for a step that saves no bill — that
 * reasoning is kept, and it is why `Submit` grew a `pendingLabel`. The wait is the real
 * design problem here: a thinking model reading a photo takes long enough that a spinner
 * alone reads as a hang, so the button names what it is doing and the closing note says
 * roughly how long.
 *
 * **No error banner of our own.** The web rendered `{state?.error && <Banner …>}` inside
 * the form; `<Form>` renders exactly that banner itself, so repeating it here would show
 * every failure twice.
 */

import { Stack, useRouter } from "expo-router";
import { Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { AttachmentPicker, Form, FormActions, Submit } from "@/components/form";
import { PlainScreen } from "@/components/Screen";
import { AiNotConfigured, Card, LinkButton, PageHead } from "@/components/ui";
import { scanBill } from "@/lib/actions/scan";
import { aiConfigured } from "@/lib/ai/gemini";
import { useStyles, type Theme } from "@/theme/ThemeProvider";
import { font, space } from "@/theme/tokens";

export default function ScanBillScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Scan a bill" }} />
      <PlainScreen>{aiConfigured() ? <Scan /> : <NoKey />}</PlainScreen>
    </>
  );
}

function Scan() {
  const s = useStyles(styles);
  const router = useRouter();

  return (
    <>
      <PageHead
        title="Scan a bill"
        sub="Upload it once. The amount, date, merchant and category come back filled in for you to check."
      />

      <Form
        action={scanBill}
        onDone={(state) => {
          // Assigned to a local before the guard so the narrowing survives into the
          // call below, and because `scan` is the parameter name on the other side.
          const scan = state?.scan;
          if (!scan) return;
          // `replace`, not `push`: the file has been read and the draft is waiting, so
          // coming back here with the back gesture could only read it a second time.
          // The draft is adopted or discarded on the form this lands on.
          router.replace({ pathname: "/bill/new", params: { scan } });
        }}
      >
        {({ err }) => (
          <>
            <Card
              title="The bill"
              note="A photo or a PDF. Kept in this app's own storage; the file is sent to Gemini to be read and nowhere else."
            >
              <AttachmentPicker quality={0.6} max={1} />
              {err.files ? <Text style={s.fieldError}>{err.files}</Text> : null}
            </Card>

            <FormActions>
              <LinkButton href="/bill/new" label="Type it instead" variant="ghost" />
              <Submit icon="sparkle" pendingLabel="Reading the bill…">
                Read this bill
              </Submit>
            </FormActions>

            <Text style={s.note}>
              Reading a bill usually takes ten to thirty seconds. You land on the normal form with
              the fields filled in, and nothing is saved until you press Add there.
            </Text>
          </>
        )}
      </Form>
    </>
  );
}

/**
 * No key — the same two cards the web shows, with the same words.
 *
 * The subtitle differs from the configured branch's on purpose, and it did on the web
 * too: there is nothing to upload yet, so it describes what the feature *is* rather than
 * what to do next.
 */
function NoKey() {
  const s = useStyles(styles);

  return (
    <>
      <PageHead
        title="Scan a bill"
        sub="Read the amount, date and merchant straight off the file."
      />

      <View style={s.stack}>
        <AiNotConfigured feature="Reading bills" />

        <Card title="Until then">
          <Text style={s.prose}>
            The manual form does everything this one does except the typing, and it takes the same
            photo as an attachment — so nothing is unreachable without a key.
          </Text>
          <View style={s.proseAction}>
            <LinkButton href="/bill/new" label="Add a bill by hand" variant="outline" small />
          </View>
        </Card>
      </View>
    </>
  );
}

const styles = (t: Theme) => ({
  /** `Banner` carries no margin of its own, so the gap belongs to the wrapper. */
  stack: { gap: space.gap } as ViewStyle,

  /** `.error` under the picker — the one field `scanBill` names. */
  fieldError: { ...font.small13, color: t.c.red, marginTop: 8 } as TextStyle,

  /** The web's `<p className="small dim" style={{ margin: 0 }}>`. */
  note: { ...font.small, color: t.c.text3, lineHeight: 18 } as TextStyle,

  prose: { ...font.small13, color: t.c.text2, lineHeight: 20 } as TextStyle,
  /** `alignItems` so the button sizes to its label instead of stretching. */
  proseAction: { alignItems: "flex-start", marginTop: 16 } as ViewStyle,
});
