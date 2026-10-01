/**
 * The category editor — `Finance/src/components/CategoriesEditor.tsx`.
 *
 * Add, rename, restyle, archive, delete. One `editing` id at a time, because two
 * open edit forms in a list is two ways to lose the one you meant.
 *
 * **The four action props are gone.** On the web this component took `add`, `save`,
 * `setArchived` and `remove` as props and `.bind`-ed the last three to a row id, and
 * its header explained why: a Server Action is a reference that has to be handed
 * across the server/client boundary, and `.bind` was "what lets a list of rows share
 * three actions instead of passing eighty-one bound ones down as props". None of that
 * applies here — the actions are ordinary async functions in the same bundle, so this
 * file imports them directly and each row closes over its own id. The web's `CatRow`
 * mapping went with them: it existed to limit what crossed the boundary, and there is
 * no boundary to limit, so this takes `CategoryAdmin` rows exactly as the query
 * returns them.
 *
 * **`StylePicker` is `SwatchPicker` above `IconPicker`**, and the order is inverted
 * from the web's on purpose: thirty labelled icon chips are six or seven rows tall on
 * a phone, so a colour control underneath them would put the tint's effect off the
 * bottom of the screen while you were tapping it. Colour first, icons below, tinted
 * live by whatever the swatch row currently holds — the same wiring `GoalForm` uses.
 *
 * **The icon chips carry labels.** `IconPicker` always renders one, and on a touch
 * device that is the right call anyway: the web's icon-only tiles relied on a hover
 * tooltip (`aria-label`) that a finger cannot produce.
 *
 * **The tables are lists.** React Native has no `<table>`, so each row is a card with
 * the tile, the name and the archived chip on one line and the bill count and the
 * three buttons on the next — `ActionButton` and `DangerButton` are already small.
 *
 * **`AddForm`'s reset is a remount**, as everywhere else in this port: `onDone` bumps
 * `gen` and `gen` is the `<Form>`'s key. The web kept a `ref` to the `<form>`, called
 * `reset()` and then bumped a `round` counter anyway *because* `reset()` knew nothing
 * about the React state behind the hidden icon and colour inputs. One mechanism does
 * both jobs here.
 */

import { useState } from "react";
import { Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

import { Icon, catIcon, type IconName } from "./Icon";
import {
  ActionButton,
  DangerButton,
  Field,
  Form,
  FormActions,
  FormGrid,
  IconPicker,
  Segmented,
  Submit,
  SwatchPicker,
  TextField,
} from "./form";
import { Chip } from "./ui";
import {
  addCategory,
  deleteCategory,
  saveCategory,
  setCategoryArchived,
} from "@/lib/actions/categories";
import { CATEGORY_COLORS, CATEGORY_ICONS } from "@/lib/category-style";
import type { CategoryAdmin } from "@/lib/queries/settings";
import { useStyles, type Theme } from "@/theme/ThemeProvider";
import { font, radius, space, weight } from "@/theme/tokens";

/**
 * The thirty category glyphs as picker options. Title-cased rather than left bare,
 * because "Utensils" beside a fork is a label and "utensils" looks like a typo.
 */
const ICON_OPTIONS: { value: IconName; label: string; icon: IconName }[] = CATEGORY_ICONS.map(
  (n) => ({ value: n, label: `${n[0].toUpperCase()}${n.slice(1)}`, icon: n }),
);

/**
 * A stored icon name, narrowed to one of the picker's own options.
 *
 * `.find()` rather than `.includes()`: `CATEGORY_ICONS` is `readonly IconName[]`, so
 * `includes(someString)` is a type error and the cast that fixes it does not narrow.
 * `GoalForm` reaches for the same trick for the same reason.
 */
function pickIcon(name: string | undefined): IconName {
  return CATEGORY_ICONS.find((n) => n === name) ?? "receipt";
}

export function CategoriesEditor({ categories }: { categories: CategoryAdmin[] }) {
  const s = useStyles(styles);
  const [editing, setEditing] = useState<number | null>(null);

  return (
    <View style={s.wrap}>
      <AddForm />

      {(["expense", "income"] as const).map((kind) => {
        const rows = categories.filter((c) => c.kind === kind);
        if (rows.length === 0) return null;
        return (
          <View key={kind} style={s.group}>
            <Text style={s.groupTitle}>
              {kind === "expense" ? "Spending categories" : "Income categories"}
              <Text style={s.groupCount}>{` · ${rows.length}`}</Text>
            </Text>
            {rows.map((c) =>
              editing === c.id ? (
                <EditForm key={c.id} row={c} onDone={() => setEditing(null)} />
              ) : (
                <Row key={c.id} row={c} onEdit={() => setEditing(c.id)} />
              ),
            )}
          </View>
        );
      })}
    </View>
  );
}

// ======================================================================== a row

function Row({ row: c, onEdit }: { row: CategoryAdmin; onEdit: () => void }) {
  const s = useStyles(styles);

  return (
    <View style={[s.row, c.archived ? s.rowArchived : null]}>
      <View style={s.rowHead}>
        <View style={[s.tile, { backgroundColor: `${c.color}1f` }]}>
          <Icon name={catIcon(c.icon)} size={16} stroke={2} color={c.color} />
        </View>
        <Text style={s.rowName} numberOfLines={1}>
          {c.name}
        </Text>
        {c.archived ? <Chip tone="neutral">archived</Chip> : null}
      </View>

      <View style={s.rowFoot}>
        {/* The web's table had a "Bills" column heading to explain a bare number.
            Without one, the count says what it is. */}
        <Text style={s.rowCount}>
          {c.bill_count > 0 ? `${c.bill_count} bill${c.bill_count === 1 ? "" : "s"}` : "No bills"}
        </Text>
        <View style={s.rowBtns}>
          <ActionButton action={async () => onEdit()} icon="edit" variant="ghost">
            Edit
          </ActionButton>
          <ActionButton
            action={() => setCategoryArchived(c.id, !c.archived)}
            icon={c.archived ? "undo" : "check"}
            variant="ghost"
          >
            {c.archived ? "Reopen" : "Archive"}
          </ActionButton>
          <DangerButton
            action={() => deleteCategory(c.id)}
            label="Delete"
            confirm={
              c.bill_count > 0
                ? `Delete “${c.name}”? Its ${c.bill_count} bill${c.bill_count === 1 ? "" : "s"} will stay, but they lose their category — they show as Uncategorised and drop out of the spending breakdown. Archive it instead to keep all of that and just hide it from the pickers.`
                : `Delete “${c.name}”? Nothing is filed under it.`
            }
          />
        </View>
      </View>
    </View>
  );
}

// ==================================================================== the forms

function AddForm() {
  const s = useStyles(styles);
  const [gen, setGen] = useState(0);

  return (
    <View style={s.addCard}>
      <Text style={s.groupTitle}>New category</Text>
      <Form key={gen} action={addCategory} onDone={() => setGen((g) => g + 1)} style={s.tight}>
        {() => (
          <>
            <FormGrid>
              <Field label="Name" name="name">
                <TextField name="name" placeholder="Pet food" maxLength={60} />
              </Field>

              <Field label="Kind" hint="This cannot be changed later — see the note below.">
                <Segmented
                  name="kind"
                  defaultValue="expense"
                  options={[
                    { value: "expense", label: "Spending", icon: "arrowDown" },
                    { value: "income", label: "Income", icon: "arrowUp" },
                  ]}
                />
              </Field>

              <StylePicker />
            </FormGrid>

            <FormActions>
              <Submit>Add category</Submit>
            </FormActions>
          </>
        )}
      </Form>
    </View>
  );
}

function EditForm({ row: c, onDone }: { row: CategoryAdmin; onDone: () => void }) {
  const s = useStyles(styles);

  return (
    <View style={s.editCard}>
      {/* `saveCategory` is id-first, so the row's own id is closed over here rather
          than bound to the function as the web had to do. */}
      <Form
        action={(prev, fd) => saveCategory(c.id, prev, fd)}
        onDone={onDone}
        style={s.tight}
      >
        {() => (
          <>
            <Field label="Name" name="name">
              <TextField name="name" defaultValue={c.name} maxLength={60} autoFocus />
            </Field>

            <StylePicker icon={c.icon} color={c.color} />

            <FormActions>
              <ActionButton action={async () => onDone()} variant="ghost">
                Cancel
              </ActionButton>
              <Submit>Save</Submit>
            </FormActions>
          </>
        )}
      </Form>
    </View>
  );
}

/** Colour and icon, as two registered pickers — the web's two hidden inputs. */
function StylePicker({ icon, color }: { icon?: string; color?: string }) {
  // `CATEGORY_COLORS` is already uppercase and `SwatchPicker` matches by identity,
  // so a stored colour has to be folded before it can select its own swatch.
  const initial = (color ?? CATEGORY_COLORS[0]).toUpperCase();
  const [tint, setTint] = useState(initial);

  return (
    <>
      <Field label="Colour">
        <SwatchPicker
          name="color"
          colors={CATEGORY_COLORS}
          defaultValue={initial}
          onChange={setTint}
        />
      </Field>

      <Field label="Icon">
        <IconPicker
          name="icon"
          options={ICON_OPTIONS}
          defaultValue={pickIcon(icon)}
          tint={tint}
        />
      </Field>
    </>
  );
}

const styles = (t: Theme) => ({
  wrap: { gap: space.gap + 6 } as ViewStyle,
  group: { gap: space.gapSm } as ViewStyle,

  // `.card-title` plus the muted count beside it.
  groupTitle: { ...font.cardTitle, color: t.c.text } as TextStyle,
  groupCount: { ...font.small, fontWeight: weight.medium, color: t.c.text2 } as TextStyle,

  // The web tinted an open edit row's cell `--surface-2`; the closed rows were plain
  // table rows. Giving every row the tint keeps the list legible without borders.
  row: {
    backgroundColor: t.c.surface2,
    borderRadius: radius.sm,
    paddingHorizontal: space.cardSm,
    paddingVertical: 12,
    gap: 10,
  } as ViewStyle,
  rowArchived: { opacity: 0.55 } as ViewStyle,

  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 } as ViewStyle,
  tile: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,
  rowName: { ...font.body, fontWeight: weight.medium, color: t.c.text, flexShrink: 1 } as TextStyle,

  rowFoot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 6,
  } as ViewStyle,
  rowCount: { ...font.small, color: t.c.text3 } as TextStyle,
  rowBtns: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 } as ViewStyle,

  addCard: {
    backgroundColor: t.c.surface2,
    borderRadius: radius.sm,
    padding: space.cardSm,
    gap: 12,
  } as ViewStyle,
  editCard: {
    backgroundColor: t.c.surface3,
    borderRadius: radius.sm,
    paddingHorizontal: space.cardSm,
    paddingVertical: 12,
  } as ViewStyle,

  // `style={{ gap: 14 }}` on both web forms, which is tighter than `.form`'s 20.
  tight: { gap: 14 } as ViewStyle,
});
