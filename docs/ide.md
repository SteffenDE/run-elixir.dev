---
kind: reference
status: live
last_updated: 2026-10-13
---

# The Phoenix IDE (`playground/phoenix`)

A React app built with Vite. It uses TypeScript, plain CSS with light and
dark tokens, oxlint and oxfmt. Its libraries are `@pierre/trees`,
`@pierre/diffs`, `@base-ui/react`, `react-resizable-panels`, `zustand`, Remix
Icon, xterm.js, PGlite and `tailwindcss`. Versions are exact in
`package.json`; `package-lock.json` is committed.

```sh
cd playground/phoenix
npm ci && npm run build      # tsc --noEmit && vite build → dist/
npm run lint                 # oxlint src
npm run format               # oxfmt src
```

`build.py` runs the build in Docker. There are two entries:

- `index.html`: the IDE;
- `preview.html`: the preview in its own window.

Assets go under `_playground/`, because the app in the preview owns
`/assets/`.

## Layout

| Source | Role |
| --- | --- |
| `src/playground.ts` | The nodes. Starts PGlite, the shared `Files`, the bridge and the first shell, which runs `iex -S mix phx.server`. Opens and closes shells; routes preview requests to the node listening on 4000; reads, saves and reacts to changes. `window.playground` exposes it for tests. |
| `src/store.ts` | zustand state: status, tree paths, editor tabs, preview, terminals. |
| `src/App.tsx` | Top bar and resizable panels: tree, then editor over terminals, then preview. |
| `components/FileTreePanel.tsx` | `@pierre/trees` over `/work`, without `_build`, `deps`, `.mix`, `.git`, …; follows changes with adds and removes. Selecting a file opens it. |
| `components/Editor.tsx` | Tabs (Base UI) of open files; `@pierre/diffs` `File` in edit mode, one editor per tab, keyed by path. ⌘S / Ctrl+S saves. A clean tab follows the node's changes. |
| `components/Terminals.tsx`, `TerminalPanel.tsx` | Terminal tabs: "Server" (the first shell) and "+" for more, each a node of its own over the same files. |
| `components/Preview.tsx`, `PreviewFrame.tsx`, `src/preview.tsx` | The preview, docked or popped out. |
| `src/programs/tailwind.ts`, `modules.ts` | Tailwind on the page. |
| `src/languages/` | Elixir and HEEx grammars. |
| `src/runtime.d.ts` | Types for the runtime's JavaScript. |

## Editing and saving

Saving writes through `Files` and tells the Tailwind watcher. The preview
reloads where it is, and Phoenix's code reloader compiles the change on that
request. Changes the nodes make, from mix tasks, generators or compiles,
come from `files.js`. They refresh the tree, reload unedited tabs and wake
the watcher.

Pierre's editor owns the text while a tab is open. The `file` prop changes
only when the file is (re)loaded, and `editStateKey` keeps undo history
across tab switches. A file opens at line 1.

Highlighting:

- **Elixir and HEEx:** the grammars from expert-lsp's vscode-expert v0.6.0
  (`elixir.json`, Apache-2.0) and phoenixframework's vscode-phoenix v0.1.3
  (`heex.json`, `elixir-heex.json` for `~H`, MIT), vendored unchanged and
  registered with `registerCustomLanguage`.
- **Everything else:** Shiki's grammars.

## Tailwind on the page

The app's dev config keeps its tailwind watcher (`--watch`). The node spawns
`_build/tailwind-linux-x64-4.3.3`, and the worker forwards the spawn to the
page, where `programs/tailwind.ts` is the CLI:

- **Options:** `--input`, `--output`, `--watch`, and `--help` (the Hex
  package's version check), over `tailwindcss` 4.3.3's `compile()`.
- **Stylesheets and plugins** come from the node's files. Paths resolve
  relative to their base, then through `NODE_PATH` (deps and the build path,
  as the Hex package sets it).
- **Plugins** are the app's CommonJS files (`vendor/heroicons.js`, daisyUI's
  bundle), run with a `path` and an `fs` that fault files in. A sync read of
  something not yet fetched throws, the directory is fetched, and the build
  runs again.
- **Candidates** come from the `@source` directories, split on whitespace,
  quotes and brackets; over-collecting does no harm.
- **Watch mode** rebuilds 50 ms after a change to a source, the input or
  anything it loaded: 60–130 ms for the default app, 450–650 ms for the
  first build. The preview reloads its stylesheets in place, without a page
  reload.

esbuild does not run on the page yet; the app's JavaScript is prebuilt.

## The preview

`PreviewFrame` is an iframe with a path bar. Navigating and reloading are
separate signals: a reload stays where the preview is, while navigating goes
to the path typed. "Pop out" opens `preview.html` in its own window. The IDE
gives the preview's width to the editor until that window closes (or "Dock
preview"). Reloads and new CSS reach it over the `playground-preview`
BroadcastChannel.

Inside the iframe, LiveView long-polls (the bridge removes `WebSocket`).

## Terminals

Each tab is a node in its own worker (`playground.ts` sessions). Output is
kept per session (200 KB), so a terminal replays it when it mounts.
Terminals stay mounted while hidden.

- **Server.** The first tab can't be closed; "Restart server" interrupts it
  and types `cd /work/playground` and `iex -S mix phx.server` again.
- **Server state** comes from whether a node listens on port 4000.
