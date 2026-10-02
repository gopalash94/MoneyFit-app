# MoneyFit for Android

The MoneyFit web app, as a phone app. Same three rings, same bill journal, same goal
pace maths, same XIRR, same statement importer, same year view, same Gemini-backed Ask
— running on SQLite inside the app instead of Postgres inside Docker, so it works with
no server, no network and no account.

Written as an [Expo](https://expo.dev) / React Native project, which means it is also an
Android Studio project: one command generates the `android/` folder, and Android Studio
opens it like any other Gradle project.

> **Read this first.** Nothing in this folder has been run, and nothing has been
> type-checked. The machine it was written on has no Node, no Android SDK and no
> emulator, so there was no way to compile a line of it. Every file was instead held to
> the same `strict` TypeScript settings the web app uses and read back against the types
> it consumes — which is how the web app's own build errors were found, but it is review,
> not proof. **The first thing to do after `npm install` is `npm run typecheck`**, and
> the second is to send me whatever it prints. See [Status](#status).

---

## Contents

- [What it does](#what-it-does)
- [Prerequisites](#prerequisites)
- [Behind a corporate proxy (Zscaler)](#behind-a-corporate-proxy-zscaler)
- [Three ways to run it](#three-ways-to-run-it)
- [First launch: a walkthrough](#first-launch-a-walkthrough)
- [The AI key](#the-ai-key)
- [Backup and restore](#backup-and-restore)
- [How the data is stored](#how-the-data-is-stored)
- [Project layout](#project-layout)
- [What is deliberately different from the web app](#what-is-deliberately-different-from-the-web-app)
- [Status](#status)
- [Troubleshooting](#troubleshooting)

---

## What it does

Five bottom tabs, a **More** screen with five destinations behind it, and twelve pushed
screens — plus the greeting the app opens with, once per run, which is chrome rather than
a destination.

| Tab | What is on it |
|---|---|
| **Home** | The three concentric rings — spend against budget, goal funding, investing — plus the month's cashflow, budget status, upcoming bills, goal pace, net worth, a twelve-month trend and a card for importing a statement. |
| **Journal** | Every bill, grouped by day, filterable by status. Add one by hand, duplicate it, import a bank or card statement, or photograph it and let the model read it. Images and PDFs attach and open. A badge on the tab carries the count of what is overdue. |
| **Track** | Budgets per category, daily burn-down against pace, month-on-month movement, the largest expenses, statistical subscription detection, and forecasts. |
| **Goals** | Target, deadline, contributions, and a pace chip that says *ahead* / *on track* / *behind* / *at risk* with the monthly figure needed to fix it. Coaching across all goals, computed on the phone. |
| **Invest** | Holdings and liabilities, manual valuation snapshots, XIRR per holding and overall, allocation, contribution-vs-growth attribution, drawdown. |

Behind the header button (**More**): **Year** (one calendar year on one screen — twelve
month rows, categories, goals, investing, net worth first to last, and the extremes),
**Profile** (net worth, assets, liabilities, lifetime totals), **Ask** (a question in
plain English, answered by generated SQL over read-only views), **Insights** (spending
narrative and anomalies), **Settings**.

The statement importer is reached from the Journal header and from a card on Home, and
is deliberately **not** in **More** — the same placement the web app gives it, and for
the reason its `Nav.tsx` records: it is something you do to the journal, not a place you
go.

Everything is in ₹ with lakh/crore grouping, and every amount is stored as integer paise
and only formatted at the edge — so nothing rounds twice.

### Statement import

Pick a CSV or PDF statement from your bank or card issuer and it becomes bills, after a
review screen you can edit. **No model is involved.** The columns are reconstructed from
the glyph positions in the PDF, amounts and dates are parsed by hand-written rules,
narrations are cleaned, categories come from a rule table over the merchant text, and
anything already in the journal is detected as a duplicate and skipped. A PDF with no
text layer — a photographed or scanned page — is refused rather than guessed at.

This is the web app's importer, file for file: `src/lib/statement/` is a near-verbatim
port of `MoneyFit/src/lib/statement/`, including the column reconstructor, which is the
one file in this project it would have been expensive to get wrong.

### The AI features

Two, both optional, and both of them *are* the model — everything else in the app is
arithmetic:

1. **Ask** — your question becomes SQL, the SQL runs locally, and the model never sees
   the results. So no figure on that screen can be invented. Every question is kept as a
   thread you can re-read, including the ones that were refused or failed.
2. **Bill scanning** — photograph or pick a receipt or PDF invoice and the fields come
   back filled in for you to check.

Without a key those two show a short "not configured" card and everything else works.
That is not a reduced version of anything: **Insights and goal coaching used to be model
calls and are now computed on the phone**, in `src/lib/analytics/narrative.ts` and
`coaching.ts`, from the same rows the charts above them are drawn from. The web app made
that change first and this followed it. Those two screens no longer have a loading
state, an error state or a "needs a key" state, because they always have an answer.

---

## Prerequisites

**Node 22 or newer.** This is not optional and it is not an Expo quirk — React Native's
own Gradle build shells out to Node to bundle the JavaScript, so *any* React Native
Android build needs it, including one started from inside Android Studio.

```bash
winget install OpenJS.NodeJS.LTS
```

Close and reopen your terminal afterwards, then check:

```bash
node --version
```

For routes 2 and 3 below you also need **JDK 17** and the **Android SDK** — both of
which Android Studio installs for you. Route 1 needs neither.

### One thing `npm install` does that is worth knowing about

`postinstall` runs `scripts/bundle-pdfjs.mjs`, which copies two files out of
`node_modules/pdfjs-dist` into `assets/pdfjs/`. They are the PDF text layer, about 2.4 MB
of minified JavaScript, and they are gitignored rather than vendored — so a fresh clone
has two 1 KB placeholders sitting at those paths instead.

The placeholders are not an oversight. Metro resolves asset imports when it builds the
bundle, so a *missing* `assets/pdfjs/pdf.min.pdfjs` is not a broken PDF importer, it is a
resolution error that stops the whole app from starting and never mentions PDFs. The
script therefore always writes something, and `src/lib/statement/pdfjs-shim.ts`
length-checks what it reads at runtime — so if the real files are not there, you get one
legible sentence on the import screen naming the script to run, with CSV import still
working.

If you ever install with `--omit=dev`, or change the pinned `pdfjs-dist` version:

```bash
npm run bundle-pdfjs
```

It prints the size and a short SHA-256 of each file, which is the only practical way to
confirm the pdf.js in a build is the one you think it is. **pdf.js is bundled and never
fetched** — see the note on the WebView under [what is deliberately
different](#what-is-deliberately-different-from-the-web-app).

---

## Behind a corporate proxy (Zscaler)

`npm install` will fail with `SELF_SIGNED_CERT_IN_CHAIN` or `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
on a GE laptop, because Zscaler re-signs TLS traffic with its own root and npm does not
trust it. The web app hit this and the fix is already sitting next to this folder:

```bash
npm config set cafile "C:\Users\270003127.AEROAD\OneDrive - GE Aerospace\Desktop\MoneyFit\MoneyFit\certs\ca-bundle.crt"
```

That is a one-time, per-user setting. The bundle holds 182 public root and intermediate
certificates — no keys, nothing account-specific.

**Do not fix this by turning verification off.** `npm config set strict-ssl false` and
`NODE_TLS_REJECT_UNAUTHORIZED=0` both appear in search results and both make every
package you download unverifiable for every project on the machine. They are
deliberately absent from this project and from the web app. The fix is to *add* a
trusted root, never to stop checking.

---

## Three ways to run it

Pick by how much you want to install. They are in that order.

### 1. Expo Go — no Android Studio, no Gradle, nothing to build

Every dependency in `package.json` ships inside the Expo Go app, so this works today:

```bash
npm install
npx expo start
```

Install **Expo Go** from the Play Store, scan the QR code the terminal prints, and the
app opens on your phone. Edit a file and it reloads.

This is the fastest way to find out whether it works, and it is the only route that needs
nothing but Node. Two limits: your phone and laptop must be on the same network, and the
app lives inside Expo Go rather than appearing as its own icon.

Nothing here uses a custom native module, so Expo Go should carry all of it — but
`react-native-webview` was added by the statement importer and nobody has confirmed that
on this SDK. If Expo Go complains about it on launch, that is the one thing in this
project that would push you to route 2, and only the PDF half of the importer depends on
it.

### 2. Android Studio

Android Studio needs a generated `android/` folder. It cannot be hand-written, because
`gradlew` depends on a binary `gradle-wrapper.jar`. One command writes it:

```bash
npm install
npx expo prebuild --platform android
```

Then **File → Open →** `MoneyFit-app\android`, let Gradle sync, and press Run with a
device or emulator attached.

`android/` is generated output and is in `.gitignore`. Never hand-edit it: anything you
change there is lost the next time it is regenerated. Native configuration — the app
name, the package `com.moneyfit.app`, the icon, the permissions, the splash colour —
lives in `app.json`, and `prebuild` turns that into the real Gradle and manifest files.

If you change `app.json` later, re-run `npx expo prebuild --platform android --clean`.

### 3. EAS Build — an APK from the cloud, nothing installed locally

If you would rather install nothing at all: push this folder to GitHub, then

```bash
npx eas-cli build --platform android --profile preview
```

`eas.json` is already configured — the `preview` profile produces a plain `.apk` you can
download and sideload; `production` produces an `.aab` for Play. The build happens on
Expo's machines, so no local Node, Android SDK or Gradle is involved. It needs a free
Expo account.

---

## First launch: a walkthrough

The app starts empty, which means every chart starts empty. **Load the sample data
first** — eighteen months of generated history, so there is something to look at on every
screen before you have typed a single real bill.

**More → Settings → Sample data → Load sample data.**

It takes a second or two. It only loads into an empty app, so it can never bury
something real, and it leaves your categories and targets alone. The numbers come from a
fixed seed: the same every time, and none of it is yours.

Then walk the app and tell me what is wrong:

1. **Home** — three rings, drawn and animated. Scroll the whole feed.
2. **Journal** — days grouped with headings; tap a bill; the status filters.
3. **Add a bill by hand** — the FAB on Journal. Check the amount field, the date field
   and the category picker.
4. **Attach a photo** and a **PDF** to a bill. The photo should preview inline; the PDF
   should open through the share sheet.
5. **A recurring bill** — set recurrence on one, mark it paid, and check the next one
   appears.
6. **Track** — the burn-down line, the budget bars, and the month navigation arrows.
7. **Goals** — a goal with contributions, and its pace chip. The sample set deliberately
   contains one behind, one ahead, one with no deadline and one finished and archived.
8. **Invest** — a holding with two valuations, its XIRR, and the net-worth trend.
9. **More → Year** — the current year, then arrow back to an empty one. The twelve month
   rows should sum to the headline figure above them, and a month with no data should be
   a dim `—` rather than a missing row.
10. **Import a statement** — the button on the Journal header, or the card on Home. Try a
    **CSV** first: it exercises the parser, the column logic, the categoriser, the
    duplicate detection and the whole commit path with no WebView involved. Then try a
    **PDF**, which is the one genuinely unproven path in this folder. Edit a row on the
    review screen, pull to refresh, and check your edit survived.
11. **The theme button** in the header — light, dark, and whatever the phone is set to.
12. **Force-quit and reopen** — this proves SQLite persisted rather than the data living
    in memory.
13. **Settings → Backup → Export** — then clear everything, import the file back, and
    check your bills return.

Then, if you want the two AI features, add a key (below), try **Scan** on a real receipt,
and ask **Ask** one question — then leave the screen and come back, which is what proves
the thread is in the database and not in a React state.

When you are done looking, **Settings → Clear everything** removes the sample data and
leaves your categories, targets and theme in place.

---

## The AI key

One key, **Gemini**, shared by both AI features. The web app reads `GEMINI_API_KEY` from
`.env` on the server. A phone has no server and no `.env`, so the key is typed in once:

**More → Settings → Gemini API key.**

Get one from <https://aistudio.google.com/apikey>. It is stored with
[`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/) — on Android
that is SharedPreferences encrypted with a key held in the Android Keystore.

Four properties of how that is handled, since it is the one secret in the app:

- **It is never in the source and never in the build.** There is no key in this folder,
  `.env` is gitignored, and nothing bundles one.
- **It cannot be read back.** Once stored, Settings shows only a mask (`AIzaSy…a1b2`, or
  `AQ.Ab8…a1b2` on the newer form Google AI Studio issues) — enough to tell "a key is
  set" from "the wrong key is set", useless to anyone looking over your shoulder. The
  field is empty on every visit.
- **Saving an empty field is an error, not a delete**, precisely because the field is
  always empty — a stray tap on Save must not silently throw away a working key.
  Removing one is its own button.
- **No error message can contain it.** `src/lib/secrets.ts` is the only module that
  touches the value; it never logs it and never echoes it into a message, and nothing
  exported from an action module returns it.

An Anthropic key stored by an older build of this app is **deleted once** on the next
launch rather than left in the keystore. It can no longer be used for anything here, and
a credential that has been rotated away from should not outlive the feature that wanted
it.

The key goes to `generativelanguage.googleapis.com` and nowhere else. **Nothing is
cached.** An earlier version kept model responses in an `ai_cache` table; there is
nothing left to cache — Ask stores the finished answer as a turn in the thread, which is
a record rather than a cache, and a photographed receipt is read once.

Worth reading before you switch it on: on Google's **free** tier the text you send may be
read by people and used to improve their models. Ask never sends your figures — only the
question and the names of the analytics views — but a question can itself be revealing.
The Ask screen says so in its own words before you give it a key.

---

## Backup and restore

**More → Settings → Backup.** Export writes one JSON file and hands it to the share
sheet, so it can go to Drive, to your own inbox, or into Downloads. Import reads one
back.

This is the only feature here that the web app does not have, and the reason is the
whole point of it: on the web the data sits in a Postgres volume on a machine you own,
and on a phone it sits in one app's private storage on one device. Two things about the
format are worth knowing before you rely on it:

- **The photos and PDFs do not travel.** Base64 of every attachment would mean building
  one enormous string in memory, on the one feature that exists to be a safety net, and
  nobody could test that it survives a mid-range phone. So attachment *rows* are written
  into the file as a faithful record of what the database held — and are deliberately
  **not** restored, because a bill pointing at a file that is not there is a broken
  preview rather than a bill. Keep your receipts somewhere else too.
- **Import replaces, it does not merge.** The whole file is read and validated before a
  single row is touched, and then the database is swapped for it inside one transaction.
  A file that is not a MoneyFit backup, or is from a newer version of the app, leaves
  what you have exactly as it was. There is no undo afterwards.

Ids are preserved, so a restored contribution lands on the goal it belonged to. **Thirteen
of the fourteen tables travel**, in parent-first order so every foreign key has something
to point at by the time it is inserted. The one left out is `scan_drafts`: a draft is a
photograph the model has read but you have not confirmed yet, it is deleted the moment
you save or discard it, and the image file it points at does not travel either — so a
restored draft would be a half-finished bill with a broken preview. It is still *cleared*
on import, like every other table, so a restore cannot leave one stranded.

---

## How the data is stored

One SQLite database, `moneyfit.db`, in the app's private storage. Fourteen tables, eleven
analytics views, a `PRAGMA user_version` migration ladder, WAL journaling, and foreign
keys on.

The ladder is at version 2. Rung 2 is what this port's catch-up needed: the
`statement_batches` table, the `ask_turns` thread, and `bills.holding_id` (the "Paid
from" account) and `bills.statement_batch_id` with their indexes. A **fresh** install
never runs it — `src/db/schema.ts` carries the same shape directly — so the two have to
be kept in step by hand, which is what the comment at the top of each says. The one thing
rung 2 *drops* is `ai_cache`; `bills.source` stays, because the camera scan still writes
`'ai'` to it.

**There is no sync.** This phone is the authority for its own data; the Docker web app is
the authority for its. The JSON backup above is the bridge between them, in one
direction at a time.

Money is stored as integer paise in `*_minor` columns and formatted only for display.
Dates are `TEXT` in `YYYY-MM-DD`. Attachments are copied into the app's document
directory under a name made from a fresh UUID and the file's *declared* MIME type — never
from the name the picker reported — so a file called `../../etc/passwd` is stored as
`<uuid>.png` with its original name kept as an inert label.

**A PDF statement's password is never stored.** The web app holds it in an httpOnly,
`sameSite: "lax"` session cookie scoped to the import route; there are no cookies here,
so it lives in a module-level map for as long as the app is running and is cleared when
the batch is committed or deleted. It is never written to SQLite and never put in a route
parameter, where it would end up in navigation state.

The **Ask** screen generates SQL, and on the device four independent limits stand between
that SQL and your data, replacing the read-only Postgres role the web app used:

1. A **separate connection** with `PRAGMA query_only = ON`, which is per-connection and
   lasts its lifetime.
2. A **name allowlist** — every `FROM` and `JOIN` target must be one of the eleven
   analytics views (minus the query's own CTE names).
3. **One statement**, `SELECT` or `WITH` only, with a forbidden-keyword list that
   includes `pragma`, `attach` and `detach` so the first barrier cannot be undone.
4. A **five-second race** and a hard `LIMIT`.

One honest difference from the web app, which is documented in the code too: SQLite has
no interrupt API, so a pathological query keeps running on the native thread after the
timeout is reported. Against eleven small views over one person's data this is not a
practical concern, but it is not the hard cap Postgres gave us.

---

## Project layout

```
MoneyFit-app/
  app/                       every screen — expo-router, so the file tree is the routes
    _layout.tsx              migrations, settings, theme, the PDF bridge, the greeting
                             gate, and the "database unavailable" card
    (tabs)/                  the five tabs
    more.tsx                 Year · Profile · Ask · Insights · Settings
    bill/ goal/ holding/     new, edit, detail, and the bill scanner
    statement/               the batch list and the review screen
    welcome.tsx              the greeting — dark in both themes, outside the shell
    year.tsx ask.tsx insights.tsx profile.tsx settings.tsx
  src/
    db/                      schema, the eleven views, the migration ladder
    lib/                     db access, queries, actions, files, secrets, backup
    lib/ai/                  the Gemini client, its JSON-schema translator, receipt
                             extraction, and Ask's SQL generation and validation
    lib/statement/           the CSV and PDF importer — no AI involved
    lib/analytics/           insights, goal coaching, forecasting, subscription
                             detection — all of it arithmetic
    theme/                   the two palettes and the provider
    components/              Icon, charts, ui, form, and the seven form components
  assets/pdfjs/              pdf.js, written here by postinstall — gitignored
  scripts/bundle-pdfjs.mjs   what writes it
  app.json                   everything native: name, package, icons, permissions
  eas.json                   cloud build profiles
```

Two conventions worth knowing before editing:

- **`src/lib/*.ts` uses relative imports** (`./db`, `../db/migrations`); `src/lib/actions/*`
  and everything under `app/` uses the `@/` alias. `@/` maps to `src/` only.
- **Typed routes are on.** A `href` naming a file that does not exist is a compile error
  rather than a dead button, which is deliberate.

---

## What is deliberately different from the web app

Everything the web app does, it does. Almost all of the differences below are the same
thing in a different shape, forced by the platform, and each one is documented at the top
of the file it affects. **Three are not** — they are places this app deliberately does
something the web app does not, and they are marked ⚑.

| | Web | Here | Why |
|---|---|---|---|
| Navigation | ten sidebar links | five tabs + a **More** screen with five | Ten bottom tabs is not a thing. The tab set is one array in one file. |
| Data | Postgres 17 in Docker | SQLite in the app | No server to run. The SQL was translated statement by statement. |
| Reads | Server Components | `useLive(load)` | A version counter replaces `revalidatePath`; every action still ends in `refreshAll()`. |
| AI transport | raw `fetch` to Gemini | raw `fetch` to Gemini | The same client, ported. Same endpoint, same `x-goog-api-key` header, same `temperature: 0` and JSON response mode. What differs is the schema dialect's generator and where the key comes from. |
| ⚑ Camera bill scan | **removed** | **kept**, on Gemini vision | It is the one feature a phone has and a desktop does not, and a key is already configured for Ask. It is why `bills.source` still exists here. |
| ⚑ `bills.source` | dropped — with no AI it could only say `'manual'` | kept | The scan still writes `'ai'`, so the column is still information. (Dropping it would also have meant rebuilding the table, and `DROP TABLE bills` with foreign keys on would cascade every attachment away.) |
| ⚑ PDF text layer | `pdfjs-dist` on the server | bundled pdf.js in an off-screen WebView | React Native has no DOM and pdf.js needs one. The asset is bundled, never fetched. See below. |
| Insights & goal coaching | computed, no model | computed, no model | Same change, same files, ported. Named here only because an older README of this folder called them AI features. |
| `/ask` isolation | a read-only Postgres role | the four barriers above | SQLite has no roles and no `GRANT`. |
| Ask's answer shape | question, SQL, rows | and the model's assumptions and a chart it asked for | Already true before this migration and kept on purpose. Dropping it to match would be a downgrade dressed as parity. |
| Settings' Saved chip | clears on any keystroke | clears on the next save | React Native has no DOM event bubbling to notice the keystroke. |
| Attachments | `/api/attachments/[id]` | read straight off disk, still by id | No HTTP server to route through. |
| Theme toggle | a corner form posting to an action | a header icon button | There is no `<form>` in a phone header. The three-way control in Settings is unchanged. |
| Welcome screen | `/welcome`, gated by a session cookie and `middleware.ts` | `app/welcome.tsx`, gated by a module flag and an effect in `app/_layout.tsx` | The web's cookie has no `maxAge`, so it lasts the browser session and that *is* the mechanism. A module-level `let` lasts the app process, which is the same span. The three functions around it — `welcomeCookieOptions`, `isSecureOrigin`, `safeNext` — have nothing to do here, and `src/lib/welcome.ts` names each absence; `safeNext` is the interesting one, because "where you were going" is the navigation stack rather than a string anyone can supply. |
| Reminders | none | none | Recurring bills, no notifications — as scoped. |

### The WebView, since it is the one thing here with no equivalent anywhere else

`table.ts` reconstructs a statement's columns from where the glyphs sit on the page, so
what it needs from a PDF is **positioned glyphs** — each with its `x`, its `right` and its
`y` — and not flattened text. Flattening would silently destroy the importer rather than
break it, which is the worst failure mode available.

pdf.js is the only thing that produces that, and it needs a DOM. So there is a single
`<WebView>` mounted off-screen for the life of the app, loading a local HTML shim and
bundled pdf.js 3.11.174 from `assets/pdfjs/`. The PDF goes in as base64 with an id, the
glyphs come back as JSON with the same id, and a promise keyed on that id resolves — so
two imports cannot cross. It is mounted always rather than on demand, because mounting on
demand races the first message.

Three things about it are deliberate and worth not undoing:

- **`originWhitelist={[]}`** and no network permission the asset does not need. pdf.js is
  bundled precisely so this app never fetches it; `/ask` and the camera scan are the only
  outbound features and both are off until you add a key.
- **pdf.js is pinned to the 3.x line**, the last with a UMD build — a classic script that
  assigns `window.pdfjsLib`, which is what the shim evaluates and looks for. 4.x and later
  are ES-modules-only, and a module script in a document with no real origin has to load
  through a blob URL, where fetch rules treat an opaque origin as grounds to refuse.
  Moving off the pin means rewriting the shim's loader, not bumping a number.
- **About 6 MB is the cap** (8 million base64 characters), checked before anything is
  posted. The bridge is a string channel, and a 20 MB PDF is 27 MB of characters to
  serialise across it; a statement with a text layer is a few hundred kilobytes. Over the
  cap it says so instead of hanging.

**This is the only part of the migration that cannot be checked by reading.** Everything
else here is TypeScript against types that exist in the same folder; this is a message
protocol between two JavaScript contexts. It is wrapped in a timeout and fails with a
plain sentence for that reason — and CSV import shares none of this path, so if the PDF
route is broken the importer is still usable while it is fixed.

Two smaller, intentional edits: `today()` is computed from local date parts rather than
by slicing an ISO string, so it cannot be a day off in your timezone; and ring animation
sits behind a single `ANIMATE_RINGS` constant in `src/theme/tokens.ts`, so if it
misbehaves on your device, one `false` gives you static rings and changes nothing else.

---

## Status

Complete, and unverified. Those are both true and neither should be softened.

**Complete** means every screen, every chart, every calculation, the statement importer,
the year view, Ask's persisted thread, the two AI features, the eleven analytics views,
the sample data generator, the first-run welcome screen, and the backup that the web app
does not have. There are no stubs and no "coming soon" screens, and nothing on the web
side is missing here — the table above lists what is *different*, and every row of it says
why.

It is also **caught up**. This folder was first written against a snapshot of the web app
that no longer exists, and the web app has since dropped Anthropic, replaced two model
calls with arithmetic, gained a 2,200-line statement importer and a year view, rebuilt Ask
on Gemini, and had a dark-palette legibility pass. All of that has been brought across,
file by file, with the divergences listed above and nowhere else.

**Unverified** means exactly this:

- **No compiler has seen it.** `tsc --noEmit` needs Node, which the authoring machine
  does not have. `npm run typecheck` is the one real gate and it has never been run.
- **No emulator has run it.** Nothing in this folder has rendered on a screen.
- **There are no tests**, because the web app has none either — the whole project's gate
  has always been the type-checker plus walking the app.

What stands in for that: every file was written against the actual types it consumes, and
each one was re-read against them afterwards. That is how the web app's build errors were
found before they reached a build. It caught real bugs here too — the last one was a
function that returns an array being destructured as if it returned an object. But review
is not compilation, and the honest expectation is that `npm run typecheck` will print
something on the first run.

So:

```bash
npm install
npm run typecheck
```

and send me the output. Then run it through Expo Go and tell me what looks wrong. Both of
those are fast, and together they are the whole remaining gap between this folder and a
working app.

---

## Troubleshooting

**`npm install` fails with a certificate error** — see
[Behind a corporate proxy](#behind-a-corporate-proxy-zscaler). Do not disable TLS
verification.

**`npm install` is unbearably slow, or OneDrive shows thousands of pending files** —
`node_modules/` is tens of thousands of small files and this folder is inside OneDrive.
It is in `.gitignore`, but git and OneDrive are different things. Right-click the folder
→ **Free up space**, or exclude `MoneyFit-app` from sync in the OneDrive settings. The
same goes for `android/` and `.expo/`.

**Gradle complains it cannot find Node, or the bundle step fails in Android Studio** —
Node 22+ must be on the `PATH` that Android Studio inherits. Install it, then restart
Android Studio (not just the terminal).

**Metro cannot resolve `@/something`** — the alias comes from `tsconfig.json` plus
`experiments.tsconfigPaths` in `app.json`. Clear the cache: `npx expo start --clear`.

**A dependency version warning after `npm install`** — `npm run fix-deps` runs
`expo install --fix`, which pins every Expo package to the version that matches the SDK.

**The app opens on a card saying the database is unavailable** — that card is doing its
job: a migration or a query failed and it caught it instead of showing a blank screen.
The detail line under it names the actual error. **Retry** re-runs the migration.

**A single screen shows that card and the rest of the app works** — then the problem is
one query, not the database. Every screen is wrapped separately for exactly this reason.
Tell me which screen and what the detail line says.

**Ask or the bill scanner says it is not configured** — no key is stored. Settings →
Gemini API key. Insights and Goals never say this, because neither needs a key.

**An AI feature shows an error instead** — the message is the real one from the API:
400 or 403 means the key is wrong or not enabled for this model, 429 means rate limited,
404 means the model name is not available to that key, and a connection error means the
phone could not reach `generativelanguage.googleapis.com`.

**PDF statement import says pdf.js is missing** — `assets/pdfjs/` holds the two
placeholder files rather than the real ones, which is what a clone without
devDependencies looks like. Run `npm install` and then `npm run bundle-pdfjs`. CSV import
is unaffected either way.

**A PDF statement is refused as having no text layer** — then it is a scan or a
photograph, and there is nothing to read. This is a refusal and not a failure: there is no
OCR here, and guessing at pixels would put wrong amounts in your journal. Most banks will
issue the same statement as CSV.

**Everything is empty on a fresh install** — it should be. Settings → Sample data.
