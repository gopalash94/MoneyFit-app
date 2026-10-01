/**
 * One bill, everything about it — `Finance/src/app/journal/[id]/page.tsx`.
 *
 * Every card the web page had, in the order its own stylesheet stacked them below
 * 860px: the amount with its chips, the six facts, the notes, the attachments, the
 * merchant history and the recurrence chain. Four actions in the header — mark paid or
 * back to upcoming, edit, duplicate, delete.
 *
 * **`notFound()` became a render.** The web's `load()` returned `null` for a missing
 * row and the page threw `notFound()` outside its try. There is nothing to throw to
 * here, so the loader returns `{ bill: null }` — never a bare `null`, which `Screen`
 * cannot tell from "still loading" — and this file renders `<NotFound what="bill" />`.
 * The same branch covers a junk id, which the web handled with the identical check
 * before it ever queried.
 *
 * **The attachment gallery is one column.** `.att-grid` was a wrapping row of 150px
 * previews; at 360dp two of those side by side is a thumbnail of a bill, which is
 * useless for the one thing this screen exists to do. So each attachment is a
 * full-width tile with a 190px preview, and the preview is pressable: images open in
 * whatever the phone uses for images, PDFs in whatever it uses for PDFs, both through
 * `openAttachment` and both still addressed by database row rather than by a path this
 * screen composed. `/api/attachments/[id]` is gone — nothing is served, the file is
 * read from the app's own storage.
 *
 * **`AttachmentsForm` is not a file here.** It existed on the web because
 * `useActionState` is a hook and the page around it was a server component. This page
 * is a component, so the six lines live at the bottom of it.
 *
 * **Two navigations the actions used to do.** `deleteBill` ended in
 * `redirect("/journal")` and `duplicateBill` in `redirect(`/journal/${row.id}/edit`)`;
 * both now return and the `onDone` handlers below navigate. The duplicate `push`es
 * rather than `replace`s, which the web could not do — back from the copy's editor
 * returns you to the bill you copied, which is where you were.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Image, Pressable, Text, View } from "react-native";
import type { ImageStyle, TextStyle, ViewStyle } from "react-native";

import { ActionButton, AttachmentPicker, DangerButton, Form, FormActions, Submit } from "@/components/form";
import { catIcon, Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import {
  Banner, Card, Chip, Dot, EmptyState, IconTile, LinkButton, NotFound, PageHead, StatTile,
} from "@/components/ui";
import {
  addAttachments, deleteAttachment, deleteBill, duplicateBill, markPaid, markUpcoming,
} from "@/lib/actions/bills";
import { fmtDate, fmtDue } from "@/lib/date";
import { attachmentUri, openAttachment } from "@/lib/files";
import { useLive } from "@/lib/live";
import { fmt, fmtSigned, fmtWhole } from "@/lib/money";
import { getAttachments, getBill, listByMerchant, listRelated } from "@/lib/queries/bills";
import { nextOccurrence, RECURRENCE_LABEL } from "@/lib/recurrence";
import { fmtBytes, isImage } from "@/lib/upload-meta";
import type { Attachment, BillRow } from "@/lib/types";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, tnum, weight } from "@/theme/tokens";

type Loaded = {
  /** Null for both "no such row" and "not a valid id" — one branch renders both. */
  bill: BillRow | null;
  attachments: Attachment[];
  related: BillRow[];
  history: BillRow[];
};

const NONE: Loaded = { bill: null, attachments: [], related: [], history: [] };

async function load(n: number): Promise<Loaded> {
  if (!Number.isInteger(n) || n <= 0) return NONE;

  const bill = await getBill(n);
  if (!bill) return NONE;

  const [attachments, related, history] = await Promise.all([
    getAttachments(n),
    // Only a recurring bill, or one that was rolled from another, has a chain.
    bill.recurrence !== "none" || bill.parent_bill_id ? listRelated(bill) : [],
    listByMerchant(bill.merchant, n),
  ]);
  return { bill, attachments, related, history };
}

export default function BillScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const n = Number(typeof params.id === "string" ? params.id : "");
  const live = useLive(() => load(n), [n]);

  function back() {
    if (router.canGoBack()) router.back();
    else router.replace("/journal");
  }

  return (
    <>
      <Stack.Screen options={{ title: live.data?.bill?.merchant ?? "Bill" }} />
      <Screen live={live}>
        {(data) =>
          data.bill ? (
            <Detail bill={data.bill} attachments={data.attachments} related={data.related} history={data.history} />
          ) : (
            <NotFound what="bill" onBack={back} />
          )
        }
      </Screen>
    </>
  );
}

function Detail({ bill, attachments, related, history }: Loaded & { bill: BillRow }) {
  const s = useStyles(styles);
  const router = useRouter();

  const id = bill.id;
  const income = bill.kind === "income";
  const upcoming = bill.status === "upcoming";
  const color = bill.category_color ?? "#80868B";
  const due = bill.due_date ? fmtDue(bill.due_date) : null;
  const day = upcoming && bill.due_date ? bill.due_date : bill.txn_date;

  const parent = related.find((r) => r.id === bill.parent_bill_id) ?? null;
  const children = related.filter((r) => r.id !== bill.parent_bill_id);
  const rolls =
    upcoming && bill.recurrence !== "none"
      ? nextOccurrence(bill.due_date ?? bill.txn_date, bill.recurrence)
      : null;

  return (
    <>
      <PageHead
        title={bill.merchant}
        // The web put a link back to the Journal here. The header's back arrow is
        // that link, and it knows where you actually came from.
        sub={`${bill.category_name ?? "Uncategorised"} · ${fmtDate(day, { year: true })}`}
      >
        {upcoming ? (
          <ActionButton action={() => markPaid(id)} icon="check" variant="solid">
            Mark paid
          </ActionButton>
        ) : (
          <ActionButton action={() => markUpcoming(id)} icon="undo">
            Back to upcoming
          </ActionButton>
        )}

        <LinkButton
          href={{ pathname: "/bill/[id]/edit", params: { id: String(id) } }}
          label="Edit"
          icon="edit"
          variant="outline"
          small
        />

        <ActionButton
          action={() => duplicateBill(id)}
          icon="plus"
          onDone={(newId) => {
            if (newId === null) router.replace("/journal");
            else router.push({ pathname: "/bill/[id]/edit", params: { id: String(newId) } });
          }}
        >
          Duplicate
        </ActionButton>

        <DangerButton
          action={() => deleteBill(id)}
          label="Delete"
          confirm={
            attachments.length
              ? `Delete this bill and its ${attachments.length} attachment${
                  attachments.length === 1 ? "" : "s"
                }? The files are removed from the app’s storage and cannot be recovered.`
              : "Delete this bill? This cannot be undone."
          }
          onDone={() => router.replace("/journal")}
        />
      </PageHead>

      {rolls ? (
        <View style={s.bannerWrap}>
          <Banner tone="info" icon="repeat">
            {`Marking this paid also writes the next ${RECURRENCE_LABEL[
              bill.recurrence
            ].toLowerCase()} occurrence, due ${fmtDate(rolls, { year: true })}.`}
          </Banner>
        </View>
      ) : null}

      <View style={s.stack}>
        <Card>
          <View style={s.heroRow}>
            <IconTile color={color} icon={catIcon(bill.category_icon)} size={52} />
            <View style={s.heroMain}>
              <StatTile
                label={income ? "Received" : upcoming ? "Amount due" : "Paid"}
                value={(income ? "+" : "") + fmt(bill.amount_minor)}
                size="xl"
                tone={income ? "pos" : undefined}
                sub={
                  <View style={s.chipRow}>
                    <Chip tone={upcoming ? "info" : "good"} icon={upcoming ? "clock" : "check"}>
                      {upcoming ? "Upcoming" : "Paid"}
                    </Chip>
                    {upcoming && due ? (
                      <Chip tone={due.overdue ? "bad" : due.soon ? "warn" : "info"}>{due.label}</Chip>
                    ) : null}
                    {bill.recurrence !== "none" ? (
                      <Chip icon="repeat">{RECURRENCE_LABEL[bill.recurrence]}</Chip>
                    ) : null}
                    {bill.source === "ai" ? (
                      <Chip icon="sparkle" title="Fields were read from an upload by Claude">
                        Read from the bill
                      </Chip>
                    ) : null}
                  </View>
                }
              />
            </View>
          </View>

          {/* `.kv` was a two-column grid and stays one — six short facts read better
              paired than as a six-row list. */}
          <View style={s.kvGrid}>
            <Kv k={upcoming ? "Bill date" : income ? "Received on" : "Paid on"}>
              {fmtDate(bill.txn_date, { year: true })}
            </Kv>
            <Kv k="Due on">{bill.due_date ? fmtDate(bill.due_date, { year: true }) : "—"}</Kv>
            <Kv k="Category">
              <View style={s.kvRow}>
                <Dot color={color} />
                <Text style={s.kvText}>{bill.category_name ?? "Uncategorised"}</Text>
              </View>
            </Kv>
            <Kv k="Repeats">{RECURRENCE_LABEL[bill.recurrence]}</Kv>
            <Kv k="Direction">{income ? "Money in" : "Money out"}</Kv>
            <Kv k="Added">
              <Text style={s.kvText}>
                {fmtDate(bill.created_at.slice(0, 10), { year: true })}
                <Text style={s.dim}>{` · ${bill.source === "ai" ? "from an upload" : "typed in"}`}</Text>
              </Text>
            </Kv>
          </View>

          {bill.notes ? (
            <View style={s.notesWrap}>
              <Text style={s.kvK}>Notes</Text>
              <Text style={s.kvText}>{bill.notes}</Text>
            </View>
          ) : null}
        </Card>

        <Card
          title={attachments.length ? `Attachments · ${attachments.length}` : "Attachments"}
          note="Kept in the app’s own storage and opened by row id — never by a path from this screen."
        >
          {attachments.length === 0 ? (
            <EmptyState
              icon="attach"
              title="No file attached"
              body="Add the bill, receipt or statement below and it stays with this entry."
            />
          ) : (
            <View style={s.attList}>
              {attachments.map((a) => (
                <AttachmentTile key={a.id} att={a} />
              ))}
            </View>
          )}

          <View style={attachments.length ? s.attFoot : s.attFootTight}>
            <AttachMore billId={id} />
          </View>
        </Card>

        <MerchantHistory bill={bill} history={history} />

        {parent || children.length > 0 ? (
          <Card title="This recurrence">
            <View style={s.rowList}>
              {parent ? <Occurrence bill={parent} rel="Rolled from" /> : null}
              {children.map((c) => (
                <Occurrence key={c.id} bill={c} rel="Rolled to" />
              ))}
            </View>
          </Card>
        ) : null}
      </View>
    </>
  );
}

// ------------------------------------------------------------------ the pieces

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  const s = useStyles(styles);
  return (
    <View style={s.kvItem}>
      <Text style={s.kvK}>{k}</Text>
      {typeof children === "string" ? <Text style={s.kvText}>{children}</Text> : children}
    </View>
  );
}

function AttachmentTile({ att: a }: { att: Attachment }) {
  const t = useTheme();
  const s = useStyles(styles);

  return (
    <View style={s.att}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${a.original_name}`}
        onPress={() => void openAttachment(a.file_name, a.mime_type)}
        style={({ pressed }) => [s.attPreview, pressed ? s.attPreviewPressed : null]}
      >
        {isImage(a.mime_type) ? (
          <Image
            source={{ uri: attachmentUri(a.file_name) }}
            style={s.attImage}
            resizeMode="cover"
            accessibilityLabel={a.original_name}
          />
        ) : (
          <View style={s.attFile}>
            <Icon name="file" size={30} stroke={1.6} color={t.c.red} />
            <Text style={s.attFileLabel}>{a.mime_type === "application/pdf" ? "PDF" : "File"}</Text>
          </View>
        )}
      </Pressable>

      <View style={s.attRow}>
        <View style={s.attText}>
          <Text style={s.attName} numberOfLines={1}>
            {a.original_name}
          </Text>
          <Text style={s.dim}>{fmtBytes(a.size_bytes)}</Text>
        </View>
        <DangerButton
          action={() => deleteAttachment(a.id)}
          label="Remove"
          confirm={`Remove ${a.original_name}? The file is deleted from the app’s storage.`}
        />
      </View>
    </View>
  );
}

/** The web's `AttachmentsForm`, which only needed its own file to hold a hook. */
function AttachMore({ billId }: { billId: number }) {
  return (
    <Form action={(prev, fd) => addAttachments(billId, prev, fd)}>
      <AttachmentPicker />
      <FormActions>
        <Submit icon="attach">Attach</Submit>
      </FormActions>
    </Form>
  );
}

/**
 * "Is this one normal?" answered with a median rather than a mean — one ₹40,000
 * outlier in a year of ₹800 bills should not move what counts as typical.
 */
function MerchantHistory({ bill, history }: { bill: BillRow; history: BillRow[] }) {
  const s = useStyles(styles);

  if (history.length === 0) {
    return (
      <Card title="At this merchant">
        <Text style={s.dim}>
          {`Nothing else paid to ${bill.merchant} yet. Once there is, this card compares the amount against what you usually pay.`}
        </Text>
      </Card>
    );
  }

  const typical = median(history.map((h) => h.amount_minor));
  const delta = bill.amount_minor - typical;
  // Under 5% of the typical amount is noise, not a change worth a chip.
  const notable = Math.abs(delta) > typical * 0.05;
  const worse = bill.kind === "income" ? delta < 0 : delta > 0;

  return (
    <Card title="At this merchant" note={`Last ${history.length} paid`}>
      <View style={s.typicalRow}>
        <View>
          <Text style={s.kvK}>Usually</Text>
          <Text style={s.kvText}>{fmtWhole(typical)}</Text>
        </View>
        {notable ? (
          <Chip
            tone={worse ? "warn" : "good"}
            icon={delta > 0 ? "arrowUp" : "arrowDown"}
            title="This bill against the median of the ones before it"
          >
            {fmtSigned(delta)}
          </Chip>
        ) : null}
      </View>
      <View style={s.rowList}>
        {history.map((h) => (
          <BillRowLink key={h.id} id={h.id}>
            <Text style={s.muted}>{fmtDate(h.txn_date, { year: true })}</Text>
            <Text style={s.amount}>{fmtWhole(h.amount_minor)}</Text>
          </BillRowLink>
        ))}
      </View>
    </Card>
  );
}

function Occurrence({ bill, rel }: { bill: BillRow; rel: string }) {
  const s = useStyles(styles);
  return (
    <BillRowLink id={bill.id}>
      <Text style={s.muted}>
        <Text style={s.dim}>{`${rel} `}</Text>
        {fmtDate(bill.due_date ?? bill.txn_date, { year: true })}
      </Text>
      <View style={s.chipRowTight}>
        {bill.status === "upcoming" ? <Chip tone="info">upcoming</Chip> : null}
        <Text style={s.amount}>{fmtWhole(bill.amount_minor)}</Text>
      </View>
    </BillRowLink>
  );
}

/**
 * A `.row-between.small` anchor to another bill.
 *
 * `router.push` rather than a `<Link>` so the row itself is the whole target — a
 * 13px line of text is not a tap target, the 44px row around it is.
 */
function BillRowLink({ id, children }: { id: number; children: React.ReactNode }) {
  const s = useStyles(styles);
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push({ pathname: "/bill/[id]", params: { id: String(id) } })}
      style={({ pressed }) => [s.linkRow, pressed ? s.linkRowPressed : null]}
    >
      {children}
    </Pressable>
  );
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const styles = (t: Theme) => ({
  // `.stack > * + * { margin-top: 20px }`.
  stack: { gap: space.gap + 4 } as ViewStyle,
  bannerWrap: { marginBottom: space.gap } as ViewStyle,

  heroRow: { flexDirection: "row", alignItems: "flex-start", gap: space.gap } as ViewStyle,
  heroMain: { flex: 1, minWidth: 0 } as ViewStyle,

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 } as ViewStyle,
  chipRowTight: { flexDirection: "row", alignItems: "center", gap: 8 } as ViewStyle,

  // `.kv` — two columns, 16px apart. 47% twice plus the gap fits 360dp with the
  // page gutter and the card's own padding taken off.
  kvGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: space.gap,
    columnGap: space.gap,
    marginTop: 24,
  } as ViewStyle,
  kvItem: { width: "47%", gap: 3 } as ViewStyle,
  kvRow: { flexDirection: "row", alignItems: "center", gap: 7 } as ViewStyle,
  kvK: { ...font.label, color: t.c.text3 } as TextStyle,
  kvText: { ...font.body, color: t.c.text } as TextStyle,

  notesWrap: { marginTop: 22, gap: 3 } as ViewStyle,

  dim: { ...font.small, color: t.c.text3 } as TextStyle,
  muted: { ...font.small13, color: t.c.text2 } as TextStyle,
  amount: { ...font.small13, ...tnum, color: t.c.text } as TextStyle,

  // ------------------------------------------------------------- attachments
  attList: { gap: space.gapSm + 2 } as ViewStyle,
  attFoot: { marginTop: space.gap } as ViewStyle,
  attFootTight: { marginTop: 8 } as ViewStyle,

  att: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: t.c.borderSoft,
    backgroundColor: t.c.surface2,
    overflow: "hidden",
  } as ViewStyle,
  attPreview: { height: 190, backgroundColor: t.c.surface3 } as ViewStyle,
  attPreviewPressed: { opacity: 0.85 } as ViewStyle,
  // `ViewStyle` is not assignable to `ImageStyle` — `overflow` differs — so anything
  // an `<Image>` wears has to be declared as one.
  attImage: { width: "100%", height: "100%" } as ImageStyle,
  attFile: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 } as ViewStyle,
  attFileLabel: { ...font.label, color: t.c.red } as TextStyle,

  attRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.gapSm,
    paddingVertical: 10,
    paddingHorizontal: 12,
  } as ViewStyle,
  attText: { flex: 1, minWidth: 0, gap: 2 } as ViewStyle,
  attName: { ...font.small13, fontWeight: weight.medium, color: t.c.text } as TextStyle,

  // ---------------------------------------------------------------- the lists
  typicalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  } as ViewStyle,
  rowList: { gap: 2 } as ViewStyle,
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.gapSm,
    minHeight: 44,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
  } as ViewStyle,
  linkRowPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
});
