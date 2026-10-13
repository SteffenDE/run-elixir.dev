import { FileTree, useFileTree } from '@pierre/trees/react';
import { useEffect, useRef } from 'react';
import { read } from '../playground';
import { WORK, useStore } from '../store';

const decoder = new TextDecoder();

// The node's files below /work; selecting a file opens it in a tab.
export function FileTreePanel() {
  const paths = useStore((state) => state.paths);
  const shown = useRef<string[] | null>(null);
  const { model } = useFileTree({
    paths: [],
    density: 'compact',
    search: true,
    fileTreeSearchMode: 'hide-non-matches',
    // Room around the search field, which sits flush with the panel's top.
    unsafeCSS: '[data-file-tree-search-container] { padding-block: 8px 4px; }',
    onSelectionChange(selected) {
      const path = selected.length === 1 ? selected[0] : null;
      if (!path || path.endsWith('/') || model.getItem(path)?.isDirectory()) return;
      const absolute = `${WORK}/${path}`;
      read(absolute).then(
        (bytes) => useStore.getState().open(absolute, decoder.decode(bytes)),
        (error: Error) => useStore.getState().setStatus(error.message),
      );
    },
  });

  // The tree follows the node: added and removed paths, the rest as it is.
  useEffect(() => {
    if (!paths.length) return;
    const before = shown.current;
    shown.current = paths;
    if (!before) {
      model.resetPaths(paths);
      for (const path of ['playground/', 'playground/lib/']) {
        const item = model.getItem(path);
        if (item && 'expand' in item) item.expand();
      }
      return;
    }
    const was = new Set(before);
    const now = new Set(paths);
    const operations = [
      ...paths.filter((path) => !was.has(path)).map((path) => ({ type: 'add' as const, path })),
      ...before
        .filter((path) => !now.has(path))
        .map((path) => ({ type: 'remove' as const, path, recursive: true })),
    ];
    if (operations.length) model.batch(operations);
  }, [model, paths]);

  return <FileTree model={model} className="file-tree" />;
}
