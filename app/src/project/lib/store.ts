import type { NifBuild } from '@/runtime/host/node';
import { create } from 'zustand';
import { newId } from '@/shared/lib/ids';

// The project's files, in the node's filesystem.
export const WORK = '/work';
// Directories the file tree leaves out: builds, dependencies, Mix's home.
export const HIDDEN = ['_build', 'deps', '.mix', '.hex', 'node_modules', '.git', '.elixir_ls'];

export type Pane = 'files' | 'editor' | 'terminal' | 'preview';
// What the side panel shows: the tree, or the search of the files.
export type SideTab = 'files' | 'search';

export interface Tab {
  // This opening of the tab: the editor keeps its session (text, undo) by
  // it, so a tab opened again, or the same path in another project, starts
  // from the file.
  id: string;
  // Absolute path in the node.
  path: string;
  // What the editor was given (a new object reloads the editor), and the
  // version that names it.
  contents: string;
  version: number;
  // The editor's latest text, and what was last saved.
  draft: string;
  saved: string;
  // Where the caret goes (one-based), and a count bumped to send it there
  // again in an open tab.
  line: number;
  jump: number;
}

// A NIF library make waits for the backend to build (NifBuildDialog), from
// when it started waiting.
export interface NifWait extends NifBuild {
  since: number;
}

interface State {
  status: string;
  // The NIF build make waits for, or the last one that did not end well;
  // null once it is built or hidden. A hidden one shows again only when it
  // fails (nifHidden names it).
  nifBuild: NifWait | null;
  nifHidden: string | null;
  setNifBuild(build: NifBuild): void;
  dismissNifBuild(): void;
  // Why the project could not start (StartError shows it), if it could not.
  startError: string | null;
  ready: boolean;
  // The port the preview shows (a node listens on it), if any.
  previewPort: number | null;
  // The ports the project's servers listen on (not ephemeral ones).
  serving: number[];
  // Paths below WORK, relative ("playground/mix.exs"; directories end in /).
  paths: string[];
  // The tree has had its first listing (until then it shows a spinner).
  listed: boolean;
  tabs: Tab[];
  active: string | null;
  previewPath: string;
  // Bumped to go to previewPath, and to reload where the preview is.
  previewNavigation: number;
  previewKey: number;
  // The preview is in its own window (preview.html).
  previewPopped: boolean;
  // Another page took the project over; this one stopped.
  elsewhere: boolean;
  // The file tree and the editor show (else the terminals have the room).
  filesShown: boolean;
  // On a narrow screen, the one pane that shows.
  pane: Pane;
  sideTab: SideTab;
  // Bumped to put the focus in the search field (⌘⇧F, Ctrl+Shift+F).
  searchFocus: number;
  setSideTab(tab: SideTab): void;
  focusSearch(): void;
  // What this page may do: change files (the tree and the editor), and
  // type into terminals (and open them, restart the server). Only a live
  // session's guest may not.
  access: { edit: boolean; terminal: boolean };
  // The project runs elsewhere (this page is a live session's guest).
  remote: boolean;
  setAccess(access: { edit: boolean; terminal: boolean }): void;
  setRemote(remote: boolean): void;
  setPane(pane: Pane): void;
  setFilesShown(shown: boolean): void;
  setElsewhere(elsewhere: boolean): void;
  setStatus(status: string): void;
  failedToStart(error: string): void;
  setReady(ready: boolean): void;
  setPreviewPort(port: number | null): void;
  setServing(ports: number[]): void;
  setPaths(paths: string[]): void;
  open(path: string, contents: string, line?: number): void;
  close(path: string): void;
  // A file or directory moved (tabs below it follow), or removed (they
  // close).
  moved(from: string, to: string): void;
  removed(path: string): void;
  activate(path: string): void;
  edit(path: string, draft: string): void;
  saved(path: string, text: string): void;
  replace(path: string, contents: string): void;
  navigate(path: string): void;
  reloadPreview(): void;
  popOut(popped: boolean): void;
  // Terminal tabs, by session id (playground.ts).
  terminals: number[];
  activeTerminal: number;
  addTerminal(id: number): void;
  removeTerminal(id: number): void;
  activateTerminal(id: number): void;
}

export const useStore = create<State>((set) => ({
  status: 'Starting…',
  nifBuild: null,
  nifHidden: null,
  setNifBuild: (build) =>
    set((state) => {
      if (build.status === 'succeeded' || build.status === 'interrupted') return { nifBuild: null };
      const key = `${build.name} ${build.version}`;
      const pending = ['queued', 'running', 'setting_up'].includes(build.status);
      if (pending && state.nifHidden === key) return {};
      const current = state.nifBuild;
      const same = current && `${current.name} ${current.version}` === key;
      return {
        nifBuild: { ...build, since: same ? current.since : Date.now() },
        nifHidden: pending ? state.nifHidden : null,
      };
    }),
  dismissNifBuild: () =>
    set((state) => ({
      nifBuild: null,
      nifHidden: state.nifBuild ? `${state.nifBuild.name} ${state.nifBuild.version}` : null,
    })),
  startError: null,
  ready: false,
  previewPort: null,
  paths: [],
  listed: false,
  tabs: [],
  active: null,
  previewPath: '/',
  previewNavigation: 0,
  previewKey: 0,
  previewPopped: false,
  elsewhere: false,
  filesShown: true,
  pane: 'terminal',
  sideTab: 'files',
  searchFocus: 0,
  setSideTab: (sideTab) => set({ sideTab }),
  focusSearch: () =>
    set((state) => ({
      sideTab: 'search',
      filesShown: true,
      pane: 'files',
      searchFocus: state.searchFocus + 1,
    })),
  access: { edit: true, terminal: true },
  remote: false,
  setAccess: (access) => set({ access }),
  setRemote: (remote) => set({ remote }),
  setPane: (pane) => set({ pane }),
  setFilesShown: (filesShown) => set({ filesShown }),
  setElsewhere: (elsewhere) => set({ elsewhere }),
  setStatus: (status) => set({ status }),
  failedToStart: (startError) => set({ startError, status: 'Could not start' }),
  setReady: (ready) => set({ ready }),
  setPreviewPort: (previewPort) => set({ previewPort }),
  serving: [],
  setServing: (serving) => set({ serving }),
  setPaths: (paths) => set({ paths, listed: true }),
  open: (path, contents, line = 1) =>
    set((state) =>
      state.tabs.some((tab) => tab.path === path)
        ? {
            pane: 'editor',
            active: path,
            tabs: state.tabs.map((tab) =>
              tab.path === path ? { ...tab, line, jump: tab.jump + 1 } : tab,
            ),
          }
        : {
            tabs: [
              ...state.tabs,
              {
                id: newId(),
                path,
                contents,
                version: 0,
                draft: contents,
                saved: contents,
                line,
                jump: 0,
              },
            ],
            pane: 'editor',
            active: path,
          },
    ),
  close: (path) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.path === path);
      const tabs = state.tabs.filter((tab) => tab.path !== path);
      const active =
        state.active === path
          ? (tabs[Math.min(index, tabs.length - 1)]?.path ?? null)
          : state.active;
      return { tabs, active };
    }),
  moved: (from, to) =>
    set((state) => {
      const follow = (path: string) =>
        path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
      return {
        tabs: state.tabs.map((tab) => ({ ...tab, path: follow(tab.path) })),
        active: state.active && follow(state.active),
      };
    }),
  removed: (path) =>
    set((state) => {
      const gone = (tab: string) => tab === path || tab.startsWith(`${path}/`);
      const tabs = state.tabs.filter((tab) => !gone(tab.path));
      const active =
        state.active && gone(state.active) ? (tabs[tabs.length - 1]?.path ?? null) : state.active;
      return { tabs, active };
    }),
  activate: (active) => set({ active }),
  edit: (path, draft) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, draft } : tab)),
    })),
  saved: (path, text) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, saved: text } : tab)),
    })),
  // The file changed in the node: the tab shows it afresh.
  replace: (path, contents) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === path
          ? { ...tab, contents, version: tab.version + 1, draft: contents, saved: contents }
          : tab,
      ),
    })),
  navigate: (previewPath) =>
    set((state) => ({
      previewPath,
      previewNavigation: state.previewNavigation + 1,
      pane: 'preview',
    })),
  reloadPreview: () => set((state) => ({ previewKey: state.previewKey + 1 })),
  popOut: (previewPopped) => set({ previewPopped }),
  terminals: [],
  activeTerminal: 0,
  addTerminal: (id) =>
    set((state) => ({ terminals: [...state.terminals, id], activeTerminal: id })),
  removeTerminal: (id) =>
    set((state) => {
      const terminals = state.terminals.filter((t) => t !== id);
      return {
        terminals,
        activeTerminal:
          state.activeTerminal === id
            ? (terminals[terminals.length - 1] ?? 0)
            : state.activeTerminal,
      };
    }),
  activateTerminal: (activeTerminal) => set({ activeTerminal }),
}));
