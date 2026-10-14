// Changes from the node and the editor, for the page programs' watch modes.
export type Watcher = (paths: string[]) => void;
export const watchers = new Set<Watcher>();
export function filesChanged(paths: string[]): void {
  for (const watcher of watchers) watcher(paths);
}
