/**
 * Import a statement — `Finance/src/app/journal/statement/page.tsx`.
 *
 * The upload box, anything still waiting to be reviewed, the twenty most recent
 * uploads, and the card that states the importer's real limits where someone hits them
 * rather than in a README.
 *
 * **The table is a row list.** The web had five columns — File, Rows, Added, State,
 * Size — and React Native has no `<table>`. Each upload keeps all five, folded onto two
 * lines with a hairline between rows: the same substitution `app/(tabs)/track.tsx`
 * documents, and the column headings go with them for the reason it gives there, that a
 * heading exists to explain a bare cell and a labelled line does not need one. That is
 * also why the "Added" cell is no longer an em dash: `—` was legible under a heading
 * reading *Added*, and on its own line it says nothing, so it becomes "nothing added
 * yet" in words.
 *
 * **`batchBillCount` is wired in, which the web never did.** It had the query and used
 * it nowhere. On a phone this list is the only place an import is visible afterwards, and
 * `added_count` is a number frozen at commit time — delete four of those bills from the
 * Journal and the column still says what went in, not what is there. So the live count is
 * read too, and it is *mentioned only when the two disagree*: a batch whose rows are all
 * still present says nothing extra, and one that has been pruned says so rather than
 * leaving you to wonder why the Journal is short.
 *
 * **`?problem=gone` survives the move to return values.** On the web `commitStatement`
 * ended in `redirect("/journal/statement?problem=gone")` when the batch had been deleted
 * under it, and the reasoning in that action's header is worth keeping: a *code* in the
 * URL rather than a message, because a message in a URL is a message an attacker can
 * choose. Here the action returns `{ ok: false, problem: "gone" }` and the review screen
 * navigates here with the same code — which is now not even a message an attacker could
 * choose, since this screen has exactly one word it reacts to and renders its own
 * sentence for it.
 *
 * **No "Journal" button in the header.** The web put a link back to the Journal beside
 * the title; the header's back arrow is that link, and it knows where you actually came
 * from — which here might be the Journal, Home or More. Same decision as
 * `app/bill/[id]/index.tsx`.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { Screen } from "@/components/Screen";
import { StatementUpload } from "@/components/StatementUpload";
import { Banner, Card, Chip, EmptyState, PageHead } from "@/components/ui";
import { uploadStatement } from "@/lib/actions/statement";
import { useLive } from "@/lib/live";
import { batchBillCount, listBatches } from "@/lib/queries/statements";
import { fmtBytes } from "@/lib/upload-meta";
import type { StatementBatch } from "@/lib/types";
import { useStyles, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

type Loaded = {
  batches: StatementBatch[];
  /** Bills still in the journal from each batch, by batch id. See the header. */
  stillHere: Record<number, number>;
};

async function load(): Promise<Loaded> {
  const batches = await listBatches(20);
  // Twenty indexed counts, and the index is the partial one rung 2 added for exactly
  // this. `Promise.all` because expo-sqlite serialises work on a connection itself —
  // the same thing `app/bill/[id]/index.tsx` does with its three reads.
  const counts = await Promise.all(batches.map((b) => batchBillCount(b.id)));
  const stillHere: Record<number, number> = {};
  batches.forEach((b, i) => {
    stillHere[b.id] = counts[i];
  });
  return { batches, stillHere };
}

export default function StatementListScreen() {
  const params = useLocalSearchParams();
  const gone = params.problem === "gone";
  const live = useLive(load, []);

  return (
    <>
      <Stack.Screen options={{ title: "Import a statement" }} />
      <Screen live={live}>{(data) => <List {...data} gone={gone} />}</Screen>
    </>
  );
}

function List({ batches, stillHere, gone }: Loaded & { gone: boolean }) {
  const s = useStyles(styles);
  const router = useRouter();

  const waiting = batches.filter((b) => !b.committed_at);

  return (
    <>
      <PageHead
        title="Import a statement"
        sub="Read a bank statement, categorise every line, and add the ones you want."
      />

      <View style={s.stack}>
        {gone ? (
          <Banner tone="bad" icon="alert">
            That statement was thrown away before its rows could be added, so nothing went in.
            Upload it again if you still want it.
          </Banner>
        ) : null}

        <Card title="Upload">
          <StatementUpload action={uploadStatement} />
        </Card>

        {waiting.length > 0 ? (
          <Banner tone="warn" icon="clock">
            {waiting.length === 1 ? (
              <>
                {/* A nested `<Text onPress>` rather than a `Pressable`: a tappable word
                    inside a sentence has to flow with the sentence, and `Banner` has
                    already put a `<Text>` around its children for exactly this. */}
                <Text
                  style={s.bannerLink}
                  onPress={() =>
                    router.push({
                      pathname: "/statement/[id]",
                      params: { id: String(waiting[0].id) },
                    })
                  }
                >
                  {waiting[0].original_name}
                </Text>
                {` was read but nothing from it has been added yet — ${waiting[0].row_count} row${
                  waiting[0].row_count === 1 ? "" : "s"
                } are waiting for you to review them.`}
              </>
            ) : (
              <>
                {`${waiting.length} statements were read but nothing from them has been added yet. They are marked `}
                <Text style={s.bannerEm}>Needs review</Text>
                {" below."}
              </>
            )}
          </Banner>
        ) : null}

        <Card
          title="Statements you have uploaded"
          note="The file is kept, so a row you do not recognise months later can be traced back to it."
        >
          {batches.length === 0 ? (
            <EmptyState
              icon="file"
              title="Nothing imported yet"
              body="Upload a PDF or CSV above. Nothing is added to your journal until you have seen the rows."
            />
          ) : (
            batches.map((b, i) => (
              <BatchRow key={b.id} batch={b} stillHere={stillHere[b.id] ?? 0} first={i === 0} />
            ))
          )}
        </Card>

        {/*
          The limits, stated where someone hits them rather than in a README. Each of
          these is a deliberate boundary, not a missing feature: a scanned statement
          has no text to read without OCR, and OCR is a different project.
        */}
        <Card title="What this can and cannot read">
          <View style={s.bullets}>
            <Bullet>
              <Text style={s.strong}>CSV and Excel exports import most accurately.</Text>
              {" The columns are already columns, so nothing has to be reconstructed. If your bank offers one, use it — open an "}
              <Text style={s.code}>.xls</Text>
              {" on a computer and save it as CSV first."}
            </Bullet>
            <Bullet>
              <Text style={s.strong}>Text-based PDFs work.</Text>
              {" Every netbanking statement is one. The table is rebuilt from where the words sit on the page."}
            </Bullet>
            <Bullet>
              <Text style={s.strong}>Scanned PDFs and photographs do not.</Text>
              {" A scan is a picture of a page with no text in it, and it is refused rather than half-read — download the statement again from netbanking instead of photographing a printout."}
            </Bullet>
            <Bullet>
              <Text style={s.strong}>Password-protected PDFs work</Text>
              {" if you supply the password. It opens the file and is kept only until the import finishes."}
            </Bullet>
            <Bullet>
              {
                "Nothing is sent anywhere. The file is read on this phone, by this app, with no outbound connection of any kind — importing a statement never uses the network."
              }
            </Bullet>
          </View>
        </Card>
      </View>
    </>
  );
}

/**
 * One upload. All five of the web's columns: the name and the state on the first line,
 * the time, the row count, what went in and the size on the second.
 */
function BatchRow({
  batch: b,
  stillHere,
  first,
}: {
  batch: StatementBatch;
  stillHere: number;
  first: boolean;
}) {
  const s = useStyles(styles);
  const router = useRouter();

  // `2026-02-14T09:31` — the web's `created_at.slice(0, 16).replace("T", " ")`, and the
  // same reason for slicing rather than formatting: the seconds are noise and the date
  // is being used to tell two uploads of the same file apart, not to be read aloud.
  const when = b.created_at.slice(0, 16).replace("T", " ");

  // The web's "Added" column, in words. The second clause appears only when bills from
  // this batch have since been deleted — see the header.
  const added = !b.committed_at
    ? "nothing added yet"
    : stillHere === b.added_count
      ? `${b.added_count} added`
      : `${b.added_count} added, ${stillHere} still here`;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${b.original_name}`}
      onPress={() => router.push({ pathname: "/statement/[id]", params: { id: String(b.id) } })}
      style={({ pressed }) => [s.row, first ? null : s.rowSep, pressed ? s.rowPressed : null]}
    >
      <View style={s.rowBetween}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {b.original_name}
        </Text>
        {b.committed_at ? (
          <Chip tone="good" icon="check">
            Imported
          </Chip>
        ) : (
          <Chip tone="warn" icon="clock">
            Needs review
          </Chip>
        )}
      </View>
      <Text style={s.rowMeta}>
        {`${when} · ${b.row_count} row${
          b.row_count === 1 ? "" : "s"
        } · ${added} · ${fmtBytes(b.size_bytes)}`}
      </Text>
    </Pressable>
  );
}

/** One `<li>` of `.bullets`: the marker, then a line that wraps under itself. */
function Bullet({ children }: { children: React.ReactNode }) {
  const s = useStyles(styles);
  return (
    <View style={s.bullet}>
      <Text style={s.bulletMark}>•</Text>
      <Text style={s.bulletText}>{children}</Text>
    </View>
  );
}

const styles = (t: Theme) => ({
  stack: { gap: space.gap } as ViewStyle,

  /** A tappable word inside a `Banner`'s sentence. Colour only — the weight is the
      banner's, so the word does not shout louder than the sentence around it. */
  bannerLink: { textDecorationLine: "underline" } as TextStyle,
  /** The web's `<em>Needs review</em>`, naming the chip two cards down. */
  bannerEm: { fontStyle: "italic" } as TextStyle,

  // ---------------------------------------------------------- the former table
  // `app/(tabs)/track.tsx`'s row list, unchanged, so every list of rows in the app
  // has the same geometry.
  row: { paddingVertical: 12, paddingHorizontal: 4, borderRadius: radius.sm, gap: 4 } as ViewStyle,
  rowSep: { borderTopWidth: 1, borderTopColor: t.c.borderSoft } as ViewStyle,
  rowPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  } as ViewStyle,
  rowTitle: { ...font.entryTitle, color: t.c.text, flexShrink: 1 } as TextStyle,
  /** `...tnum` because this line is mostly figures — a count, a count and a size. */
  rowMeta: { ...font.small, ...tnum, color: t.c.text3 } as TextStyle,

  // ---------------------------------------------------------------- .bullets
  bullets: { gap: 9 } as ViewStyle,
  bullet: { flexDirection: "row", gap: 8 } as ViewStyle,
  /** The 18px `padding-left` the list had, spent on the marker instead. */
  bulletMark: { ...font.small13, color: t.c.text3, width: 10, lineHeight: 20 } as TextStyle,
  bulletText: { ...font.small13, color: t.c.text2, flex: 1, lineHeight: 20 } as TextStyle,
  /** `.bullets strong` — the text colour and weight 500, not the browser's bold. */
  strong: { color: t.c.text, fontWeight: weight.medium } as TextStyle,
  code: { fontFamily: "monospace", color: t.c.text } as TextStyle,
});
