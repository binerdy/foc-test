# 🎼 Rehearsal Planner

A frontend-only web app that organises players into concurrent rehearsal groups so that
as few players as possible sit around doing nothing.

## What it does

- **Projects** — create a project, rename it any time.
- **Players** — add players by first name.
- **Pieces** — add pieces by name.
- **Bulk paste** — copy a column or row of names in Excel/Google Sheets and paste it
  into the add field (or use the "Paste list" button) to add many players or pieces at
  once; duplicates are skipped automatically.
- **Assignments** — assign players to pieces from either side (pick a piece and tick
  players, or pick a player and tick pieces), plus a combined player × piece matrix
  view where every assignment is visible and toggleable at a glance.
- **Configuration sets** — a Configuration tab holds reusable sets. The built-in
  Instruments set ships with vl/vla/c/db/h/hsch/ob/fl/cl and can be extended; further
  sets can be created freely.
- **Seating per piece** — click a piece to open its detail page and give each assigned
  player an instrument, section and position for that piece (all optional, and they may
  differ from piece to piece). Positions are unique within a piece — conflicts are
  rejected with an inline error. Click a player to see and edit the same data from the
  player's perspective across all their pieces. Seating appears in the Excel export as
  e.g. `Anna (vl 1.2)`.
- **Day plan** — the scheduler's main tool: distributes every selected piece over the
  whole day (sessions × venues slots, e.g. 7 × 4 = 28 pieces) so that no session
  contains two pieces sharing a player. Exact backtracking search with a node budget
  and a balancing pass; when a full placement is impossible the unplaced pieces are
  listed together with the reason (e.g. a player who plays in more pieces than the day
  has sessions). Sessions are labelled morning/afternoon, reviewable like single
  combinations, re-shuffleable, and downloadable as a whole-day Excel plan.
- **Day plan review & export** — one page showing the whole day: every session with
  its venues (venue numbers freely swappable within a session), every player's
  instrument/section/position editable inline with missing data highlighted, an
  activity text per idle player (self study, coaching, …), and a one-click Excel
  download of the reviewed plan.
- **Settings** — number of venues (default 4), session duration (default 50 min,
  including the 10 min break), sessions per morning (default 4) and afternoon
  (default 3). Since every rehearsal block has the same length, piece duration is
  irrelevant to the planning.

## Saving and loading

No backend. In Chrome/Edge you can **connect a folder on your computer** (File System
Access API, like vscode.dev) and save/load project JSON files there; the folder is
remembered across reloads. On iPhone/iPad — where no browser offers that API — Save
opens the **share sheet** with the project file so "Save to Files" can place it in any
folder in iCloud Drive or On My iPhone, and Open loads it back from the Files app; a
"Files?" button explains this in-app. Other browsers download the file on Save and use
a file picker on Open. The current project is also autosaved to `localStorage` so a
page reload never loses work.

Because some browsers (notably iOS Safari) purge site storage under pressure or after
about a week without a visit, every autosave is additionally mirrored to IndexedDB,
and the app silently restores the project from that mirror when localStorage comes up
empty. Browser storage is still not permanent — saving the project file to disk is the
only guaranteed persistence, so the Save button shows a dot while there are unsaved
changes, New/Open ask before discarding them, and closing the tab warns as well.

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # type-check + production build into dist/
```

## Deployment

Made for Netlify — `netlify.toml` builds with `npm run build` and publishes `dist/`.
Just connect the repository to a Netlify site; no configuration needed.

## Tech

Vite + React + TypeScript, [SheetJS](https://sheetjs.com/) for the Excel export.
No server, no database, no accounts.
