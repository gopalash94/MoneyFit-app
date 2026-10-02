/**
 * Settings — `Finance/src/app/settings/page.tsx`.
 *
 * Six sections, each its own form with its own save button, for the reason the web
 * page's own header gives: one giant form would mean a typo in the budget field
 * blocks a theme change, and a settings page that refuses to save the thing you
 * touched because of a field you did not is the most annoying kind of form there is.
 *
 * Four things are shaped differently here, and only the third is a loss.
 *
 * **`SettingsForm` moved into this file.** On the web it was its own component under
 * `src/components/` because the page was a Server Component and the wrapper had to be
 * a client one — a boundary, not a design decision. There is no boundary here, and it
 * has exactly one caller, so it lives beside its six uses.
 *
 * **The flat list of field errors is gone, and this is an improvement rather than a
 * cut.** The web wrapper explained why it needed one: "their children are rendered on
 * the server, which means this component cannot reach inside them to place a message
 * under the field it belongs to; so every field error is listed together at the top
 * instead." `Field` here reads `err[name]` out of the form's own context and renders
 * the message under its own input, which is what that note wanted and could not have.
 * The form-level error still appears at the top — `Form` renders that banner itself,
 * which is why this wrapper does not.
 *
 * **The Saved chip clears on the next submit, not on the next keystroke.** The web
 * form carried `onInput`/`onChange` handlers on the `<form>` element and relied on DOM
 * events bubbling up from whichever field you typed in — "any keystroke means the thing
 * on screen is no longer what was saved". React Native has no bubbling and `TextField`
 * reports nothing upward, so the honest equivalent is to clear the chip when the next
 * save starts. A stale "Saved" can therefore sit next to an edited field until you
 * press the button again. Wiring every field to report upward would fix it at the cost
 * of making each one controlled, which is a large change to nine inputs for a chip.
 *
 * **The category-budget cells are left-aligned.** `.input.tnum` with
 * `text-align: right` lined the rupee figures up under each other; RN's `TextInput`
 * has `textAlign` but `TextField` deliberately exposes no style prop, so these are
 * fixed-width boxes with the digits starting at the left. Tabular figures still come
 * from `numeric`. Those rows are also not `Field`s — the label is the category name
 * with its colour dot — so each one renders its own error from the render prop.
 *
 * **The API key card is the one section with no web counterpart at all.** On the web the
 * Gemini key is `GEMINI_API_KEY` in `.env`, read by the server, and never a form
 * field; a phone has no `.env`, so it is typed in here and kept in the device keystore by
 * `lib/secrets.ts`. One property of a keystore shapes the whole card: what goes in cannot
 * be shown again. So the input is empty on every mount, the stored key appears only as
 * `maskApiKey`'s mask in the card's action slot, and removing one is an explicit button
 * rather than an emptied field — `saveAiKey` in `lib/actions/settings.ts` carries the
 * reasoning for why saving a blank is an error instead of a delete.
 *
 * **The Backup card has no web counterpart either, and it is the one section that is not a
 * form.** `FormState` has four fields and none of them is a success message, so a form here
 * could report that an export failed but not that it worked. `ActionButton` and
 * `DangerButton` already hold their own pending state and already render a thrown error as
 * red text under themselves, which leaves only "it worked" to arrange — so the card keeps a
 * line of its own and each button's `onDone` writes it. That also makes the import's two
 * steps honest: the confirmation is asked before the file picker opens, because by the time
 * a file has been chosen the next thing that happens is the database being replaced.
 */

import { Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { CategoriesEditor } from "@/components/CategoriesEditor";
import {
  ActionButton,
  AmountInput,
  DangerButton,
  Field,
  Form,
  FormGrid,
  Segmented,
  Select,
  Submit,
  TextField,
  type FormRender,
} from "@/components/form";
import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import { Banner, Card, Chip, Dot, LinkButton, PageHead, StatTile } from "@/components/ui";
import {
  clearAiKey,
  exportData,
  importData,
  loadSampleData,
  saveAiKey,
  saveCategoryBudgets,
  saveProfile,
  saveTargets,
  wipeEverything,
} from "@/lib/actions/settings";
import { backupSize } from "@/lib/backup";
import { fmtDate } from "@/lib/date";
import { useLive } from "@/lib/live";
import { fmt, toInput } from "@/lib/money";
import { fmtBytes } from "@/lib/upload-meta";
import {
  categoriesForAdmin,
  dataCounts,
  getSettings,
  type CategoryAdmin,
} from "@/lib/queries/settings";
import { getApiKey, maskApiKey } from "@/lib/secrets";
import type { Settings } from "@/lib/types";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, weight } from "@/theme/tokens";

type Counts = Awaited<ReturnType<typeof dataCounts>>;

type Loaded = {
  settings: Settings;
  categories: CategoryAdmin[];
  counts: Counts;
  /**
   * The stored Gemini key, masked — `null` when none is stored.
   *
   * The raw key is read here and discarded in the same expression. Nothing downstream
   * ever holds it: `maskApiKey` returns `AQ.Ab8…a1b2`, which is enough to tell "a key
   * is set" from "the wrong key is set" and useless to anyone reading over your
   * shoulder. Putting the real value in a `defaultValue` would print it into the view
   * tree, which is the one thing this card must not do.
   */
  apiKeyMask: string | null;
  /** How much an export would carry, so the Backup card can say so before you tap. */
  size: Awaited<ReturnType<typeof backupSize>>;
};

async function load(): Promise<Loaded> {
  const [settings, categories, counts, apiKey, size] = await Promise.all([
    getSettings(),
    categoriesForAdmin(),
    dataCounts(),
    getApiKey(),
    backupSize(),
  ]);
  return {
    settings,
    categories,
    counts,
    apiKeyMask: apiKey ? maskApiKey(apiKey) : null,
    size,
  };
}

export default function SettingsScreen() {
  const live = useLive(load);
  return (
    <>
      <Stack.Screen options={{ title: "Settings" }} />
      <Screen live={live}>{(data) => <Inner data={data} />}</Screen>
    </>
  );
}

function Inner({ data }: { data: Loaded }) {
  const s = useStyles(styles);
  const { settings, categories, counts, apiKeyMask, size } = data;

  const empty = counts.bills === 0 && counts.goals === 0 && counts.holdings === 0;

  return (
    <>
      <PageHead
        title="Settings"
        sub="Targets, budgets, categories, the AI key, and the buttons that fill, back up or empty the app."
      />
      <View style={s.stack}>
        <Profile settings={settings} />
        <WelcomeAgain />
        <Targets settings={settings} />
        <CategoryBudgets categories={categories} />
        <Categories categories={categories} />
        <AiKey mask={apiKeyMask} />
        <SampleData empty={empty} counts={counts} />
        <Backup size={size} />
        <DangerZone counts={counts} empty={empty} />
      </View>
    </>
  );
}

// ======================================================== the form wrapper

/**
 * One wrapper for every form on this screen.
 *
 * Settings forms differ from the rest of the app in one way that survives the port:
 * they do not navigate on success, so "it worked" has to be said out loud rather than
 * implied by a new page — hence the Saved chip.
 *
 * `Form` is always handed a function child so a caller's own render prop can be
 * forwarded and a footer appended to it. The hook that clears the chip lives in `Foot`
 * rather than in the render prop, because that prop runs inside `Form`'s render and a
 * hook there would belong to `Form`.
 */
function SettingsForm({
  action,
  children,
  submit = "Save changes",
  saved: savedLabel = "Saved",
  note,
}: {
  action: React.ComponentProps<typeof Form>["action"];
  children: React.ReactNode | ((ctx: FormRender) => React.ReactNode);
  submit?: string;
  saved?: string;
  note?: string;
}) {
  const [saved, setSaved] = useState(false);
  // Stable so `Foot`'s effect does not re-run on every render of this form.
  const clear = useCallback(() => setSaved(false), []);

  return (
    <Form action={action} onDone={() => setSaved(true)}>
      {(ctx) => (
        <>
          {typeof children === "function" ? children(ctx) : children}
          <Foot
            saved={saved}
            savedLabel={savedLabel}
            note={note}
            submit={submit}
            pending={ctx.pending}
            clear={clear}
          />
        </>
      )}
    </Form>
  );
}

function Foot({
  saved,
  savedLabel,
  note,
  submit,
  pending,
  clear,
}: {
  saved: boolean;
  savedLabel: string;
  note?: string;
  submit: string;
  pending: boolean;
  clear: () => void;
}) {
  const s = useStyles(styles);

  // The web cleared this on any keystroke. Here the next save is the signal — see
  // the note in this file's header.
  useEffect(() => {
    if (pending) clear();
  }, [pending, clear]);

  return (
    <View style={s.foot}>
      <View style={s.footLeft}>
        {saved ? (
          <Chip tone="good" icon="check">
            {savedLabel}
          </Chip>
        ) : note ? (
          <Text style={s.footNote}>{note}</Text>
        ) : null}
      </View>
      <Submit>{submit}</Submit>
    </View>
  );
}

// ============================================================ the sections

function Profile({ settings }: { settings: Settings }) {
  return (
    <Card
      title="You & display"
      note="Your name shows on Home and Profile. Nothing leaves this machine."
    >
      <SettingsForm action={saveProfile} submit="Save">
        <FormGrid>
          <Field label="Name" name="display_name" hint="Used in the greeting on Home.">
            <TextField
              name="display_name"
              defaultValue={settings.display_name}
              maxLength={60}
              autoCapitalize="words"
            />
          </Field>

          <Field
            label="Month starts on"
            name="month_start_day"
            hint="Set this to your payday and every month runs payday to payday."
          >
            <Select
              name="month_start_day"
              label="Month starts on"
              defaultValue={String(settings.month_start_day)}
              options={DAYS}
            />
          </Field>

          {/* No `name` here: Field would turn it into the label's own error slot, and
              Segmented is a radiogroup with its own accessibility label rather than
              one focusable input. `saveProfile` reports a theme problem — which it
              cannot have, the value being one of three it chose from — as a
              form-level error, which `Form` renders at the top. */}
          <Field
            label="Theme"
            span
            hint="The button in the header switches between light and dark on the spot. This is the only way back to matching your system."
          >
            {/* `settings.theme` is the literal union in `types.ts`, so this needs no
                cast, and saving bumps the live counter — which re-reads settings in
                the root layout and hands the new preference to ThemeProvider. */}
            <Segmented
              name="theme"
              defaultValue={settings.theme}
              options={[
                { value: "system", label: "Match system", icon: "settings" },
                { value: "light", label: "Light", icon: "sun" },
                { value: "dark", label: "Dark", icon: "moon" },
              ]}
            />
          </Field>
        </FormGrid>
      </SettingsForm>
    </Card>
  );
}

/**
 * The one way back to the greeting, and the reason `app/welcome.tsx` bothers to know
 * whether you have been greeted already.
 *
 * On the web this link lives in a card called **Access**, whose copy is about Docker
 * publishing the port on loopback only — there is no sign-in, and the fact that nobody
 * else on the network can reach the app is a property of how it is run. None of that
 * has a phone analogue: the database is a file in the app's sandbox and the operating
 * system is the access control, so the card is this link and nothing else, with its own
 * note saying what it is for.
 *
 * Label, icon and variant are the web's: *"See the welcome screen"*, `eye`, outline,
 * small. `LinkButton` rather than a `Pressable`, because unlike the button on the screen
 * itself this one only has to navigate — and arriving with something to go back to is
 * what makes the greeting say "Back to the app" instead of "Start exploring".
 */
function WelcomeAgain() {
  return (
    <Card title="Welcome screen" note="The first thing the app shows when you open it.">
      <LinkButton
        href="/welcome"
        label="See the welcome screen"
        icon="eye"
        variant="outline"
        small
      />
    </Card>
  );
}

const ordinal = (n: number) =>
  `${n}${
    n % 10 === 1 && n !== 11
      ? "st"
      : n % 10 === 2 && n !== 12
        ? "nd"
        : n % 10 === 3 && n !== 13
          ? "rd"
          : "th"
  }`;

/**
 * 1–28, because `monthBounds` clamps there and a 29th would skip February.
 * `Select`'s sheet scrolls, so twenty-eight options cost nothing.
 */
const DAYS = Array.from({ length: 28 }, (_, i) => i + 1).map((d) => ({
  value: String(d),
  label: d === 1 ? "1st — the calendar month" : ordinal(d),
}));

function Targets({ settings }: { settings: Settings }) {
  const s = useStyles(styles);

  return (
    <Card title="Monthly targets" note="The three rings on Home are measured against these.">
      <View style={s.stackWide}>
        <Banner tone="info" icon="info">
          The blue ring fills as you spend and the centre shows what is left, so a bigger budget
          makes it move more slowly. The green and amber rings fill toward their targets, where
          full is the good outcome.
        </Banner>

        <SettingsForm action={saveTargets} submit="Save targets">
          <FormGrid>
            <Field
              label="Spending budget"
              name="monthly_budget"
              hint="Also becomes the overall budget on Track."
            >
              <AmountInput name="monthly_budget" defaultMinor={settings.monthly_budget_minor} />
            </Field>

            <Field label="Into goals" name="monthly_goal_target" hint="The green ring.">
              <AmountInput
                name="monthly_goal_target"
                defaultMinor={settings.monthly_goal_target_minor}
              />
            </Field>

            <Field label="Invested" name="monthly_invest_target" hint="The amber ring.">
              <AmountInput
                name="monthly_invest_target"
                defaultMinor={settings.monthly_invest_target_minor}
              />
            </Field>

            {/* Not a Field: there is no input under this label. The figure is the
                *saved* total, as on the web — it moves when you save, not as you
                type, which is the difference between a summary and a calculator. */}
            <View style={s.together}>
              <Text style={s.togetherLabel}>Together</Text>
              <StatTile
                label="Needed each month"
                value={fmt(
                  settings.monthly_budget_minor +
                    settings.monthly_goal_target_minor +
                    settings.monthly_invest_target_minor,
                )}
                size="sm"
                sub="spend + save + invest, as currently set"
              />
            </View>
          </FormGrid>
        </SettingsForm>
      </View>
    </Card>
  );
}

function CategoryBudgets({ categories }: { categories: CategoryAdmin[] }) {
  const s = useStyles(styles);

  // Archived categories are hidden — a budget on something absent from every
  // picker can only ever read 0% — *unless* one already carries a limit. The
  // action saves this table by deleting every category budget and re-inserting
  // what came back, so a row left out of the form is a row deleted on the next
  // save. Showing it is the difference between hiding a number and losing it.
  const rows = categories.filter(
    (c) => c.kind === "expense" && (!c.archived || c.limit_minor !== null),
  );
  const set = rows.filter((c) => c.limit_minor !== null).length;

  return (
    <Card
      title="Category budgets"
      note="Per-category limits, compared against actual spend on Track. Leave one blank for no limit."
      action={
        <Chip tone={set ? "info" : "neutral"}>{`${set} of ${rows.length} set`}</Chip>
      }
    >
      <SettingsForm action={saveCategoryBudgets} submit="Save budgets">
        {({ err }) => (
          <View style={s.budgetList}>
            {rows.map((c) => {
              const name = `budget_${c.id}`;
              const shown = err[name];
              return (
                <View key={c.id} style={s.budgetCell}>
                  <View style={s.budgetRow}>
                    {/* The web's `<th>Category</th>` / `<th>Monthly limit</th>`
                        headings are gone with the table; a colour dot beside a name
                        and a rupee box are already labelled by what they are. */}
                    <View style={s.budgetName}>
                      <Dot color={c.color} />
                      <Text style={s.budgetLabel} numberOfLines={1}>
                        {c.name}
                      </Text>
                      {c.archived ? <Chip tone="neutral">archived</Chip> : null}
                    </View>
                    <View style={s.budgetInput}>
                      <TextField
                        name={name}
                        defaultValue={c.limit_minor === null ? "" : toInput(c.limit_minor)}
                        placeholder="—"
                        numeric
                        maxLength={20}
                      />
                    </View>
                  </View>
                  {/* Not a Field, so nothing else would show this. */}
                  {shown ? <Text style={s.rowError}>{shown}</Text> : null}
                </View>
              );
            })}
          </View>
        )}
      </SettingsForm>
    </Card>
  );
}

function Categories({ categories }: { categories: CategoryAdmin[] }) {
  return (
    <Card
      title="Categories"
      note="Archiving hides a category from the pickers but keeps every bill filed under it."
    >
      {/* One prop. The web passed four bound Server Actions and a hand-narrowed row
          type across the client boundary; there is no boundary, so the editor imports
          its own actions and takes the query rows as they come. */}
      <CategoriesEditor categories={categories} />
    </Card>
  );
}

/**
 * The Gemini key — the only section here with no counterpart on the web.
 *
 * Three things about it follow from the value being a secret in the device keystore
 * rather than a row in `settings`, and all three are visible in the markup:
 *
 * **The input is never pre-filled.** `load()` hands this component a mask and nothing
 * else, so there is no path by which the real key could reach a `defaultValue`, a label
 * or an error message. The mask sits in the card's `action` slot, where the other
 * sections put a count.
 *
 * **An empty field is an error, not a delete.** The box is empty on every mount, so
 * wiring a blank straight through to `saveApiKey` — which treats `""` as "forget it" —
 * would mean a stray tap on Save silently destroys a working key. `saveAiKey` refuses
 * the blank; removing one is the button at the bottom, behind a confirmation.
 *
 * **The submit label changes once a key is stored.** With nothing on screen to edit,
 * "Save" beside a mask reads like it would save the mask; "Replace key" says what
 * pressing it with something pasted actually does.
 *
 * ## What the copy says now, and why it is shorter
 *
 * It used to say *four* features needed a key. Two of them — the monthly insights and
 * the goal coaching — are computed on the device now, by `analytics/narrative.ts` and
 * `analytics/coaching.ts`, so they work with no key and no network and are not mentioned
 * here any more. That leaves two, and this card is where a person decides whether to
 * enable them, so it has to be honest about both of them rather than reassuring:
 *
 * - **Ask** sends the typed question and the *names* of the analytics views. No amount,
 *   date or category total is ever in the request — the model writes a query and SQLite
 *   runs it here.
 * - **Snap a bill** sends the whole photo or PDF, which is the entire point of it and is
 *   also the single largest thing this app ever transmits.
 *
 * The free-tier sentence is not a disclaimer, it is the fact that decides the feature:
 * Google's free tier says the content may be reviewed by people and used to improve
 * their models, and a receipt is not an abstract payload. The paid tier does not. Saying
 * so here is cheaper than a person finding out later.
 */
function AiKey({ mask }: { mask: string | null }) {
  const s = useStyles(styles);

  return (
    <Card
      title="Gemini API key"
      note="Two features use it: asking a question in words, and reading a bill from a photo. Everything else works without one."
      action={
        mask ? (
          <Chip tone="good" icon="check" title="A key is stored on this device">
            {mask}
          </Chip>
        ) : (
          <Chip tone="neutral">Not set</Chip>
        )
      }
    >
      <View style={s.stackWide}>
        <View style={s.prose}>
          <Text style={s.proseText}>
            The key is kept in this phone’s encrypted keystore rather than in the app’s files
            or its database, and it is sent nowhere except Google. Everything else in
            MoneyFit — every chart, forecast, insight and subscription detector — is computed
            on the device and works without one.
          </Text>
          <Text style={s.proseText}>
            {"Create one at "}
            <Text style={s.strong}>aistudio.google.com/apikey</Text>
            {
              ". There is a free tier, which is what makes these two features free to use; usage beyond it is billed to that Google account. Both are a handful of requests, triggered by you, and nothing runs in the background."
            }
          </Text>
          <Text style={s.proseText}>
            What actually leaves this phone: when you ask a question, the question itself and
            the names of the tables it may read — never your amounts, dates or totals, because
            the query runs here. When you scan a bill, the photo or PDF itself.
          </Text>
          <Text style={s.proseText}>
            On Google’s <Text style={s.strong}>free</Text> tier, what you send may be read by
            people and used to improve their models. That is their published policy, not a
            guess, and it is worth knowing before you point a camera at a receipt. A paid key
            is excluded from it.
          </Text>
        </View>

        <SettingsForm
          action={saveAiKey}
          submit={mask ? "Replace key" : "Save key"}
          saved="Key saved"
        >
          <Field
            label={mask ? "New key" : "API key"}
            name="api_key"
            hint="The box starts empty every time: a key that has gone into the keystore cannot be read back out for display."
          >
            <TextField
              name="api_key"
              // Both forms Google AI Studio has issued, because a placeholder that showed
              // only one would read as a format requirement. Nothing checks the prefix —
              // `lib/secrets.ts` says why at length.
              placeholder="AIzaSy… or AQ.Ab8…"
              secure
              autoCapitalize="none"
              maxLength={200}
            />
          </Field>
        </SettingsForm>

        {mask ? (
          <View style={s.dangerAction}>
            <DangerButton
              action={clearAiKey}
              label="Remove key"
              confirm="Forget the stored key? Ask and bill scanning go back to asking for one. Nothing else changes and no data is deleted."
            />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function SampleData({ empty, counts }: { empty: boolean; counts: Counts }) {
  const s = useStyles(styles);

  return (
    <Card
      title="Sample data"
      note="Eighteen months of plausible history, so every chart has something to draw."
    >
      {empty ? (
        <SettingsForm
          action={loadSampleData}
          submit="Load sample data"
          saved="Loaded — every page has data now"
          note="Takes a second. Clear it again from the danger zone below."
        >
          <View style={s.prose}>
            <Text style={s.proseText}>
              You get seven months of bills across every category, four goals — one with no
              deadline, one deliberately behind, one ahead, one finished and archived — and nine
              holdings including a flat, its home loan, a PPF account and two funds with eighteen
              months of valuations.
            </Text>
            <Text style={s.proseText}>
              The numbers are generated from a fixed seed, so they are the same every time and
              none of it is yours. Your categories and targets are left exactly as they are.
            </Text>
          </View>
        </SettingsForm>
      ) : (
        <Banner tone="neutral" icon="info">
          {`There is already data here — ${plural(counts.bills, "bill")}, ${plural(
            counts.goals,
            "goal",
          )} and ${plural(
            counts.holdings,
            "holding",
          )}. Sample data only loads into an empty app, so it can never bury something real. Clear everything below first if you want it.`}
        </Banner>
      )}
    </Card>
  );
}

/**
 * Export to a JSON file, and import one back.
 *
 * The two sentences this card must not soften are both about what a backup is not: the
 * photos and PDFs stay behind, and an import replaces rather than merges. Both are
 * decisions taken in `lib/backup.ts`, which carries the reasoning; this card's job is to
 * say them before the tap rather than after it.
 */
function Backup({ size }: { size: Loaded["size"] }) {
  const s = useStyles(styles);

  // The card's own "it worked" line. `null` until something does.
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <Card
      title="Backup"
      note="A file you keep, so this phone is not the only copy."
      action={<Chip tone="neutral">{plural(size.rows, "row")}</Chip>}
    >
      <View style={s.backup}>
        <View style={s.prose}>
          <Text style={s.proseText}>
            Export writes every bill, goal, holding, valuation, budget, category and setting to a
            JSON file and hands it to the share sheet, so it can go to Drive, to your own inbox, or
            just into the phone's Downloads.
          </Text>
          <Text style={s.proseText}>
            <Text style={s.strong}>The photos and PDFs do not travel.</Text>
            {` A backup carrying ${plural(
              size.attachments,
              "file",
            )} as text would be one enormous string built in memory, which is the last thing you want on the one feature that is meant to be the safety net. The attachment rows are listed in the file for the record, but they are not restored — a bill pointing at a file that is not there is a broken preview rather than a bill.`}
          </Text>
          <Text style={s.proseText}>
            {"Importing "}
            <Text style={s.strong}>replaces everything</Text>
            {", it does not merge. The whole file is read and checked before a single row is "}
            {"touched, so one that is not a MoneyFit backup — or is from a newer version of the "}
            {"app — leaves what you have exactly as it is."}
          </Text>
        </View>

        <View style={s.backupActions}>
          <ActionButton
            action={exportData}
            icon="download"
            onDone={(r) =>
              setMsg(
                r.shared
                  ? `Exported ${plural(r.rows, "row")} as ${r.fileName} (${fmtBytes(r.bytes)}).`
                  : `Wrote ${r.fileName} (${fmtBytes(
                      r.bytes,
                    )}), but this device offers nowhere to share it, so it is sitting in the app's cache and will not last.`,
              )
            }
          >
            Export
          </ActionButton>
          <DangerButton
            action={importData}
            label="Import a backup"
            icon="upload"
            confirm="This replaces every bill, goal, holding and setting in the app with the contents of a backup file. You will be asked which file next. Nothing can be recovered afterwards."
            onDone={(r) => {
              // `null` means the picker was dismissed. Nothing happened, so nothing is said —
              // overwriting a previous line with "cancelled" would be noise.
              if (!r) return;
              const when = r.exportedAt ? ` taken ${fmtDate(r.exportedAt.slice(0, 10), { year: true })}` : "";
              const dropped =
                r.attachmentsDropped > 0
                  ? ` ${plural(r.attachmentsDropped, "attachment")} in the file were not restored.`
                  : "";
              setMsg(`Restored ${plural(r.rows, "row")} from a backup${when}.${dropped}`);
            }}
          />
        </View>

        {msg ? <Text style={s.backupNote}>{msg}</Text> : null}
      </View>
    </Card>
  );
}

function DangerZone({ counts, empty }: { counts: Counts; empty: boolean }) {
  const s = useStyles(styles);
  const t = useTheme();

  const parts = [
    [counts.bills, "bill"],
    [counts.attachments, "uploaded file"],
    [counts.goals, "goal"],
    [counts.holdings, "holding"],
    [counts.valuations, "valuation"],
    [counts.budgets, "budget"],
  ] as const;
  const listed = parts.filter(([n]) => n > 0).map(([n, label]) => plural(n, label));

  return (
    <Card title="Clear everything">
      {/* `.row-between` with `flex-wrap`, which at phone width is always wrapped —
          so it is a column with the button under the explanation. */}
      <View style={s.danger}>
        <Text style={s.proseText}>
          Deletes every bill, attachment, goal, holding and budget, and the uploaded files behind
          them. Your categories, targets and theme stay — you are left with a fresh install, not
          a blank one. There is no undo, so export a backup above first if there is anything here
          you would miss.
        </Text>
        {listed.length > 0 ? (
          <Text style={s.proseText}>
            {"Right now that is "}
            <Text style={s.strong}>{listed.join(", ")}</Text>
            {"."}
          </Text>
        ) : null}

        <View style={s.dangerAction}>
          {empty && counts.attachments === 0 ? (
            <View style={s.nothing}>
              <Icon name="check" size={15} stroke={2.2} color={t.c.text3} />
              <Text style={s.nothingText}>Nothing to clear</Text>
            </View>
          ) : (
            <DangerButton
              action={wipeEverything}
              label="Clear everything"
              confirm={`Permanently delete ${
                listed.join(", ") || "all data"
              }? Categories, targets and theme are kept. This cannot be undone.`}
            />
          )}
        </View>
      </View>
    </Card>
  );
}

/** "1 bill" / "2 bills" — the web wrote this inline in four places. */
function plural(n: number, label: string): string {
  return `${n} ${label}${n === 1 ? "" : "s"}`;
}

const styles = (t: Theme) => ({
  // `.stack > * + * { margin-top: 20px }`, and the page's own `marginTop: 20`.
  stack: { gap: space.gap + 4, marginTop: space.gap + 4 } as ViewStyle,
  // `<div className="stack" style={{ gap: 18 }}>` inside the targets card.
  stackWide: { gap: 18 } as ViewStyle,

  // The form footer — the Saved chip or the note on the left, Submit on the right.
  foot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space.gapSm,
  } as ViewStyle,
  // `alignItems` so the Chip inside sizes to its content rather than stretching.
  footLeft: { flex: 1, alignItems: "flex-start" } as ViewStyle,
  footNote: { ...font.small, color: t.c.text2 } as TextStyle,

  // `.field > label` over a StatTile instead of an input.
  together: { gap: 6 } as ViewStyle,
  togetherLabel: { ...font.label, color: t.c.text2 } as TextStyle,

  budgetList: { gap: 4 } as ViewStyle,
  budgetCell: { gap: 4 } as ViewStyle,
  budgetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.gapSm,
    paddingVertical: 4,
  } as ViewStyle,
  budgetName: { flexDirection: "row", alignItems: "center", flexShrink: 1, gap: 10 } as ViewStyle,
  budgetLabel: { ...font.body, color: t.c.text, flexShrink: 1 } as TextStyle,
  // `TextField` exposes no style prop and `.input` stretches, so the width lives on
  // a wrapper — wide enough for a seven-figure rupee amount.
  budgetInput: { width: 128 } as ViewStyle,
  // `form.tsx`'s own `.error` style is private to that file.
  rowError: { ...font.small13, color: t.c.red } as TextStyle,

  // `.stack.small.muted` — two paragraphs of explanation.
  prose: { gap: 8 } as ViewStyle,
  proseText: { ...font.small, color: t.c.text2, lineHeight: 18 } as TextStyle,
  // `.strong { font-weight: 500 }`.
  strong: { fontWeight: weight.medium, color: t.c.text } as TextStyle,

  // `Card` puts no gap between its children, so the one card here that is not a
  // `SettingsForm` (whose own style supplies it) brings its own.
  backup: { gap: 12 } as ViewStyle,
  // Two buttons that wrap to a second line on a narrow phone rather than squeezing.
  // Each `PendingButton` renders its own error under itself, so the row's items stay
  // top-aligned and a failure pushes only its own button's column down.
  backupActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 4,
  } as ViewStyle,
  backupNote: { ...font.small13, color: t.c.text2, lineHeight: 19 } as TextStyle,

  danger: { gap: 10 } as ViewStyle,
  dangerAction: { alignItems: "flex-start", marginTop: 4 } as ViewStyle,
  nothing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    // A pill-shaped non-button, so it does not read as something to press.
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: t.c.surface2,
  } as ViewStyle,
  nothingText: { ...font.small, color: t.c.text3 } as TextStyle,
});
