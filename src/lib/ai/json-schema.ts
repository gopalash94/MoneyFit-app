/**
 * Zod schema → the JSON Schema subset structured outputs will compile.
 *
 * On the web, `@anthropic-ai/sdk`'s `zodOutputFormat(schema)` did this. The SDK does
 * not support React Native, so the one useful thing it did for us has to exist here
 * — and it is a smaller job than it sounds, because Zod 4 ships `z.toJSONSchema()`
 * and all that is left is the conforming.
 *
 * Three things the API is strict about, from its own documentation:
 *
 *   1. **`additionalProperties` must be `false`** on every object. Not absent, not
 *      a schema — `false`. Anything else is a 400.
 *   2. **Constraint keywords are rejected**, not ignored: `minimum`, `maximum`,
 *      `multipleOf`, `minLength`, `maxLength`, `maxItems`, and `minItems` for any
 *      value other than 0 or 1. This is the reason for the standing project rule
 *      (state the count in `.describe()`, `.slice()` in code) — the schemas in this
 *      folder use no constraints at all, so the deletions below should never have
 *      anything to delete. They stay because the cost of being wrong is a 400 in
 *      front of a user and the cost of being right is six lines.
 *   3. **Only ten string `format` values are understood.** An unknown one passes
 *      client-side validation and then fails at the API, which is the worst place
 *      to find out, so unrecognised formats are dropped here.
 *
 * What is *not* a problem, and was worth confirming rather than assuming: `anyOf` is
 * supported, which is what `.nullable()` compiles to and what every schema in this
 * folder leans on. The budget to watch there is sixteen union-typed fields per
 * request — a limit none of the four features comes close to.
 *
 * `required` is made complete even though optional properties are permitted. Two
 * reasons: the schemas here express "absent" as `.nullable()` rather than
 * `.optional()`, so it changes nothing; and the API emits required fields before
 * optional ones regardless of declared order, so an all-required schema is the only
 * one whose output order matches the order it was written in.
 *
 * Validation still happens against the original Zod schema, in `askStructured` —
 * this function produces the *grammar*, not the check. That split is deliberate: the
 * grammar constrains generation, and Zod is what refuses to let a malformed object
 * reach a form field.
 */

// The namespace, not a named `toJSONSchema` import: `z.toJSONSchema()` is the form
// Zod 4 documents, and the one the rest of this folder already imports.
import { z } from "zod";

/** A JSON Schema node. Untyped on purpose — this walks a tree it did not declare. */
type JsonObject = Record<string, unknown>;

/**
 * Keywords structured outputs rejects outright, plus the two (`minItems`,
 * `uniqueItems`) it only partly accepts. Dropping a partly-accepted keyword is
 * always safe; keeping one is not.
 */
const DROP = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "contains",
  "patternProperties",
  "propertyNames",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

/** The complete list the API understands. Everything else is dropped. */
const OK_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Keys whose value is one schema. */
const ONE = ["items", "additionalItems", "not", "if", "then", "else"] as const;
/** Keys whose value is an array of schemas. */
const MANY = ["anyOf", "allOf", "oneOf", "prefixItems"] as const;
/**
 * Keys whose value is a *map* of name → schema. These need naming because the map
 * is not itself a schema: walking it as one would set `additionalProperties` on a
 * bag of fields the moment some schema happened to have a property called
 * "properties".
 */
const MAPS = ["properties", "$defs", "definitions"] as const;

export function toStrictJsonSchema(schema: z.ZodType): JsonObject {
  const root = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    // The shape Claude must *produce*, which is what a default or a transform makes
    // differ from the shape it would be given.
    io: "output",
    // Inline every reuse rather than emitting `$defs` + `$ref`. Internal refs are
    // supported, but a schema with no indirection in it is a schema with no way to
    // become accidentally recursive — and recursion is rejected.
    reused: "inline",
    // A type with no JSON Schema equivalent becomes an unconstrained value instead
    // of throwing. Nothing in this folder uses one; if something ever does, a looser
    // grammar with Zod still checking the result beats a crash at request time.
    unrepresentable: "any",
    cycles: "throw",
  }) as unknown as JsonObject;

  // Informational, and not in the API's list of understood keywords. It describes
  // the dialect to a validator that is not going to see it.
  delete root.$schema;

  harden(root);
  return root;
}

function harden(node: unknown): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const o = node as JsonObject;

  for (const key of DROP) delete o[key];

  if (typeof o.format === "string" && !OK_FORMATS.has(o.format)) delete o.format;

  // An object node is anything declaring properties, or anything declaring itself
  // an object — `z.record()` would be the latter, and would come out here as a
  // closed empty object, which is the honest translation of "the API will not let
  // you ask for arbitrary keys".
  const props = o.properties;
  const isMap = props !== null && typeof props === "object" && !Array.isArray(props);
  if (isMap || o.type === "object") {
    o.additionalProperties = false;
    o.required = isMap ? Object.keys(props as JsonObject) : [];
  }

  for (const key of ONE) if (key in o) harden(o[key]);
  for (const key of MANY) {
    const list = o[key];
    if (Array.isArray(list)) for (const child of list) harden(child);
  }
  for (const key of MAPS) {
    const map = o[key];
    if (map !== null && typeof map === "object" && !Array.isArray(map)) {
      for (const child of Object.values(map as JsonObject)) harden(child);
    }
  }
}
