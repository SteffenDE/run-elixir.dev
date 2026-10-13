---
kind: reference
status: live
last_updated: 2026-10-13
---

# The app (`playground/app`)

A React app built with Vite. It uses TypeScript, plain CSS with light and
dark tokens, oxlint and oxfmt. Its libraries are `@pierre/trees`,
`@pierre/diffs`, `@base-ui/react`, `react-resizable-panels`, `zustand`,
Dexie, Remix Icon, xterm.js (with its fit and web-links addons), PGlite and
`tailwindcss`. Versions are exact in `package.json`; `package-lock.json` is
committed. The layout follows tc's: `src/home`, `src/project` and
`src/shared`, each with `components/` and `lib/`; imports use `@/` for
`src/` and `@runtime/` for `playground/runtime`.

```sh
cd playground/app
npm ci && npm run build      # tsc --noEmit && vite build → dist/
npm run lint                 # oxlint src test
npm run format               # oxfmt src test
```

`build.py` runs the build in Docker. There are two entries:

- `index.html`: every route (`src/main.tsx` picks the page by path);
- `preview.html`: a project's preview in its own window.

Assets go under `/_playground/`, because the app in the preview owns
`/assets/`. The base is `/`: the page is served at every project's path.

## Layout

| Source | Role |
| --- | --- |
| `src/main.tsx` | Routes ([projects.md](projects.md#kinds-and-urls)); takes the project's lock or offers to take it over. |
| `home/components/HomePage.tsx` | New projects, and the projects in this browser, with delete. |
| `shared/lib/projects.ts`, `storage.ts`, `lock.ts` | The projects table (Dexie), where a project keeps its state and deleting it, one tab per project. |
| `project/lib/kinds.ts` | What each kind starts with: boot images, template, directory, first command, preview. |
| `project/lib/playground.ts` | The nodes. Starts the shared `Files` (with the project's store), the bridge and the first shell; PGlite on the first connection. Opens and closes shells; routes the preview's requests to the node listening on its port; reads, saves and reacts to changes; opens files at a line. `window.playground` exposes it for tests. |
| `project/lib/store.ts` | zustand state: status, tree paths, editor tabs, preview, terminals. |
| `project/components/NarrowWorkspace.tsx`, `shared/lib/narrow.ts` | Phones and windows up to 720 px wide: one pane at a time (files, editor, terminal, preview), chosen in a bar at the bottom; all stay mounted. Opening a file shows the editor, following an address the preview; a Phoenix project opens on its preview. The top bar keeps a home icon, the name, the spinner and the restart icon. |
| `project/components/ProjectPage.tsx` | Top bar (name, kind, status, restart) and resizable panels: tree, then editor over terminals, then the preview while there is one. The tree and the editor are collapsible; the terminals' maximize button collapses or shows both (a temporary IEx starts maximized; a terminal's file link shows them). |
| `project/components/FileTreePanel.tsx` | `@pierre/trees` over `/work`, without `_build`, `deps`, `.mix`, `.git`, …; follows changes with adds and removes (against the model, which also changes itself). Selecting a file opens it. New file and New folder in its header; a context menu (right-click, or a row's button; a popover in the top layer) to make, rename and delete; dragging moves. New entries are named in place (`startRenaming`). `.ex` and `.exs` get an Elixir drop from a sprite sheet. |
| `project/components/Editor.tsx` | Tabs (Base UI) of open files; `@pierre/diffs` `File` in edit mode, one editor per tab, keyed by path. ⌘S / Ctrl+S saves. A clean tab follows the node's changes. |
| `project/components/Terminals.tsx`, `TerminalPanel.tsx`, `lib/terminal-handle.ts`, `lib/terminal-links.ts` | Terminal tabs, each a node of its own over the same files, and their xterm terminals and links. |
| `project/components/Preview.tsx`, `PreviewFrame.tsx`, `project/preview.tsx` | The preview, docked or popped out. |
## Editing and saving

Saving writes through `Files` (which keeps it, [projects.md](projects.md#what-is-kept))
and tells the Tailwind watcher. While a server runs, the preview reloads
where it is, and Phoenix's code reloader compiles the change on that
request. Changes the nodes make, from mix tasks, generators or compiles,
come from `files.js`. They refresh the tree, reload unedited tabs and wake
the watcher.

Pierre's editor owns the text while a tab is open. The `file` prop changes
only when the file is (re)loaded, and `editStateKey` keeps undo history
across tab switches. A file opens at line 1, or at the line a terminal's
link names; following another link into an open tab moves its caret. A
file opened from the tree leaves focus there. ⌘S (Apple systems) or
Ctrl+S saves; the empty editor shows the keys, and in a Phoenix project
that the preview reloads.

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

`PreviewFrame` is an iframe with a path bar. It shows from the start in a
Phoenix project, and in others once a node listens on a port. Navigating and
reloading are separate signals: a reload stays where the preview is, while
navigating goes to the path typed. "Pop out" opens `/preview.html` in its
own window, with the project's key in its URL. The IDE gives the preview's
width to the editor until that window closes (or "Dock preview"). Reloads
and new CSS reach it over the BroadcastChannel `playground-preview:KEY`,
one per project.

Inside the iframe, LiveView connects over the bridge's WebSocket
([runtime.md](runtime.md#the-preview-swjs-bridgejs)).

## Terminals

Each tab is a node in its own worker (`playground.ts` sessions). Output is
kept per session (200 KB). A shell's xterm terminal is a `TerminalHandle`
(`terminal-handle.ts`, after tc's): it lives until the shell closes and
attaches to whichever panel shows it.

- **Fitting.** xterm opens in an unpadded element inside a padded root: the
  fit addon counts its parent's padding as room. A resize to nothing (a
  hidden tab) is skipped; showing the tab fits it.
- **Focus.** A terminal takes focus when it shows, unless the user is in
  something else (renaming, the editor).
- **Links** (`terminal-links.ts`):
  - a source location (`lib/foo.ex:12`, `/work/x/mix.exs:3:5`) naming a
    file below the shell's directory or `/work` opens in the editor at
    that line;
  - `localhost:PORT/path` (and `127.0.0.1`, `0.0.0.0`), with or without
    `http://`, opens in the preview;
  - other web links open in a new tab.
- **The first tab** runs what the kind starts with and can't be closed. In
  a Phoenix project it is "Server"; "Restart server" interrupts it and
  types `cd /work/playground` and `iex -S mix phx.server` again.
- **Server state** comes from whether a node listens on the preview's port.
