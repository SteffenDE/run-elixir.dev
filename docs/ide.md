---
kind: reference
status: live
last_updated: 2026-10-19
---

# The app (`app`)

A React app built with Vite. It uses TypeScript, plain CSS with light and
dark tokens, oxlint and oxfmt. Its libraries are `@pierre/trees`,
`@pierre/diffs`, `@base-ui/react`, `react-resizable-panels`, `zustand`,
Dexie, Remix Icon, xterm.js (with its fit and web-links addons), PGlite and
`tailwindcss`. Versions are exact in `package.json`; `package-lock.json` is
committed. The layout follows tc's: `src/home`, `src/project` and
`src/shared`, each with `components/` and `lib/`, and the runtime in
`src/runtime` ([runtime.md](runtime.md)); imports use `@/` for `src/`.

```sh
cd app
npm ci && npm run build      # tsc --noEmit && vite build → dist/
npm run lint                 # oxlint src test
npm run format               # oxfmt src test
```

`build.py` runs the build in Docker. There are two entries:

- `index.html`: every route (`src/main.tsx` picks the page by path);
- `preview.html`: a project's preview in its own window.

Assets go under `/_playground/`, because the app in the preview owns
`/assets/`. The base is `/`: the page is served at every project's path.

`public/` goes to the site's root as it is: `favicon.ico` and `icons/`
(`icon.svg`, a tab's icon; PNGs of it without the rounded corners, 180 px
for iOS's home screen, 192 and 512 px for the manifest, the 512 also
maskable), `manifest.webmanifest`, and `og.png`, the card of a link's
preview (`index.html`'s Open Graph tags; its `og:image` is absolute with
a project domain). The PNGs, the ICO and the card were rendered from
`icon.svg` in Chromium.

The page installs as a web app (Add to Home Screen). The manifest names
no `start_url`, so a project's page installs that project and the home
page the list; its scope is the whole origin. iOS reads the manifest when
the app is added; an app added before keeps what it had until it is added
again.

The page does not rubber-band (`overscroll-behavior: none`): on iOS it
bounced under a swipe meant for the terminal.

In a standalone window, a fixed strip 6 px high along the top edge, the
colour of what it covers, keeps iOS 27 from blurring the top bar: WebKit
leaves the top unblurred, and gives the status bar that colour, when a
fixed box with a background spans the edge (`styles.css`).

The installed app does not zoom (`main.tsx`: the viewport's
`maximum-scale=1, user-scalable=no`, which home-screen apps honour and
Safari's tabs ignore for pinching). In an iOS tab the maximum scale is 1
too: iOS zooms in on a focused field whose text is under 16 px (the
editor, a terminal) and stays zoomed, and the tab still pinch-zooms;
Android's tabs would not, and do not zoom on focus. Zoom is the page's,
so a pinch could not zoom the preview alone.

## Layout

| Source | Role |
| --- | --- |
| `src/main.tsx` | Routes ([projects.md](projects.md#kinds-and-urls)); takes the project's lock or offers to take it over. |
| `home/components/HomePage.tsx` | New projects, and the projects in this browser, with delete. |
| `shared/lib/projects.ts`, `storage.ts`, `lock.ts` | The projects table (Dexie), where a project keeps its state and deleting it, one tab per project. |
| `project/lib/kinds.ts` | What each kind starts with: boot images, template, directory, first command, preview. |
| `project/lib/playground.ts` | The nodes. Starts the shared `Files` (with the project's store), the bridge and the first shell; PGlite on the first connection. Opens and closes shells; routes the preview's requests to the node listening on its port; reads, saves and reacts to changes; opens files at a line. `window.playground` exposes it for tests. |
| `project/lib/store.ts` | zustand state: status, tree paths, editor tabs, preview, terminals. |
| `project/components/StartError.tsx` | Why the project could not start (`start()` failed, or the first node before it ran), in a modal dialog in the top layer, with Close, All projects and Reload; the bar says "Could not start". |
| `project/components/NarrowWorkspace.tsx`, `shared/lib/narrow.ts` | Phones and windows up to 720 px wide: one pane at a time (files and search, editor, terminal, preview), chosen in a bar at the bottom; all stay mounted. Opening a file shows the editor, following an address the preview; a Phoenix project opens on its preview. The top bar keeps a home icon, the name, the spinner and the restart icon. |
| `project/components/ProjectPage.tsx` | Top bar (name, kind, status, restart) and resizable panels: the side panel (tree or search), then editor over terminals, then the preview while there is one. The tree and the editor are collapsible; the terminals' maximize button collapses or shows both (a temporary IEx starts maximized; a terminal's file link shows them). |
| `project/components/SidePanel.tsx`, `SearchPanel.tsx` | The side panel's tabs: *Files* (the tree) and *Search*, both kept mounted. ⌘⇧F / Ctrl+Shift+F shows the panel (the files pane on a phone) with *Search*, its field focused. The search runs 200 ms after typing stops, again on Enter, the refresh button and when the tab shows again, over the files on disk (not unsaved text) through `workspace().search` (a live session's guest asks the host); *Match case* and *Regular expression* toggle. Hits are grouped by file (folding), each with its line number and the match marked; one opens its file at its line. |
| `project/components/FileTreePanel.tsx` | `@pierre/trees` over `/work`, without `_build`, `deps`, `.mix`, `.git`, …; follows changes with adds and removes (against the model, which also changes itself). Selecting a file opens it. New file and New folder in its header; a context menu (right-click, or a row's button; a popover in the top layer) to make, rename and delete; dragging moves. New entries are named in place (`startRenaming`). `.ex` and `.exs` get an Elixir drop from a sprite sheet. |
| `project/components/QuickOpen.tsx`, `shared/lib/file-search.ts` | ⌘P / Ctrl+P (also from a terminal; not from the preview, whose keys are the app's): a modal dialog that finds a file of the tree by a fuzzy match of its path (every letter in order, clusters and starts after `/ _ . -` score higher, shorter paths win ties) and opens it; the matched letters are marked. Without a query, the open tabs, then the tree's files. |
| `project/components/Editor.tsx` | Tabs (Base UI) of open files; `@pierre/diffs` `File` in edit mode, one editor per tab, keyed by path. ⌘S / Ctrl+S saves. A clean tab follows the node's changes. |
| `project/components/Terminals.tsx`, `TerminalPanel.tsx`, `lib/terminal-handle.ts`, `lib/terminal-links.ts` | Terminal tabs, each a node of its own over the same files, and their xterm terminals and links. |
| `project/components/Preview.tsx`, `PreviewFrame.tsx`, `project/preview.tsx` | The preview, docked or popped out. |
| `project/lib/workspace.ts` | What the components do to a project (read, save, the tree's operations, terminals), wherever it runs: this page's nodes, or a live session's host. |
| `src/tailscale/` | Tailscale ([tailscale.md](tailscale.md)): the top bar's button (on the projects' list, a link) and menu (`TailscaleMenu`, on a project's page: the device's state, whether the project may use the tailnet, its servers' ports to share there), the setup hint a project shows once (`TailscaleDialog`), the question a project asks first (`ConsentDialog`), the apex's `/tailscale` page, and the client of the apex's shared worker. |
| `project/components/ShareButton.tsx`, `src/live/` | *Share*: a link, or a live session ([collaboration.md](collaboration.md)): the host's panel, a guest's page and top bar, the relay, encryption, shared files and the editor's binding to them. |
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
Ctrl+S saves; the empty editor shows the keys, and quick open's, and in
a Phoenix project that the preview reloads.

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

## esbuild on the page

`src/project/lib/programs/esbuild.ts` is esbuild 0.25.4 (esbuild-wasm,
loaded on first use, about 11 MB) in place of the binary the Hex package
runs; the node's `:path` for it is `/usr/bin/esbuild`
([architecture.md](architecture.md#programs)).

- **Options:** entry points, `--bundle`, `--minify`, `--splitting`,
  `--sourcemap[=…]`, `--target=`, `--outdir=`, `--outfile=`, `--outbase=`,
  `--format=`, `--platform=`, `--jsx=`, `--public-path=`, the `--*-names=`,
  `--main-fields=`, `--resolve-extensions=`, `--external:`, `--alias:`,
  `--loader:`, `--define:`, `--watch` and `--version`. Others are reported
  and left out.
- **Imports** resolve from the node's files: relative and absolute paths
  with esbuild's extensions and index files, aliases (from the working
  directory), and packages in `node_modules` up from the importer, then
  `NODE_PATH` (deps and the build path, as the Hex package sets it), by
  `exports` (browser, import, module, default), `browser`, `module` or
  `main`. Externals are left to the page, and so are remote URLs
  (`https://`, `//`); `data:` URLs are esbuild's own, as natively. A script's linked source map
  (the deps ship them) is inlined, since esbuild-wasm reads no files.
- **Watch mode** rebuilds 50 ms after a change to a file it read (a change
  during a build counts once it is done): about 1.2 s for the template's
  first build, 0.3–0.4 s after. The preview then reloads; the build's
  `priv` is a symbolic link to the project's, so Phoenix serves the new
  bundle as it is.

## The preview

`PreviewFrame` is an iframe with a path bar. It shows from the start in a
Phoenix project, and in others once a node listens on a port. Navigating and
reloading are separate signals: a reload stays where the preview is, while
navigating goes to the address typed. The bar shows the app's address as
the app sees it, `localhost:4000/path`: a path alone stays on the port
shown; another port (an umbrella's second endpoint) switches the preview
to it, and it stays there, also while that server restarts. One port is
shown at a time, the docked and the popped-out preview's alike; a live
session's guest chooses its own. "Pop out" opens `/preview.html` in its
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
- **History.** A terminal's history (up, down) starts with the lines its
  shell ran before it opened, so the first tab's `iex -S mix phx.server`
  is one up after Ctrl+C.
- **IEx** edits its own lines: while it runs, keys go to it
  as typed (tab completes, up recalls its history) and it knows the
  terminal's size; Ctrl+C still stops it.
- **The first tab** runs what the kind starts with and can't be closed. In
  a Phoenix project it is "Server"; "Restart server" interrupts it and
  types `cd /work/playground` and `iex -S mix phx.server` again.
- **Server state** comes from whether a node listens on the preview's port.
