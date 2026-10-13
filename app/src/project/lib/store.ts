import { create } from 'zustand';

// The project's files, in the node's filesystem.
export const WORK = '/work';
// Directories the file tree leaves out: builds, dependencies, Mix's home.
export const HIDDEN = ['_build', 'deps', '.mix', '.hex', 'node_modules', '.git', '.elixir_ls'];

export interface Tab {
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

interface State {
  status: string;
  ready: boolean;
  // The port the preview shows (a node listens on it), if any.
  previewPort: number | null;
  // Paths below WORK, relative ("playground/mix.exs"; directories end in /).
  paths: string[];
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
  setFilesShown(shown: boolean): void;
  setElsewhere(elsewhere: boolean): void;
  setStatus(status: string): void;
  setReady(ready: boolean): void;
  setPreviewPort(port: number | null): void;
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
  ready: false,
  previewPort: null,
  paths: [],
  tabs: [],
  active: null,
  previewPath: '/',
  previewNavigation: 0,
  previewKey: 0,
  previewPopped: false,
  elsewhere: false,
  filesShown: true,
  setFilesShown: (filesShown) => set({ filesShown }),
  setElsewhere: (elsewhere) => set({ elsewhere }),
  setStatus: (status) => set({ status }),
  setReady: (ready) => set({ ready }),
  setPreviewPort: (previewPort) => set({ previewPort }),
  setPaths: (paths) => set({ paths }),
  open: (path, contents, line = 1) =>
    set((state) =>
      state.tabs.some((tab) => tab.path === path)
        ? {
            active: path,
            tabs: state.tabs.map((tab) =>
              tab.path === path ? { ...tab, line, jump: tab.jump + 1 } : tab,
            ),
          }
        : {
            tabs: [
              ...state.tabs,
              { path, contents, version: 0, draft: contents, saved: contents, line, jump: 0 },
            ],
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
    set((state) => ({ previewPath, previewNavigation: state.previewNavigation + 1 })),
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
