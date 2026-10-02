/**
 * The upload box for a bank statement — `Finance/src/components/StatementUpload.tsx`.
 *
 * Used twice, exactly as on the web — on the importer's own screen and on Home — which
 * is the whole reason it is a component rather than markup inside a screen: the one on
 * Home has to behave identically, including its errors.
 *
 * **It is not a client component here, because nothing is.** The web's file opened with
 * `"use client"` and its header explained why: `useActionState` is how the action
 * reports a file it could not read, and the password field should only appear once it
 * has been asked for. Both reasons survive; neither needs a directive. `<Form>` holds
 * the action's returned state and hands it to a render prop, and `locked` is ordinary
 * component state.
 *
 * **No error banner of our own.** The web rendered `{state?.error && <Banner …>}` as its
 * first child; `<Form>` renders exactly that banner itself, so repeating it here would
 * show every failure twice. Same reasoning as `app/bill/scan.tsx`.
 *
 * **The navigation the action used to do.** `uploadStatement` ended in
 * `redirect(`/journal/statement/${batchId}${existingBatch ? "?seen=1" : ""}`)`; it now
 * returns `{ savedId, seenBefore }` and the `onDone` below is that redirect. It lives in
 * this component rather than in the two screens for the same reason the component
 * exists: Home and the importer must behave identically, and "where you land after a
 * successful read" is part of behaving identically.
 *
 * `push` rather than `replace`, which is the one place this differs from
 * `app/bill/scan.tsx`. A scan draft is consumed by the form it lands on, so returning to
 * the scan screen could only read the file a second time. A statement is not consumed by
 * anything: the file is stored, the batch is recorded, and uploading the same file again
 * finds it by `sha256` and brings you straight back to the same review screen without
 * writing a second copy. So the back gesture returning you to the upload box is correct,
 * and it is also where you came from.
 *
 * **`pdfReaderState()` is read during render, not through `useLive`.** It is
 * synchronous on purpose — the same contract `aiConfigured()` has — and the banner it
 * drives is the difference between learning the PDF reader is unavailable before you
 * pick a file and learning it after a two-minute wait. It is read without subscribing
 * for the reason `app/bill/scan.tsx` gives for `aiConfigured()`: a broken reader is a
 * property of the process (the WebView in `app/_layout.tsx` failed to come up at all),
 * it cannot start working while this screen is on top of the stack, and a fresh push
 * re-evaluates it. `ready` is deliberately not rendered — the reader takes a moment to
 * boot and "not ready yet" is not a problem; `broken` is.
 *
 * **One hole worth naming.** `fromDocument` in `form.tsx` falls back to
 * `mimeType: "application/pdf"` when Android's picker declares no type at all. For a
 * statement that is almost always harmless, because `statementType()` resolves on the
 * file *extension* first and only consults the declared type as a fallback. The single
 * case it gets wrong is a file with no extension and no declared type, which is routed
 * to the PDF reader, where pdf.js refuses it and `translate()` produces "That file is
 * not a readable PDF." A legible failure on a file no bank produces was judged a better
 * trade than another prop.
 */

import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import { useRouter } from "expo-router";

import { AttachmentPicker, Field, Form, FormActions, Submit, TextField } from "./form";
import { Banner } from "./ui";
import type { FormData } from "@/lib/form-data";
import type { FormState } from "@/lib/actions/shared";
import { pdfReaderState } from "@/lib/statement/pdf-bridge";
import { fmtBytes, MAX_UPLOAD_BYTES, STATEMENT_PICKER_TYPES } from "@/lib/upload-meta";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, weight } from "@/theme/tokens";

export function StatementUpload({
  action,
  compact = false,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  /** Home's copy: the same control, without the explanatory paragraph. */
  compact?: boolean;
}) {
  const s = useStyles(styles);
  const router = useRouter();
  const [locked, setLocked] = useState(false);
  const pdf = pdfReaderState();

  return (
    <Form
      action={action}
      onDone={(state) => {
        if (state?.savedId === undefined) return;
        router.push({
          pathname: "/statement/[id]",
          // `seen` is the web's `?seen=1`, and it is only ever this app's own word for
          // "you have uploaded this file before" — the review screen treats it as a
          // hint about the banner to show and nothing more.
          params: state.seenBefore
            ? { id: String(state.savedId), seen: "1" }
            : { id: String(state.savedId) },
        });
      }}
    >
      {({ state }) => {
        // The action says so in words when a PDF turns out to be encrypted; opening the
        // field automatically means the second attempt is one keystroke rather than a
        // hunt for a checkbox.
        const needsPassword = locked || /password/i.test(state?.error ?? "");

        return (
          <>
            {pdf.broken ? (
              <Banner tone="warn" icon="alert">
                {`The PDF reader is not available on this device, so a PDF cannot be read. ${pdf.reason} A CSV or TSV export still imports normally — it is only PDFs that need the reader.`}
              </Banner>
            ) : null}

            {!compact ? (
              <Text style={s.prose}>
                Upload the statement your bank gives you and every transaction in it is read,
                named and sorted into categories, here on this phone. Nothing is added until you
                have seen the rows and ticked the ones you want.{" "}
                <Text style={s.proseStrong}>
                  A CSV or Excel export imports more accurately than a PDF
                </Text>{" "}
                — if your bank offers one, use it.
              </Text>
            ) : null}

            {/* `accept` and `multiple={false}` were the web's two props for "one file,
                of these types"; here that is `docTypes` and `max={1}`. `camera={false}`
                is the web's own word, and `title` has no analogue — it labelled a drop
                zone, and there is nothing to drop a file onto. */}
            <AttachmentPicker
              name="file"
              max={1}
              camera={false}
              docTypes={STATEMENT_PICKER_TYPES}
              docLabel="Choose a file"
              hint={`PDF, CSV or TSV · up to ${fmtBytes(MAX_UPLOAD_BYTES)}`}
            />

            {needsPassword ? (
              <Field
                label="PDF password"
                name="password"
                hint="Most bank statements are locked with your PAN and date of birth. It is used to open the file and kept only until the import is finished."
              >
                <TextField name="password" secure autoCapitalize="none" />
              </Field>
            ) : (
              <GhostButton label="My PDF needs a password" onPress={() => setLocked(true)} />
            )}

            <FormActions>
              <Submit pendingLabel="Reading the statement…">Read the statement</Submit>
            </FormActions>
          </>
        );
      }}
    </Form>
  );
}

/**
 * The web's `<button type="button" className="btn btn-ghost btn-sm">`.
 *
 * Not `ActionButton`, which is the app's small-button component: that one takes a
 * `() => Promise<T>`, holds pending state and shows a spinner, all for an action that
 * here only flips a boolean. The geometry is `form.tsx`'s `btn` + `btnSm` and the colour
 * is its ghost variant's, so it sits beside a `Submit` as the web's did.
 */
function GhostButton({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <View style={s.ghostWrap}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [s.ghost, pressed ? s.ghostPressed : null]}
      >
        <Text style={[s.ghostLabel, { color: t.c.blue }]}>{label}</Text>
      </Pressable>
    </View>
  );
}

const styles = (t: Theme) => ({
  /** `<p className="muted small">` — the explanatory paragraph. */
  prose: { ...font.small13, color: t.c.text2, lineHeight: 20 } as TextStyle,
  /** The `<strong>` inside it. Nested `<Text>` inherits the colour; weight is ours. */
  proseStrong: { fontWeight: weight.semi } as TextStyle,

  /** `alignSelf` on the button itself, so it sizes to its label rather than stretching. */
  ghostWrap: { alignItems: "flex-start" } as ViewStyle,
  ghost: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "transparent",
    // A 32px-tall transparent button is a poor tap target. 44 is the same floor
    // `app/bill/[id]/index.tsx`'s row links use.
    minHeight: 44,
  } as ViewStyle,
  ghostPressed: { opacity: 0.65 } as ViewStyle,
  ghostLabel: { ...font.buttonSm } as TextStyle,
});
