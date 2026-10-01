# MoneyFit for Android

The MoneyFit web app, as a phone app. Same three rings, same bill journal, same goal
pace maths, same XIRR, same four AI features — running on SQLite inside the app instead
of Postgres inside Docker, so it works with no server, no network and no account.

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

Five bottom tabs, four screens behind the header button, and sixteen pushed screens.

| Tab | What is on it |
|---|---|
| **Home** | The three concentric rings — spend against budget, goal funding, investing — plus the month's cashflow, budget status, upcoming bills, goal pace, net worth and a twelve-month trend. |
| **Journal** | Every bill, grouped by day, filterable by status. Add one by hand, duplicate it, or photograph it and let the model read it. Images and PDFs attach and open. |
| **Track** | Budgets per category, daily burn-down against pace, month-on-month movement, the largest expenses, statistical subscription detection, and forecasts. |
| **Goals** | Target, deadline, contributions, and a pace chip that says *ahead* / *on track* / *behind* / *at risk* with the monthly figure needed to fix it. AI coaching across all goals. |
| **Invest** | Holdings and liabilities, manual valuation snapshots, XIRR per holding and overall, allocation, contribution-vs-growth attribution, drawdown. |

Behind the header button (**More**): **Profile** (net worth, assets, liabilities,
lifetime totals), **Ask** (a question in plain English, answered by generated SQL over
read-only views), **Insights** (spending narrative and anomalies), **Settings**.

Everything is in ₹ with lakh/crore grouping, and every amount is stored as integer paise
and only formatted at the edge — so nothing rounds twice.

### The AI features

Four, all of them from the web app, all of them optional:

1. **Bill scanning** — photograph or pick a receipt or PDF invoice and the fields come
   back filled in for you to check.
2. **Insights** — a short written read of the month's spending, plus anomaly flags.
3. **Ask** — your question becomes SQL, the SQL runs locally, and the model never sees
   the results. So no figure on that screen can be invented.
4. **Goal coaching** — a verdict across all goals, with concrete levers.

Without a key the app behaves exactly as the web app does with `ANTHROPIC_API_KEY`
unset: those four places show a short "not configured" card and everything else works.

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

---

## Behind a corporate proxy (Zscaler)

`npm install` will fail with `SELF_SIGNED_CERT_IN_CHAIN` or `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
on a GE laptop, because Zscaler re-signs TLS traffic with its own root and npm does not
trust it. The web app hit this and the fix is already sitting next to this folder:

```bash
npm config set cafile "C:\Users\270003127.AEROAD\OneDrive - GE Aerospace\Desktop\Finance\certs\ca-bundle.crt"
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
9. **The theme button** in the header — light, dark, and whatever the phone is set to.
10. **Force-quit and reopen** — this proves SQLite persisted rather than the data living
    in memory.
11. **Settings → Backup → Export** — then clear everything, import the file back, and
    check your bills return.

Then, if you want the AI features, add a key (below) and try **Scan** on a real receipt.

When you are done looking, **Settings → Clear everything** removes the sample data and
leaves your categories, targets and theme in place.

---

## The AI key

The web app read `ANTHROPIC_API_KEY` from `.env` on the server. A phone has no server and
no `.env`, so the key is typed in once:

**More → Settings → Anthropic API key.**

Get one from <https://console.anthropic.com>. It is stored with
[`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/) — on Android
that is SharedPreferences encrypted with a key held in the Android Keystore.

Four properties of how that is handled, since it is the one secret in the app:

- **It is never in the source and never in the build.** There is no key in this folder,
  `.env` is gitignored, and nothing bundles one.
- **It cannot be read back.** Once stored, Settings shows only a mask (`sk-ant-…a1b2`) —
  enough to tell "a key is set" from "the wrong key is set", useless to anyone looking
  over your shoulder. The field is empty on every visit.
- **Saving an empty field is an error, not a delete**, precisely because the field is
  always empty — a stray tap on Save must not silently throw away a working key.
  Removing one is its own button.
- **No error message can contain it.** `src/lib/secrets.ts` is the only module that
  touches the value; it never logs it and never echoes it into a message.

The key goes to `api.anthropic.com` and nowhere else. Requests cost money against your
own account; results are cached in the database so the same screen does not pay twice.

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

Ids are preserved, so a restored contribution lands on the goal it belonged to. Eleven
of the twelve tables travel; the AI response cache does not, because one API call
rebuilds it and caching it would mean serving commentary about the old numbers as if it
described the new ones.

---

## How the data is stored

One SQLite database, `moneyfit.db`, in the app's private storage. Twelve tables, eleven
analytics views, a `PRAGMA user_version` migration ladder, WAL journaling, and foreign
keys on.

**There is no sync.** This phone is the authority for its own data; the Docker web app is
the authority for its. The JSON backup above is the bridge between them, in one
direction at a time.

Money is stored as integer paise in `*_minor` columns and formatted only for display.
Dates are `TEXT` in `YYYY-MM-DD`. Attachments are copied into the app's document
directory under a name made from a fresh UUID and the file's *declared* MIME type — never
from the name the picker reported — so a file called `../../etc/passwd` is stored as
`<uuid>.png` with its original name kept as an inert label.

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
    _layout.tsx              migrations, settings, theme, and the "database unavailable" card
    (tabs)/                  the five tabs
    more.tsx                 Profile · Ask · Insights · Settings
    bill/ goal/ holding/     new, edit, detail, and the bill scanner
  src/
    db/                      schema, the eleven views, the migration ladder
    lib/                     db access, queries, actions, files, secrets, backup
    lib/ai/                  the Anthropic client, the four features, SQL validation
    lib/analytics/           forecasting and subscription detection — no AI involved
    theme/                   the two palettes and the provider
    components/              Icon, charts, ui, form, and the seven form components
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

Everything the web app does, it does. These are the places where doing the same thing
needed a different shape, and each one is also documented at the top of the file it
affects.

| | Web | Here | Why |
|---|---|---|---|
| Navigation | nine sidebar links | five tabs + a **More** screen | Nine bottom tabs is not a thing. The tab set is one array in one file. |
| Data | Postgres 17 in Docker | SQLite in the app | No server to run. The SQL was translated statement by statement. |
| Reads | Server Components | `useLive(load)` | A version counter replaces `revalidatePath`; every action still ends in `refreshAll()`. |
| AI transport | `@anthropic-ai/sdk` | raw `fetch` | The SDK's own requirements say React Native is not supported. Every prompt and schema is unchanged. |
| `/ask` isolation | a read-only Postgres role | the four barriers above | SQLite has no roles and no `GRANT`. |
| Settings' Saved chip | clears on any keystroke | clears on the next save | React Native has no DOM event bubbling to notice the keystroke. |
| Attachments | `/api/attachments/[id]` | read straight off disk, still by id | No HTTP server to route through. |
| Theme toggle | a corner form posting to an action | a header icon button | There is no `<form>` in a phone header. The three-way control in Settings is unchanged. |
| Reminders | none | none | Recurring bills, no notifications — as scoped. |

Two smaller, intentional edits: `today()` is computed from local date parts rather than
by slicing an ISO string, so it cannot be a day off in your timezone; and ring animation
sits behind a single `ANIMATE_RINGS` constant in `src/theme/tokens.ts`, so if it
misbehaves on your device, one `false` gives you static rings and changes nothing else.

---

## Status

Complete, and unverified. Those are both true and neither should be softened.

**Complete** means all twelve phases of the plan are built: every screen, every chart,
every calculation, all four AI features, the eleven analytics views, the sample data
generator, and the backup that the web app does not have. There are no stubs and no
"coming soon" screens.

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

**An AI feature says it is not configured** — no key is stored. Settings → Anthropic API
key.

**An AI feature shows an error instead** — the message is the real one from the API:
401 means the key is wrong, 429 means rate limited, a connection error means the phone
could not reach `api.anthropic.com`.

**Everything is empty on a fresh install** — it should be. Settings → Sample data.
