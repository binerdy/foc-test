# 🎼 Rehearsal Planner

A frontend-only web app that organises players into concurrent rehearsal groups so that
as few players as possible sit around doing nothing.

## What it does

- **Projects** — create a project, rename it any time.
- **Players** — add players by first name.
- **Pieces** — add pieces by name.
- **Assignments** — assign players to pieces from either side (pick a piece and tick
  players, or pick a player and tick pieces), plus a combined player × piece matrix
  view where every assignment is visible and toggleable at a glance.
- **Scheduler** — select any set of pieces and get **every combination of pieces that
  can rehearse concurrently without a player being needed in two venues at once**,
  capped at the number of venues, ordered by the number of players utilised (most
  first). Each combination also lists the idle players so they can be given self-study
  or coaching tasks. A "full groupings only" filter hides combinations to which another
  selected piece could still be added.
- **Excel export** — tick any number of combinations and download them as an `.xlsx`
  file (overview, per-piece detail, and the full assignment matrix).
- **Settings** — number of venues (default 4), session duration (default 50 min,
  including the 10 min break), sessions per morning (default 4) and afternoon
  (default 3). Since every rehearsal block has the same length, piece duration is
  irrelevant to the planning.

## Saving and loading

No backend. In Chrome/Edge you can **connect a folder on your computer** (File System
Access API, like vscode.dev) and save/load project JSON files there; the folder is
remembered across reloads. In other browsers, Save downloads the project file and Open
uses a file picker. The current project is also autosaved to `localStorage` so a page
reload never loses work.

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
