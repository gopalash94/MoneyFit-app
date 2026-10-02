/**
 * Zod schema → the OpenAPI 3.0 subset Gemini's `responseSchema` will compile.
 *
 * This file exists for the same reason it always did: the SDK that would have done
 * it is not a dependency. On the web `@anthropic-ai/sdk`'s `zodOutputFormat()` built
 * the grammar; the SDK does not support React Native, so the one useful thing it did
 * had to live here. The target changed with `client.ts` → `gemini.ts`, the reason did
 * not, and the payoff is unchanged: `ai/sql.ts` and `ai/extract.ts` still declare
 * their output as Zod, in one place, read by both the grammar and the validator.
 *
 * **The dialect is different enough to be worth spelling out.** Anthropic's
 * structured outputs took JSON Schema and was strict about a handful of keywords.
 * Gemini takes a *subset of OpenAPI 3.0* — a different specification with a
 * different vocabulary — and the hardening pass inverts accordingly:
 *
 *   1. **An allowlist, not a denylist.** The field names below are the whole of what
 *      `Schema` accepts. Google parses this as a protobuf message and an unknown
 *      field is `INVALID_ARGUMENT`, not a shrug — so `additionalProperties`,
 *      `$schema`, `exclusiveMinimum` and everything else Zod might emit is deleted
 *      by not being on the list, rather than by being named on a list of things to
 *      remove that could always be one keyword out of date.
 *   2. **`type` is an enum name, so it is UPPERCASE.** `STRING`, `NUMBER`,
 *      `INTEGER`, `BOOLEAN`, `ARRAY`, `OBJECT`. Zod emits the JSON Schema spelling,
 *      which is lowercase.
 *   3. **There is no null type.** `.nullable()` compiles to
 *      `anyOf: [{type: "string"}, {type: "null"}]`, and `NULL` is not in that enum.
 *      OpenAPI spells the same idea as a flag — `nullable: true` — so that pair is
 *      collapsed into one node. This is the single most important thing in the file:
 *      every schema in this folder leans on `.nullable()`, so getting it wrong is
 *      not a degraded grammar, it is a 400 on every request.
 *   4. **Only a few `format` values are understood** — `date-time` on a string,
 *      `float`/`double` on a number, `int32`/`int64` on an integer. An unknown one
 *      passes client-side validation and then fails at the API, which is the worst
 *      place to find out, so unrecognised formats are dropped here.
 *   5. **`propertyOrdering` is Gemini's own, and has no JSON Schema equivalent.** It
 *      fixes the order fields are generated in. Set from the Zod key order, so the
 *      model fills a bill in the order the schema reads — merchant, then amount,
 *      then the dates — which is also the order that makes each field's context
 *      useful to the next.
 *
 * Validation still happens against the original Zod schema, in `askStructured` —
 * this function produces the *grammar*, not the check. That split is deliberate: the
 * grammar constrains generation, and Zod is what refuses to let a malformed object
 * reach a form field.
 */

// The namespace, not a named `toJSONSchema` import: `z.toJSONSchema()` is the form
// Zod 4 documents, and the one the rest of this folder already imports.
import { z } from "zod";

/** A schema node. Untyped on purpose — this walks a tree it did not declare. */
type JsonObject = Record<string, unknown>;

/**
 * Every field `Schema` has, and nothing else survives the walk.
 *
 * Deliberately the conservative reading of the documented set. Google has been
 * adding keywords (`minimum`, `maxLength`, `pattern`, `title`, `default`) and they
 * may well work; none of the schemas in this folder uses one, so allowing them would
 * widen the surface with no caller to show for it. The standing project rule stands
 * with it: state a count in `.describe()` and `.slice()` in code, rather than asking
 * the grammar to enforce it.
 */
const ALLOWED = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "minItems",
  "maxItems",
  "properties",
  "required",
  "propertyOrdering",
  "anyOf",
]);

/** JSON Schema's lowercase type names → the enum names the API expects. */
const TYPES: Record<string, string> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};

/** The complete list of formats the API understands, per type. Everything else is dropped. */
const OK_FORMATS = new Set(["date-time", "float", "double", "int32", "int64"]);

/** Keys whose value is a *map* of name → schema, so walking them needs one more hop. */
const MAPS = ["properties", "$defs", "definitions"] as const;

export function toResponseSchema(schema: z.ZodType): JsonObject {
  const root = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    // The shape the model must *produce*, which is what a default or a transform
    // makes differ from the shape it would be given.
    io: "output",
    // Inline every reuse rather than emitting `$defs` + `$ref`. OpenAPI 3.0 has
    // `$ref`, but Gemini's subset does not, so inlining is not a preference here —
    // it is the only form that can be sent at all.
    reused: "inline",
    // A type with no JSON Schema equivalent becomes an unconstrained value instead
    // of throwing. Nothing in this folder uses one; if something ever does, a looser
    // grammar with Zod still checking the result beats a crash at request time.
    unrepresentable: "any",
    cycles: "throw",
  }) as unknown as JsonObject;

  harden(root);
  return root;
}

function harden(node: unknown): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const o = node as JsonObject;

  // Nothing should be able to produce a reference, given `reused: "inline"` and
  // `cycles: "throw"` above. If one ever appears, the allowlist would delete it and
  // leave a node with no type — a 400 at request time, pointing at nothing. Fail
  // here instead, where the message can say what happened.
  if ("$ref" in o) {
    throw new Error(
      "ai/json-schema: the schema produced a $ref, which Gemini cannot take. Inline the reused type.",
    );
  }

  nullable(o);
  literalToEnum(o);

  // Children first, while this node's own keys are still untouched — `anyOf` in
  // particular may have just been rewritten by `nullable()` above.
  if ("items" in o) harden(o.items);
  if (Array.isArray(o.anyOf)) for (const child of o.anyOf) harden(child);
  for (const key of MAPS) {
    const map = o[key];
    if (map !== null && typeof map === "object" && !Array.isArray(map)) {
      for (const child of Object.values(map as JsonObject)) harden(child);
    }
  }

  if (typeof o.type === "string") {
    const mapped = TYPES[o.type];
    // An unmapped type is `null` reaching here on its own — a `z.null()` field,
    // which no schema in this folder has. Dropping the key leaves an untyped node,
    // which is the subset's way of saying "any value", and Zod still checks it.
    if (mapped) o.type = mapped;
    else delete o.type;
  }

  if (typeof o.format === "string" && !OK_FORMATS.has(o.format)) delete o.format;

  // An object node is anything declaring properties. `z.record()` would declare
  // itself an object without them, and would come out of here as a bare OBJECT —
  // the honest translation of "the subset has no way to ask for arbitrary keys".
  const props = o.properties;
  if (props !== null && typeof props === "object" && !Array.isArray(props)) {
    const keys = Object.keys(props as JsonObject);
    // Fixes generation order. Without it the order is the model's choice, and a
    // caveat generated before the amount it is a caveat about is a worse caveat.
    o.propertyOrdering = keys;
    // Every property required. For the schemas in this folder this changes nothing
    // — they express "absent" as `.nullable()`, never `.optional()`, so Zod already
    // marks them all required — and it is what stops a model quietly omitting a
    // field it had nothing to say about. If a schema here ever does use
    // `.optional()`, this is the line that would need to start respecting it.
    o.required = keys;
  }

  for (const key of Object.keys(o)) if (!ALLOWED.has(key)) delete o[key];
}

/**
 * `anyOf: [X, {type: "null"}]` → `X` with `nullable: true`.
 *
 * The one rewrite without which nothing in this folder can be sent. Both spellings
 * are handled, because which one Zod emits depends on its target: the `anyOf` pair
 * for draft-2020-12, and a `type: ["string", "null"]` array for older drafts. The
 * second costs four lines and removes a reason for this file to break on a Zod
 * upgrade.
 *
 * A union of two real types — `anyOf` with no null member — is left exactly as it
 * is. Gemini supports `anyOf`, so there is nothing to fix.
 */
function nullable(o: JsonObject): void {
  if (Array.isArray(o.type)) {
    const types = o.type.filter((t) => t !== "null");
    if (types.length !== o.type.length) o.nullable = true;
    if (types.length === 1) o.type = types[0];
    else delete o.type;
    return;
  }

  if (!Array.isArray(o.anyOf)) return;

  const isNull = (m: unknown): boolean =>
    m !== null && typeof m === "object" && (m as JsonObject).type === "null";

  const real = o.anyOf.filter((m) => !isNull(m));
  if (real.length === o.anyOf.length) return;

  o.nullable = true;
  delete o.anyOf;

  // `.nullable()` on exactly one type, which is every use of it here. The outer
  // node keeps its own keys — `description` lives there, because `.describe()` is
  // applied after `.nullable()` in every schema in this folder — and the inner one
  // contributes the shape.
  if (real.length === 1) {
    const inner = real[0] as JsonObject;
    for (const [k, v] of Object.entries(inner)) if (!(k in o)) o[k] = v;
  } else if (real.length > 1) {
    // A nullable union of several types. Not used today; keeping the remaining
    // members is the translation that loses nothing.
    o.anyOf = real;
  }
}

/**
 * `const: "x"` → `enum: ["x"]`.
 *
 * Zod's `.literal()` compiles to `const`, which is JSON Schema and not OpenAPI, so
 * it would be deleted by the allowlist and the field would silently lose its only
 * constraint. A one-value enum says the same thing in the dialect that is being
 * spoken. Non-string literals are dropped rather than guessed at: `enum` is a string
 * list in this subset, and a literal `true` is already fully described by
 * `type: BOOLEAN` for every purpose the grammar serves.
 */
function literalToEnum(o: JsonObject): void {
  if (!("const" in o)) return;
  if (typeof o.const === "string") {
    o.enum = [o.const];
    o.type ??= "string";
  }
  delete o.const;
}
