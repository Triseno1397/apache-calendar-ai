# Apache Calendar AI

A Google Apps Script automation for **Apache Rental Group**. It scans the shared
Gmail inbox **apachecalender@gmail.com** twice a day, uses the Anthropic (Claude)
API to read each new or changed order email thread, and writes neat, color-coded
**drop-off / pick-up** events onto that account's Google Calendar — updating
events when threads change, never duplicating, and marking missing details as
`TBD`.

It runs on Google's servers via time-based triggers, so nothing needs to stay
open on a laptop.

## How it works

- A Gmail filter labels incoming order mail **`Orders`**.
- Twice a day (7 AM & 10 PM project time) the trigger fires `processOrderEmails()`.
- For each labeled thread, per-thread state (in `PropertiesService`) tracks the
  message count + the event IDs it created. **Unchanged threads cost nothing** —
  Claude is only called when a thread is new or has a new reply.
- Claude returns minified JSON (show name, venue, drop-off / pick-up date+time,
  notes). The script creates or **updates** the matching calendar events.
- Same job name → consistent color (drop-off + pick-up share it). Same-day
  duplicates of a job collapse onto one event.
- As long as a thread has a **job name and at least one date** (drop-off or
  pick-up), the events go straight onto the calendar — missing times, venue, or
  other details just show as `TBD`. Only when the **name or the date can't be
  determined** is the thread labeled **`Orders/Review`** until the info arrives,
  then re-processed automatically.

## File layout

```
appsscript.json     Apps Script manifest (timezone, OAuth scopes, V8 runtime)
src/Code.gs         All the automation logic + test helpers
.claspignore        Restricts `clasp push` to the manifest + src/
.gitignore          Keeps .clasp.json (your scriptId) out of git
package.json         npm scripts for the clasp workflow
```

## Configuration (top of `src/Code.gs`)

| Key | Default | Notes |
| --- | --- | --- |
| `SOURCE_LABEL` | `Orders` | Gmail label the script processes |
| `REVIEW_LABEL` | `Orders/Review` | Flagged when dates can't be determined yet |
| `CALENDAR_ID` | `primary` | Leave as `primary` for the dedicated account |
| `MODEL` | `claude-sonnet-4-6` | `claude-haiku-4-5-20251001` = cheaper/faster; `claude-opus-4-8` = highest accuracy |
| `RUN_HOURS` | `[7, 22]` | Trigger hours (24h, project timezone) |
| `MAX_THREADS_PER_RUN` | `100` | Covers recent/active threads |
| `MAX_THREAD_CHARS` | `18000` | Trims very long threads to control cost |

---

## Deployment

### Done in this workspace (no Google login required)
- `appsscript.json` and `src/Code.gs` created with the exact intended contents.
- `.claspignore` / `.gitignore` / `package.json` added so `clasp push` uploads
  only the manifest + source, and `.clasp.json` stays out of git.
- Git repository initialized with an initial commit.

### You must do these (they require your Google account)

> Log in as **apachecalender@gmail.com** — NOT a personal account. Whatever
> account you authenticate `clasp` with is where the automation lives.

1. **Install clasp** (if not already): `npm install -g @google/clasp`
2. **Enable the Apps Script API**: open
   <https://script.google.com/home/usersettings> and toggle the Apps Script API
   **ON**.
3. **Log in**: `clasp login` → sign in as **apachecalender@gmail.com**.
4. **Create the project**: `clasp create --type standalone --title "Apache Calendar AI" --rootDir .`
   (or `npm run create`). This generates `.clasp.json` (already git-ignored).
5. **Push & open**: `clasp push` then `clasp open-script` (or `npm run push` /
   `npm run open`). *(clasp v3 renamed `clasp open` → `clasp open-script`.)*

## Post-deploy checklist (inside your Google account)

- [ ] Apps Script editor → **Project Settings → Script Properties** → add
      `ANTHROPIC_API_KEY` = your key from <https://console.anthropic.com>
      (with billing enabled).
- [ ] Confirm the project timezone is **America/Los_Angeles**
      (Project Settings).
- [ ] Gmail (apachecalender@gmail.com) → **Settings → Filters** → create a filter
      that applies the **`Orders`** label to incoming order mail.
- [ ] Google Calendar for that account → share with the company
      (*See all event details* for crew, *Make changes* for leads).
      `CALENDAR_ID` stays `primary` since this is a dedicated account.
- [ ] Have the team forward / CC client order emails to apachecalender@gmail.com.
- [ ] Run `setup()` once in the editor and approve the Google permission screen.
- [ ] Run `testApi()` and check the log for clean JSON.
- [ ] Run `testRun()` on a real order and confirm an event appears on the calendar.

## Test helpers (run from the Apps Script editor)

| Function | What it does |
| --- | --- |
| `setup()` | One-time: creates labels + installs the daily triggers (approve OAuth) |
| `testApi()` | Confirms your API key + model string work end-to-end |
| `testRun()` | Forces an immediate pass right now (urgent same-day orders) |
| `resetState()` | **DANGER** — wipes per-thread memory so everything reparses next run |
