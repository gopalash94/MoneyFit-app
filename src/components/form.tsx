/**
 * The form kit — `Finance/src/components/form.tsx`.
 *
 * On the web these were the app's only client components, and the reason they
 * existed was the browser: a native `<form>` walked its own DOM at submit time and
 * built the `FormData` itself, so each field only had to render an `<input name=…>`
 * and the action received everything.
 *
 * There is no `<form>` element here, and that is the one structural change in this
 * file. `<Form>` takes its place: it owns the values, the action, the pending flag
 * and the returned `FormState`, and every field registers itself with it by name.
 * The consequence for the screens is small and mechanical —
 *
 * | web | here |
 * |---|---|
 * | `<form action={formAction} className="stack">` | `<Form action={action}>` |
 * | `<input className="input" name="x" defaultValue=…>` | `<TextField name="x" defaultValue=… />` |
 * | `<textarea className="textarea" …>` | `<TextField multiline …>` |
 * | `<select className="select">` + `<option>` | `<Select options={…} />` |
 * | `<input type="hidden" name="x" value={v}>` | `<Hidden name="x" value={v} />` |
 * | `<div className="form-grid">` | `<FormGrid>` |
 * | `<div className="form-actions">` | `<FormActions>` |
 * | `<input type="checkbox" name="x">` | `<CheckField name="x" label=… />` |
 * | a `.pickgrid` of `.pick` chips + `<input type="hidden">` | `<IconPicker options={…} />` |
 * | a row of `.swatch` buttons + `<input type="hidden">` | `<SwatchPicker colors={…} />` |
 * | `useActionState(action, null)` then `state?.fields` | `<Form>`'s render prop gives `err` |
 *
 * — while `Field`, `AmountInput`, `DateField`, `CategoryPicker`, `Segmented`,
 * `AttachmentPicker`, `Submit`, `DangerButton` and `ActionButton` **keep their web
 * prop signatures**, which is what lets the seven form screens in phases 8–10 be
 * ported rather than redesigned.
 *
 * The last two rows are components the web did not have, because it wrote both grids
 * inline — the icon chips in `GoalForm` and the asset-type chips in `HoldingForm` are
 * the same grid with a different list, and the colour swatches were copied verbatim
 * between those two files. Neither changes what is submitted: a hidden input's value
 * by another name.
 *
 * Three props are *additive*, and they exist for the same missing browser behaviour.
 * `AmountInput`, `DateField` and `SwatchPicker` take an optional `onChange`, because
 * `GoalForm` and `HoldingForm` quote a figure back as you type — and tint the icon
 * chips with the chosen colour — and on the web they read those off a `change` event
 * bubbling up to a wrapper `<div>`. React Native has no event bubbling, so the field
 * hands its value out directly. `Segmented` and `Select` already worked this way, so
 * it is the file's existing idiom.
 *
 * ### Why `<Form>` does not use `useActionState`
 *
 * It would work — React 19's hook accepts any async function, and the action
 * signature `(prev: FormState, fd: FormData) => Promise<FormState>` is unchanged
 * either way. It is the wrong tool here for one reason: **the form has to know when
 * the action succeeded.** On the web success was signalled by the action calling
 * `redirect()`, which threw, so the page simply never came back. Here an action is a
 * plain module function with no router — it returns `null` and something has to
 * navigate. `useActionState` offers no completion callback, and a `useEffect`
 * watching its state cannot tell "succeeded, returned null" from "has not run yet,
 * initial null". Awaiting the action directly can, exactly, so `<Form>` holds
 * `state` and `pending` in ordinary `useState` and calls `onDone` on the success
 * path. Nothing about the actions changes.
 *
 * `onDone` receives the returned state, because `redirect(`/journal/${billId}`)` knew
 * the id of the row it had just written and a screen navigating in its place has to
 * learn it from somewhere. That is what `FormState.savedId` is for — see the note on
 * it in `actions/shared.ts`.
 *
 * ### Values live in a ref
 *
 * A keystroke must not re-render the whole form — the web's did not, because the
 * value lived in the DOM. So `<Form>` keeps the entries in a ref and each field
 * keeps its own display state; only `state` and `pending` are React state. A field
 * that unmounts clears its entry, which is the same thing the DOM did when an
 * element was removed, and is what makes BillForm's expense/income and paid/upcoming
 * swaps behave as they did.
 *
 * ### Three honest differences
 *
 *   - **`Field`'s `span`** is accepted and ignored: `.form-grid` was two columns and
 *     its own `@media (max-width: 700px)` rule made it one below 700px, so on a
 *     phone every field already spanned the row.
 *   - **`DateField` is a text field**, not a native date picker. A picker means a new
 *     native dependency, and nothing in this project can be run before it ships, so
 *     the kit stays inside the dependency set that is already in `package.json`. It
 *     keeps the web's Today/Yesterday shortcuts, echoes the date back in words as
 *     you type, and `reqDate` already rejects anything that is not `YYYY-MM-DD` with
 *     a clear sentence.
 *   - **`AmountInput` opens the full keyboard**, not the number pad. `inputMode="decimal"`
 *     was free on a desktop browser; on a phone it would hide the letters, and
 *     "45k" / "1.2L" / "2cr" are the shorthand the field advertises.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ImageStyle, StyleProp, TextStyle, ViewStyle } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";

import { Icon, catIcon, type IconName } from "@/components/Icon";
import { Banner } from "@/components/ui";
import type { FormState } from "@/lib/actions/shared";
import { addDays, fmtDate, today as todayIso } from "@/lib/date";
import type { PickedFile } from "@/lib/files";
import { FormData, type FormValue } from "@/lib/form-data";
import { fmt, parseAmount, toInput } from "@/lib/money";
import type { Category } from "@/lib/types";
import { MAX_UPLOAD_BYTES, fmtBytes, isImage } from "@/lib/upload-meta";
import { useStyles, useTheme, type Theme } from "@/theme/ThemeProvider";
import { font, radius, tnum } from "@/theme/tokens";

// ============================================================ the form itself

/** What a field needs from the form it sits in. */
type FormCtx = {
  /** Field errors from the last run, keyed by input name. `{}` before the first. */
  err: Record<string, string>;
  pending: boolean;
  /** Registers or replaces every entry under `name`. */
  put: (name: string, values: FormValue[]) => void;
  /** Removes every entry under `name` — what unmounting an `<input>` used to do. */
  drop: (name: string) => void;
  submit: () => void;
};

/** What the render prop receives. */
export type FormRender = {
  err: Record<string, string>;
  pending: boolean;
  state: FormState;
  /** For a second submit button — "Discard scan" — that runs a different action. */
  submit: () => void;
};

/**
 * There is one of these per mounted form and no nesting, so a module-level holder
 * is enough and avoids a context provider around every screen. `useFormCtx` throws
 * if a field is used outside a form, which is a mistake worth failing loudly on
 * rather than silently dropping the field's value at submit time.
 *
 * Using React context instead would be more idiomatic; it is not used because a
 * field must be able to register during an effect that runs before the provider's
 * own state settles, and the ref-based holder has no such ordering to reason about.
 */
const CTX: { current: FormCtx | null } = { current: null };

function useFormCtx(who: string): FormCtx {
  const ctx = CTX.current;
  if (!ctx) {
    throw new Error(`<${who}> must be rendered inside a <Form>.`);
  }
  return ctx;
}

export function Form({
  action,
  children,
  onDone,
  style,
}: {
  /** Exactly the web's action signature, unchanged. */
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  children: React.ReactNode | ((ctx: FormRender) => React.ReactNode);
  /** Called once the action has returned without an error — usually `router.back()`. */
  onDone?: (state: FormState) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const s = useStyles(styles);
  const [state, setState] = useState<FormState>(null);
  const [pending, setPending] = useState(false);

  // The entries, by name. A ref because a keystroke must not re-render the form.
  const values = useRef<Record<string, FormValue[]>>({});
  // Read inside `submit` so the latest action and callback are always used without
  // making `submit` change identity on every render.
  const latest = useRef({ action, onDone, pending });
  latest.current = { action, onDone, pending };

  const put = useCallback((name: string, next: FormValue[]) => {
    values.current[name] = next;
  }, []);

  const drop = useCallback((name: string) => {
    delete values.current[name];
  }, []);

  const submit = useCallback(() => {
    // The web got this free: a native form ignores a second submit while the first
    // is in flight, and `Submit` was disabled anyway. Both still apply here; this
    // is the belt for the double-tap that beats the re-render.
    if (latest.current.pending) return;
    setPending(true);

    const fd = new FormData();
    for (const [name, list] of Object.entries(values.current)) {
      for (const v of list) fd.append(name, v);
    }

    // `setState(null)` first so a previous run's errors are not on screen while the
    // next one is in flight, which is what a browser form navigation did.
    setState(null);

    void (async () => {
      try {
        const next = await latest.current.action(null, fd);
        setState(next);
        if (!next || !next.error) latest.current.onDone?.(next);
      } catch (e) {
        // An action is expected to catch its own `Invalid` and return a state, so
        // reaching here means something unexpected threw — a failed write, most
        // likely. Showing it beats an unhandled rejection taking the app down.
        setState({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        setPending(false);
      }
    })();
  }, []);

  const ctx = useMemo<FormCtx>(
    () => ({ err: state?.fields ?? {}, pending, put, drop, submit }),
    [state, pending, put, drop, submit],
  );

  // Published before the children render, so a field's own render and its
  // registration effect both see the form they belong to.
  CTX.current = ctx;
  useEffect(() => {
    return () => {
      if (CTX.current === ctx) CTX.current = null;
    };
  }, [ctx]);

  return (
    <View style={[s.form, style]}>
      {/* The web rendered this banner inside each form screen. It is here instead
          so no screen can forget it; `ctx.state` is still exposed for anything a
          screen wants to say about the error itself. */}
      {state?.error ? (
        <Banner tone="bad" icon="alert">
          {state.error}
        </Banner>
      ) : null}
      {typeof children === "function"
        ? children({ err: ctx.err, pending, state, submit })
        : children}
    </View>
  );
}

/**
 * Registers a value with the enclosing form for as long as the caller is mounted.
 *
 * Exported because phases 9 and 10 have pickers of their own — a colour swatch, a
 * month switcher — and this is the whole contract they need.
 */
export function useFormValue(name: string, value: FormValue | FormValue[] | null): void {
  const { put, drop } = useFormCtx("field");
  useEffect(() => {
    if (value === null) {
      drop(name);
    } else {
      put(name, Array.isArray(value) ? value : [value]);
    }
    return () => drop(name);
  }, [name, value, put, drop]);
}

/** `<input type="hidden">` — a value with no interface. */
export function Hidden({ name, value }: { name: string; value: string }) {
  useFormValue(name, value);
  return null;
}

// ============================================================ layout wrappers

/**
 * `.form-grid`. Two columns on a desktop; the stylesheet's own
 * `@media (max-width: 700px)` made it one column, which is what a phone gets.
 */
export function FormGrid({ children }: { children: React.ReactNode }) {
  const s = useStyles(styles);
  return <View style={s.formGrid}>{children}</View>;
}

/** `.form-actions` — right-aligned, wrapping. */
export function FormActions({ children }: { children: React.ReactNode }) {
  const s = useStyles(styles);
  return <View style={s.formActions}>{children}</View>;
}

// ==================================================================== Field

export function Field({
  label,
  name,
  hint,
  error,
  children,
  span,
}: {
  label: string;
  /** Used to read the matching key out of the action's field errors. */
  name?: string;
  hint?: string;
  /** Given explicitly, it wins; otherwise the form's own error for `name` is used. */
  error?: string;
  children: React.ReactNode;
  /**
   * Accepted for signature parity and deliberately ignored — see the header. A
   * single-column form has nothing to span.
   */
  span?: boolean;
}) {
  const s = useStyles(styles);
  const { err } = useFormCtx("Field");
  const shown = error ?? (name ? err[name] : undefined);
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      {children}
      {shown ? (
        <Text style={s.error}>{shown}</Text>
      ) : hint ? (
        <Text style={s.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

// ================================================================ TextField

/**
 * `.input` and `.textarea` in one component — they were the same CSS rule apart
 * from the minimum height, and `multiline` is the only thing that differed in the
 * markup too.
 */
export function TextField({
  name,
  defaultValue,
  placeholder,
  maxLength = 200,
  autoFocus,
  multiline,
  numeric,
  secure,
  autoCapitalize = "sentences",
}: {
  name: string;
  defaultValue?: string | null;
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  /** `<textarea>` — four lines tall and growing, as `min-height: 76px` was. */
  multiline?: boolean;
  /**
   * A number pad, and tabular figures to go with it. Not for money —
   * `AmountInput` needs letters for its shorthand.
   *
   * `decimal-pad` rather than `number-pad`, because the one field that wants this is
   * a holding's units and 12.4567 units of a fund has to be typeable; `number-pad`
   * is integers only. It is the keyboard the web's `inputMode="decimal"` asked for.
   */
  numeric?: boolean;
  /** The API key field in Settings. */
  secure?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [value, setValue] = useState(defaultValue ?? "");
  const [focus, setFocus] = useState(false);
  useFormValue(name, value);

  return (
    <TextInput
      style={[
        s.input,
        multiline ? s.textarea : null,
        // `.input.tnum` on the web — figures line up as they are typed.
        numeric ? tnum : null,
        focus ? { borderColor: t.c.blue } : null,
      ]}
      value={value}
      onChangeText={setValue}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      placeholder={placeholder}
      placeholderTextColor={t.c.text3}
      maxLength={maxLength}
      autoFocus={autoFocus}
      multiline={multiline}
      secureTextEntry={secure}
      keyboardType={numeric ? "decimal-pad" : "default"}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      // Android draws its own underline inside a bordered box otherwise.
      underlineColorAndroid="transparent"
    />
  );
}

// ============================================================== AmountInput

/**
 * Money input. Accepts everything `parseAmount` does — "1250", "1,250.50",
 * "1.2L", "45k" — and shows the interpretation underneath, because shorthand you
 * cannot see the effect of is a trap rather than a shortcut.
 *
 * `onChange` is optional and exists for the two forms that quote something back as
 * you type — `GoalForm`'s ₹-a-month line and `HoldingForm`'s implied gain. On the web
 * those read the value out of a DOM `change` event bubbling up to a wrapper `<div>`;
 * React Native has no event bubbling, so the field hands its raw text out instead.
 * `Segmented` and `Select` already take an `onChange` for the same reason, so this is
 * the established shape rather than a new one. The field stays uncontrolled: the
 * callback is told what happened, it does not decide what the value is.
 */
export function AmountInput({
  name = "amount",
  defaultMinor,
  autoFocus,
  placeholder = "0",
  onChange,
}: {
  name?: string;
  defaultMinor?: number;
  autoFocus?: boolean;
  placeholder?: string;
  /** The text as typed, not a parsed amount — `parseAmount` it yourself. */
  onChange?: (raw: string) => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [raw, setRaw] = useState(defaultMinor ? toInput(defaultMinor) : "");
  const [focus, setFocus] = useState(false);
  const minor = parseAmount(raw);
  const shorthand = /[a-z]/i.test(raw.trim());
  useFormValue(name, raw);

  // The web's `.amount-prefix` was absolutely positioned so the digits never
  // shifted as the number grew and the symbol could not be deleted. Here the
  // prefix is a sibling in a bordered row and the input itself is borderless,
  // which gets both properties without absolute positioning.
  const echo =
    minor === null
      ? "Not a number. Try 1250, 1,250.50, 45k or 1.2L."
      : shorthand || minor >= 100_000_00
        ? fmt(minor)
        : "";

  return (
    <>
      <View style={[s.amountWrap, focus ? { borderColor: t.c.blue } : null]}>
        <Text style={s.amountPrefix}>₹</Text>
        <TextInput
          style={s.amountInput}
          value={raw}
          onChangeText={(next) => {
            setRaw(next);
            onChange?.(next);
          }}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          placeholder={placeholder}
          placeholderTextColor={t.c.text3}
          autoFocus={autoFocus}
          maxLength={30}
          autoCapitalize="none"
          autoCorrect={false}
          // Not a number pad: that would hide the letters "45k" and "1.2L" need.
          keyboardType="default"
          underlineColorAndroid="transparent"
        />
      </View>
      {raw.trim() !== "" && echo !== "" ? (
        <Text style={minor === null ? s.error : s.hintNum}>{echo}</Text>
      ) : null}
    </>
  );
}

// ================================================================ DateField

/**
 * A date field with the two shortcuts that cover most entries.
 *
 * `onChange` is the same optional callback `AmountInput` has, for the same caller:
 * `GoalForm` quotes a monthly contribution from the start date and the deadline, so
 * it has to hear about both. The two shortcut chips go through it too — pressing
 * "Today" is a change like any other.
 */
export function DateField({
  name,
  defaultValue,
  max,
  onChange,
}: {
  name: string;
  defaultValue?: string | null;
  /** Advisory: a later date is flagged here rather than silently accepted. */
  max?: string;
  /** The text as typed, which may not be a valid date yet. */
  onChange?: (raw: string) => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [value, setValue] = useState(defaultValue ?? "");
  const [focus, setFocus] = useState(false);
  useFormValue(name, value);

  /** One place to set it, so the chips and the keyboard behave identically. */
  function change(next: string) {
    setValue(next);
    onChange?.(next);
  }

  const trimmed = value.trim();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const tooLate = valid && max !== undefined && trimmed > max;

  return (
    <>
      <View style={s.dateRow}>
        <TextInput
          style={[s.input, s.dateInput, focus ? { borderColor: t.c.blue } : null]}
          value={value}
          onChangeText={change}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={t.c.text3}
          maxLength={10}
          autoCapitalize="none"
          autoCorrect={false}
          // Not `numeric`: Android's number pad has no hyphen, and a date needs two.
          keyboardType="default"
          underlineColorAndroid="transparent"
        />
        <ChipButton label="Today" onPress={() => change(todayIso())} />
        <ChipButton label="Yesterday" onPress={() => change(addDays(todayIso(), -1))} />
      </View>
      {tooLate ? (
        <Text style={s.error}>That is in the future.</Text>
      ) : valid ? (
        // The echo `AmountInput` has, for the same reason: a typed date should be
        // readable back in words before it is saved.
        <Text style={s.hint}>{fmtDate(trimmed)}</Text>
      ) : trimmed !== "" ? (
        <Text style={s.hint}>Four digits, month, day — 2026-09-30.</Text>
      ) : null}
    </>
  );
}

/** `.chip.chip-btn` — a pill that does something rather than reporting something. */
function ChipButton({
  label,
  onPress,
  icon,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.chipBtn, pressed ? s.pressed : null]}
    >
      {icon ? <Icon name={icon} size={13} stroke={2.2} color={t.c.text2} /> : null}
      <Text style={s.chipBtnText}>{label}</Text>
    </Pressable>
  );
}

// =========================================================== CategoryPicker

/**
 * Category tiles, filtered to the kind being entered — picking "Salary" on an
 * expense is a mistake the form should make impossible, not validate.
 */
export function CategoryPicker({
  categories,
  defaultId,
  kind,
  name = "category_id",
}: {
  categories: Category[];
  defaultId?: number | null;
  kind: "expense" | "income";
  name?: string;
}) {
  const s = useStyles(styles);
  const [selected, setSelected] = useState<number | "">(defaultId ?? "");
  const shown = useMemo(() => categories.filter((c) => c.kind === kind), [categories, kind]);

  // Switching expense→income orphans the selection; clear it rather than
  // submitting a category that is no longer on screen.
  useEffect(() => {
    if (selected !== "" && !shown.some((c) => c.id === selected)) setSelected("");
  }, [shown, selected]);

  // `String(selected)` so nothing selected submits "" — exactly what the web's
  // hidden input did, and `optInt` reads both as null.
  useFormValue(name, String(selected));

  if (shown.length === 0) {
    return <Text style={s.hint}>No {kind} categories yet — add one in Settings.</Text>;
  }

  return (
    <View style={s.pickGrid}>
      {shown.map((c) => {
        const active = c.id === selected;
        return (
          <Pressable
            key={c.id}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => setSelected(active ? "" : c.id)}
            style={({ pressed }) => [
              s.pick,
              // `22` is a 13% alpha suffix, the same tint `IconTile` uses, so a
              // selected category reads as the same object in the list and here.
              active ? { borderColor: c.color, backgroundColor: `${c.color}22` } : null,
              pressed ? s.pressed : null,
            ]}
          >
            <Icon name={catIcon(c.icon)} size={16} color={active ? c.color : undefined} />
            <Text style={[s.pickText, active ? { color: c.color } : null]}>{c.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// =============================================================== IconPicker

/**
 * The other `.pickgrid` — a row of icon-and-label chips over a fixed list.
 *
 * `CategoryPicker` cannot serve here: it takes `Category` rows, filters by kind,
 * allows deselection and submits `""` for nothing. This one is over a constant list,
 * always has exactly one thing chosen, and is what `GoalForm`'s twelve icons and
 * `HoldingForm`'s fourteen asset types both were — each written inline on the web,
 * with a hidden input and a `style={{ "--pick": … }}` custom property doing the
 * colouring. Two copies of the same grid was one too many.
 *
 * The colour can come from the option (an asset type has a fixed colour) or from
 * `tint` (a goal's chips follow whatever colour the swatch row currently has, which
 * is why `SwatchPicker` gained an `onChange`).
 */
export function IconPicker<T extends string>({
  name,
  options,
  defaultValue,
  tint,
  onChange,
}: {
  name: string;
  options: { value: T; label: string; icon: IconName; color?: string }[];
  defaultValue: T;
  /** Wins over each option's own `color`. */
  tint?: string;
  onChange?: (v: T) => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [value, setValue] = useState<T>(defaultValue);
  useFormValue(name, value);

  return (
    <View style={s.pickGrid} accessibilityRole="radiogroup" accessibilityLabel={name}>
      {options.map((o) => {
        const active = o.value === value;
        const color = tint ?? o.color ?? t.c.blue;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => {
              setValue(o.value);
              onChange?.(o.value);
            }}
            style={({ pressed }) => [
              s.pick,
              active ? { borderColor: color, backgroundColor: `${color}22` } : null,
              pressed ? s.pressed : null,
            ]}
          >
            <Icon name={o.icon} size={16} color={active ? color : undefined} />
            <Text style={[s.pickText, active ? { color } : null]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ================================================================ Segmented

/** Radio group drawn as one segmented pill. Used for status and kind. */
export function Segmented<T extends string>({
  name,
  options,
  defaultValue,
  onChange,
}: {
  name: string;
  options: { value: T; label: string; icon?: IconName }[];
  defaultValue: T;
  onChange?: (v: T) => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [value, setValue] = useState<T>(defaultValue);
  useFormValue(name, value);

  return (
    <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel={name}>
      {options.map((o, i) => {
        const active = o.value === value;
        const fg = active ? t.c.blue : t.c.text2;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => {
              setValue(o.value);
              onChange?.(o.value);
            }}
            style={({ pressed }) => [
              s.segItem,
              // `.seg-item + .seg-item { border-left: 1px solid var(--border) }`.
              i > 0 ? s.segDivider : null,
              active ? { backgroundColor: t.c.blueDim } : null,
              pressed && !active ? s.pressed : null,
            ]}
          >
            {o.icon ? <Icon name={o.icon} size={15} stroke={2.2} color={fg} /> : null}
            <Text style={[s.segText, { color: fg }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// =================================================================== Select

/**
 * `<select>` — the field that has no React Native equivalent at all.
 *
 * It looks like `.input`, and tapping it opens a sheet of options. A `Modal` is
 * used rather than a picker library for the same reason `DateField` is a text
 * field: `Modal` is part of React Native itself, so it adds nothing to install and
 * nothing that can fail to link.
 */
export function Select<T extends string>({
  name,
  options,
  defaultValue,
  onChange,
  label,
}: {
  name: string;
  options: { value: T; label: string }[];
  defaultValue: T;
  onChange?: (v: T) => void;
  /** Heading on the sheet. Falls back to the field's own name. */
  label?: string;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [value, setValue] = useState<T>(defaultValue);
  const [open, setOpen] = useState(false);
  useFormValue(name, value);

  const current = options.find((o) => o.value === value);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [s.input, s.selectRow, pressed ? s.pressed : null]}
      >
        <Text style={s.selectText} numberOfLines={1}>
          {current?.label ?? value}
        </Text>
        <Icon name="chevronDown" size={16} stroke={2.2} color={t.c.text3} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        {/* Tapping the scrim closes it, which is what clicking outside a native
            select does. */}
        <Pressable style={s.scrim} onPress={() => setOpen(false)}>
          <Pressable style={s.sheet} onPress={() => {}}>
            <Text style={s.sheetTitle}>{label ?? name}</Text>
            <ScrollView>
              {options.map((o) => {
                const active = o.value === value;
                return (
                  <Pressable
                    key={o.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      setValue(o.value);
                      onChange?.(o.value);
                      setOpen(false);
                    }}
                    style={({ pressed }) => [s.sheetRow, pressed ? s.sheetRowPressed : null]}
                  >
                    <Text style={[s.sheetRowText, active ? { color: t.c.blue } : null]}>
                      {o.label}
                    </Text>
                    {active ? <Icon name="check" size={17} stroke={2.4} color={t.c.blue} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

// ============================================================= SwatchPicker

/**
 * A row of colour circles — a goal's colour, a holding's colour.
 *
 * The web wrote `.swatch` inline in both `GoalForm` and `HoldingForm`, twice. It is a
 * component here because there was no reason for it not to be, and the selected ring
 * is fiddly enough to be worth writing once: `box-shadow: 0 0 0 2px var(--surface),
 * 0 0 0 4px var(--text-2)` put the ring *outside* the circle with a gap, which is a
 * 2px transparent-or-`text2` border around 2px of padding around the 30px circle.
 *
 * The palette stays where it was — a literal in the screen that uses it — so this
 * takes the colours as a prop rather than owning a list of its own.
 */
export function SwatchPicker({
  name,
  colors,
  defaultValue,
  onChange,
}: {
  name: string;
  colors: readonly string[];
  defaultValue: string;
  /** `GoalForm` tints its icon chips with the chosen colour, so it has to hear this. */
  onChange?: (v: string) => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [value, setValue] = useState(defaultValue);
  useFormValue(name, value);

  return (
    <View style={s.swatchRow}>
      {colors.map((c) => {
        const active = c === value;
        return (
          <Pressable
            key={c}
            accessibilityRole="radio"
            accessibilityLabel={`Colour ${c}`}
            accessibilityState={{ selected: active }}
            onPress={() => {
              setValue(c);
              onChange?.(c);
            }}
            style={({ pressed }) => [
              s.swatchRing,
              { borderColor: active ? t.c.text2 : "transparent" },
              pressed ? s.pressed : null,
            ]}
          >
            <View style={[s.swatch, { backgroundColor: c }]} />
          </Pressable>
        );
      })}
    </View>
  );
}

// =============================================================== CheckField

/**
 * A boolean — the web's `<input type="checkbox">`.
 *
 * Two things are worth saying about how this registers its value. First, a checkbox
 * that is *off* submits nothing at all: the browser leaves the name out of the form
 * data entirely, which is exactly why `bool()` in `actions/shared.ts` reads a missing
 * entry as false rather than looking for `"off"`. `useFormValue(name, on ? "on" : null)`
 * reproduces that precisely — `null` drops the entry, and `"on"` is the value a
 * browser would have sent. Every action that reads one of these keeps working
 * unchanged, `withdraw` included.
 *
 * Second, it is a `Switch` rather than a box with a tick. Android has no checkbox
 * primitive in React Native and a switch is the platform's answer to the same
 * question; the label stays on the left and the control on the right, which is where
 * Android puts it. The web's version sat inside a `<label class="row small">` so the
 * text was part of the hit target — `Pressable` around both does the same.
 */
export function CheckField({
  name,
  label,
  defaultChecked = false,
  hint,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: string;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [on, setOn] = useState(defaultChecked);
  useFormValue(name, on ? "on" : null);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={() => setOn((v) => !v)}
      style={s.checkRow}
    >
      <View style={s.checkText}>
        <Text style={s.checkLabel}>{label}</Text>
        {hint ? <Text style={s.hint}>{hint}</Text> : null}
      </View>
      {/* The switch is inside the pressable, so it needs no handler of its own —
          but it keeps one anyway, because dragging the thumb does not produce a
          press on the row. */}
      <Switch
        value={on}
        onValueChange={setOn}
        trackColor={{ false: t.c.surface3, true: t.c.blueDim }}
        thumbColor={on ? t.c.blue : t.c.text3}
      />
    </Pressable>
  );
}

// ========================================================= AttachmentPicker

/**
 * The bill itself: a photo, the photo library, or a PDF.
 *
 * This is the one component with no relation to its web original. There, a
 * `<input type="file">` stayed the single source of truth and the browser
 * submitted the bytes itself, so dropping a file meant rewriting a `FileList`
 * through a `DataTransfer`. Here the three pickers each hand back a URI into the
 * app's cache, those are normalised to `PickedFile`, and the list is registered
 * with the form — which `saveBill` then copies into the attachments directory with
 * `saveUpload`. The security shape is unchanged and lives where it always did:
 * `files.ts` names the stored copy from a UUID and the *declared* MIME type, never
 * from the name the picker reports.
 *
 * The size is checked here so the message arrives before the save, and again in
 * `saveUpload` against the real file, because a declared size is a claim.
 *
 * `quality` and `max` are the two props the web original had no use for, and both
 * exist for `app/bill/scan.tsx`. **`quality` is a limit, not a preference.** A bill
 * attached to a bill is only ever looked at, so 0.8 is right; a bill *sent to the API
 * to be read* has a second ceiling the attachment path does not — the Messages API
 * caps a single image at 5 MB, well under this file's own 12 MB — so the scan screen
 * asks for 0.6 and a modern phone's camera output lands comfortably inside both.
 * **`max` caps how many files survive**, because `scanBill` reads
 * `pickedFiles(fd)[0]` and nothing else: offering a multi-select that silently
 * discards everything after the first would be a worse answer than not offering it.
 */
export function AttachmentPicker({
  name = "files",
  quality = 0.8,
  max,
}: {
  name?: string;
  /** JPEG compression for the two image pickers, 0–1. */
  quality?: number;
  /** Keep at most this many files. Unset means no cap, which is every bill form. */
  max?: number;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [note, setNote] = useState<string | null>(null);
  useFormValue(name, picked.length ? picked : null);

  /** Keeps what fits, and says so when something does not. */
  function add(files: PickedFile[]) {
    const ok = files.filter((f) => f.size === undefined || f.size <= MAX_UPLOAD_BYTES);
    const over = files.length - ok.length;
    setNote(
      over === 0
        ? null
        : `${over} file${over === 1 ? "" : "s"} skipped — over ${fmtBytes(MAX_UPLOAD_BYTES)}.`,
    );
    // Under a cap the newest pick wins rather than the oldest: picking again is how
    // you correct a blurred photo, and keeping the first one would look broken.
    if (ok.length) {
      setPicked((prev) => {
        const next = [...prev, ...ok];
        return max === undefined ? next : next.slice(-max);
      });
    }
  }

  async function camera() {
    setNote(null);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setNote("Camera access is off for MoneyFit. Turn it on in Android settings to photograph a bill.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality });
    if (!res.canceled) add(res.assets.map(fromImage));
  }

  async function library() {
    setNote(null);
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: max !== 1,
      quality,
    });
    if (!res.canceled) add(res.assets.map(fromImage));
  }

  async function document() {
    setNote(null);
    const res = await DocumentPicker.getDocumentAsync({
      type: "application/pdf",
      multiple: max !== 1,
      // Without this the URI can be a content:// handle that stops resolving once
      // the picker closes, and the copy in `saveUpload` would fail.
      copyToCacheDirectory: true,
    });
    if (!res.canceled) add(res.assets.map(fromDocument));
  }

  function remove(i: number) {
    setPicked((prev) => prev.filter((_, n) => n !== i));
  }

  return (
    <>
      <View style={s.pickRow}>
        <ChipButton label="Photograph" icon="camera" onPress={() => void camera()} />
        <ChipButton label="From gallery" icon="image" onPress={() => void library()} />
        <ChipButton label="PDF" icon="file" onPress={() => void document()} />
      </View>
      <Text style={s.hint}>
        Photo or PDF · up to {fmtBytes(MAX_UPLOAD_BYTES)}
        {max === 1 ? "" : " each"}
      </Text>
      {note ? <Text style={s.error}>{note}</Text> : null}

      {picked.length > 0 ? (
        <View style={s.thumbGrid}>
          {picked.map((p, i) => (
            <View key={`${p.name}-${i}`} style={s.thumb}>
              {isImage(p.mimeType) ? (
                <Image source={{ uri: p.uri }} style={s.thumbImage} resizeMode="cover" />
              ) : (
                <View style={s.thumbFile}>
                  <Icon name="file" size={28} stroke={1.6} color={t.c.red} />
                </View>
              )}
              <View style={s.thumbMeta}>
                <Text style={s.thumbName} numberOfLines={2}>
                  {p.name}
                </Text>
                {p.size !== undefined ? <Text style={s.thumbSize}>{fmtBytes(p.size)}</Text> : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove"
                onPress={() => remove(i)}
                style={({ pressed }) => [s.thumbX, pressed ? { backgroundColor: t.c.red } : null]}
              >
                <Icon name="close" size={13} stroke={2.4} color="#ffffff" />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

/**
 * An image asset as a `PickedFile`.
 *
 * `fileName` and `mimeType` are both optional on the asset — the camera in
 * particular often reports neither — so both fall back. The MIME type falls back to
 * JPEG because that is what `launchCameraAsync` produces, and it is the declared
 * type that decides the stored extension, so guessing from the URI's suffix would
 * be the wrong kind of clever.
 */
function fromImage(a: ImagePicker.ImagePickerAsset): PickedFile {
  return {
    uri: a.uri,
    name: a.fileName ?? `bill-${Date.now()}.jpg`,
    mimeType: a.mimeType ?? "image/jpeg",
    size: a.fileSize,
  };
}

function fromDocument(a: DocumentPicker.DocumentPickerAsset): PickedFile {
  return {
    uri: a.uri,
    name: a.name,
    mimeType: a.mimeType ?? "application/pdf",
    size: a.size ?? undefined,
  };
}

// ================================================================== buttons

/**
 * Submit button that disables and spins while the action is running.
 *
 * `pendingLabel` is the one addition to the web's signature, and it exists because
 * `app/bill/scan.tsx` would otherwise have had to reimplement this button. The web
 * did reimplement it — `ScanForm.tsx`'s `ScanSubmit` is a second button whose comment
 * says why: *"Not the shared `Submit`: that says 'Saving…', which is exactly the wrong
 * thing to promise here — this step saves no bill, and a wait this long needs to name
 * what it is doing."* All of that is still true; what is not is the need for a second
 * button to say it, since the only difference between the two was one string.
 */
export function Submit({
  children = "Save",
  pendingLabel = "Saving…",
  icon,
  style,
}: {
  children?: string;
  /** Shown instead of `children` while the action is in flight. */
  pendingLabel?: string;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const { pending, submit } = useFormCtx("Submit");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: pending }}
      disabled={pending}
      onPress={submit}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: t.c.blue },
        pending ? s.disabled : null,
        pressed ? s.pressed : null,
        style,
      ]}
    >
      {pending ? (
        <ActivityIndicator size="small" color={t.c.onAccent} />
      ) : icon ? (
        <Icon name={icon} size={17} stroke={2.2} color={t.c.onAccent} />
      ) : null}
      <Text style={[s.btnLabel, { color: t.c.onAccent }]}>{pending ? pendingLabel : children}</Text>
    </Pressable>
  );
}

/**
 * A one-button action — mark paid, roll, duplicate, discard a scan.
 *
 * On the web each of these had to render its own `<form>`, which is why the "Discard
 * scan" button in `BillForm` used `formAction` instead: a form inside a form is not
 * a thing. There is no form element here, so this composes anywhere, and it holds
 * its own pending state rather than reading the enclosing form's.
 *
 * Generic over the action's result so `onDone` can use it. Most of these actions
 * return `void` and `onDone` takes no argument, which still type-checks; the one that
 * does not is `duplicateBill`, which used to end in `redirect(`/journal/${id}/edit`)`
 * and now returns that id for the screen to navigate with.
 */
export function ActionButton<T>({
  action,
  children,
  icon,
  variant = "outline",
  onDone,
}: {
  action: () => Promise<T>;
  children: string;
  icon?: IconName;
  variant?: "solid" | "ghost" | "outline";
  onDone?: (result: T) => void;
}) {
  return (
    <PendingButton action={action} label={children} icon={icon} variant={variant} onDone={onDone} />
  );
}

/**
 * Destructive action with a confirm step. Deleting a bill takes its attachments
 * with it, which is not recoverable from inside the app.
 *
 * `window.confirm` blocked the thread and returned a boolean; `Alert.alert` does
 * not, so the confirmation is a callback and the label goes on the destructive
 * button, which is the Android convention anyway.
 */
export function DangerButton<T>({
  action,
  label,
  confirm,
  icon = "trash",
  onDone,
}: {
  action: () => Promise<T>;
  label: string;
  confirm: string;
  icon?: IconName;
  onDone?: (result: T) => void;
}) {
  return (
    <PendingButton
      action={action}
      label={label}
      icon={icon}
      variant="danger"
      confirm={confirm}
      onDone={onDone}
    />
  );
}

function PendingButton<T>({
  action,
  label,
  icon,
  variant,
  confirm,
  onDone,
}: {
  action: () => Promise<T>;
  label: string;
  icon?: IconName;
  variant: "solid" | "ghost" | "outline" | "danger";
  confirm?: string;
  onDone?: (result: T) => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fg =
    variant === "solid" ? t.c.onAccent : variant === "danger" ? t.c.red : variant === "ghost" ? t.c.blue : t.c.text;

  async function run() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      onDone?.(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  function press() {
    if (!confirm) {
      void run();
      return;
    }
    Alert.alert("Are you sure?", confirm, [
      { text: "Cancel", style: "cancel" },
      { text: label, style: "destructive", onPress: () => void run() },
    ]);
  }

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: pending }}
        disabled={pending}
        onPress={press}
        style={({ pressed }) => [
          s.btn,
          s.btnSm,
          variant === "solid" ? { backgroundColor: t.c.blue } : null,
          variant === "outline" ? { borderColor: t.c.border } : null,
          variant === "danger" ? { borderColor: t.c.redDim } : null,
          pending ? s.disabled : null,
          pressed ? s.pressed : null,
        ]}
      >
        {pending ? (
          <ActivityIndicator size="small" color={fg} />
        ) : icon ? (
          <Icon name={icon} size={15} stroke={2.2} color={fg} />
        ) : null}
        <Text style={[s.btnLabelSm, { color: fg }]}>{label}</Text>
      </Pressable>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}

// =================================================================== styles

const styles = (t: Theme) => ({
  // The web's form was `className="stack"` — `> * + * { margin-top: 20px }`.
  form: { gap: 20 } as ViewStyle,
  formGrid: { gap: 16 } as ViewStyle,
  formActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 8,
  } as ViewStyle,

  // .field
  field: { gap: 6 } as ViewStyle,
  fieldLabel: { ...font.label, color: t.c.text2 } as TextStyle,
  hint: { ...font.small, color: t.c.text3 } as TextStyle,
  // `...tnum` rather than a bare `fontVariant: ["tabular-nums"]`: the array literal
  // would widen to `string[]`, which is not comparable to `TextStyle`'s union, so the
  // cast on the line would fail. `tnum` is already typed.
  hintNum: { ...font.small, ...tnum, color: t.c.text3 } as TextStyle,
  error: { ...font.small13, color: t.c.red } as TextStyle,

  // .input / .textarea
  input: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: t.c.border,
    borderRadius: radius.sm,
    backgroundColor: t.c.surface,
    color: t.c.text,
    ...font.body,
  } as TextStyle,
  textarea: { minHeight: 76, textAlignVertical: "top" } as TextStyle,

  // .amount-wrap / .amount-prefix / .amount-input
  amountWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: t.c.border,
    borderRadius: radius.sm,
    backgroundColor: t.c.surface,
    paddingLeft: 14,
  } as ViewStyle,
  amountPrefix: { fontSize: 18, color: t.c.text3 } as TextStyle,
  amountInput: {
    // `font.amount` is `.amount-input` exactly: 22px, weight 300, -0.4px tracking.
    ...font.amount,
    ...tnum,
    flex: 1,
    paddingVertical: 9,
    paddingHorizontal: 8,
    color: t.c.text,
  } as TextStyle,

  dateRow: { flexDirection: "row", alignItems: "center", gap: 8 } as ViewStyle,
  dateInput: { flex: 1 } as TextStyle,

  // .chip-btn
  chipBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: t.c.surface2,
  } as ViewStyle,
  chipBtnText: { ...font.label, color: t.c.text2 } as TextStyle,

  // .pickgrid / .pick
  pickGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 } as ViewStyle,
  pick: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: t.c.border,
    backgroundColor: t.c.surface,
  } as ViewStyle,
  pickText: { ...font.buttonSm, color: t.c.text2 } as TextStyle,

  // .seg / .seg-item
  seg: {
    flexDirection: "row",
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: t.c.border,
    borderRadius: radius.pill,
    overflow: "hidden",
  } as ViewStyle,
  segItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 9,
    paddingHorizontal: 16,
  } as ViewStyle,
  segDivider: { borderLeftWidth: 1, borderLeftColor: t.c.border } as ViewStyle,
  segText: { ...font.buttonSm } as TextStyle,

  // .select
  selectRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 } as ViewStyle,
  selectText: { ...font.body, color: t.c.text, flexShrink: 1 } as TextStyle,
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.42)",
    justifyContent: "flex-end",
  } as ViewStyle,
  sheet: {
    backgroundColor: t.c.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: 20,
    paddingBottom: 28,
    paddingHorizontal: 8,
    maxHeight: "70%",
    ...t.shadow2,
  } as ViewStyle,
  sheetTitle: { ...font.cardTitle, color: t.c.text, paddingHorizontal: 16, marginBottom: 10 } as TextStyle,
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.sm,
  } as ViewStyle,
  sheetRowPressed: { backgroundColor: t.c.surface2 } as ViewStyle,
  sheetRowText: { ...font.body, color: t.c.text } as TextStyle,

  // .swatch — 30px circle, 2px gap, 2px ring, so the ring never eats the colour.
  swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 } as ViewStyle,
  swatchRing: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    padding: 2,
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,
  swatch: { width: 30, height: 30, borderRadius: 15 } as ViewStyle,

  // The checkbox row — the web's `<label class="row small">`, which put the text and
  // the control on one line and made both of them the hit target.
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 2,
  } as ViewStyle,
  checkText: { flex: 1, minWidth: 0, gap: 3 } as ViewStyle,
  checkLabel: { ...font.small13, color: t.c.text2 } as TextStyle,

  // The three picker buttons, then .thumb-grid / .thumb
  pickRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 } as ViewStyle,
  thumbGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 12 } as ViewStyle,
  thumb: {
    width: 108,
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: t.c.surface2,
    borderWidth: 1,
    borderColor: t.c.borderSoft,
  } as ViewStyle,
  // `ImageStyle`, not `ViewStyle`: `ImageStyle` narrows `overflow` to
  // `"visible" | "hidden"` where `ViewStyle` also allows `"scroll"`, so a `ViewStyle`
  // is not assignable to an `<Image>`'s `style`.
  thumbImage: { width: "100%", height: 88 } as ImageStyle,
  thumbFile: { height: 88, alignItems: "center", justifyContent: "center" } as ViewStyle,
  thumbMeta: { padding: 6, gap: 2 } as ViewStyle,
  thumbName: { fontSize: 11, color: t.c.text2 } as TextStyle,
  thumbSize: { fontSize: 11, color: t.c.text3 } as TextStyle,
  thumbX: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(32, 33, 36, 0.62)",
  } as ViewStyle,

  // .btn, again — ui.tsx's copy is private to it, and a form button is not a link.
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "transparent",
  } as ViewStyle,
  btnSm: { paddingVertical: 6, paddingHorizontal: 14 } as ViewStyle,
  btnLabel: { ...font.button } as TextStyle,
  btnLabelSm: { ...font.buttonSm } as TextStyle,
  pressed: { opacity: 0.65 } as ViewStyle,
  disabled: { opacity: 0.5 } as ViewStyle,
});
