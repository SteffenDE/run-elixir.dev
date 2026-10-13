import { create } from 'zustand';

// The project the playground opens, in the node's filesystem.
export const WORK = '/work';
export const PROJECT = '/work/playground';
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
}

interface State {
  status: string;
  ready: boolean;
  serverRunning: boolean;
  // Paths below WORK, relative ("playground/mix.exs"; directories end in /).
  paths: string[];
  tabs: Tab[];
  active: string | null;
  previewPath: string;
  // Bumped to go to previewPath, and to reload where the preview is.
  previewNavigation: number;
  previewKey: number;
  setStatus(status: string): void;
  setReady(ready: boolean): void;
  setServerRunning(running: boolean): void;
  setPaths(paths: string[]): void;
  open(path: string, contents: string): void;
  close(path: string): void;
  activate(path: string): void;
  edit(path: string, draft: string): void;
  saved(path: string, text: string): void;
  replace(path: string, contents: string): void;
  navigate(path: string): void;
  reloadPreview(): void;
}

export const useStore = create<State>((set) => ({
  status: 'Starting…',
  ready: false,
  serverRunning: false,
  paths: [],
  tabs: [],
  active: null,
  previewPath: '/',
  previewNavigation: 0,
  previewKey: 0,
  setStatus: (status) => set({ status }),
  setReady: (ready) => set({ ready }),
  setServerRunning: (serverRunning) => set({ serverRunning }),
  setPaths: (paths) => set({ paths }),
  open: (path, contents) =>
    set((state) =>
      state.tabs.some((tab) => tab.path === path)
        ? { active: path }
        : {
            tabs: [...state.tabs, { path, contents, version: 0, draft: contents, saved: contents }],
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
}));
