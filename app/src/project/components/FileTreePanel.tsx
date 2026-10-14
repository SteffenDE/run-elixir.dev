import type { ContextMenuItem, ContextMenuOpenContext } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { RiDeleteBinLine, RiEditLine, RiFileAddLine, RiFolderAddLine } from '@remixicon/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createDirectory, createFile, movePath, read, removePath } from '@/project/lib/playground';
import { WORK, useStore } from '@/project/lib/store';

const decoder = new TextDecoder();

// Elixir's files get a drop (the built-in icon sets have none for them).
const ICONS = {
  set: 'complete' as const,
  spriteSheet: `<svg xmlns="http://www.w3.org/2000/svg" style="display: none"><symbol id="playground-elixir" viewBox="0 0 16 16">
    <path fill="#6e4a9e" d="M8 1.2C6.1 4 3.4 7.3 3.4 10.3c0 2.6 2 4.5 4.6 4.5s4.6-1.9 4.6-4.5C12.6 7.3 9.9 4 8 1.2Z"/>
    <path fill="#b79ae0" d="M6.6 6.1c-.9 1.5-1.6 3-1.6 4.3 0 1 .4 1.9 1.1 2.4-.2-1.9.2-4.2.5-6.7Z"/>
  </symbol></svg>`,
  byFileExtension: { ex: 'playground-elixir', exs: 'playground-elixir' },
};

// Tree paths are relative to /work; directories end in a slash.
const absolute = (path: string) => `${WORK}/${path.replace(/\/$/, '')}`;
const baseName = (path: string) => path.replace(/\/$/, '').replace(/^.*\//, '');
const parentOf = (path: string) => path.replace(/\/$/, '').replace(/[^/]*$/, '');
const report = (error: Error) => useStore.getState().setStatus(error.message);

// The node's files below /work; selecting a file opens it in a tab. New
// files and folders start as an entry named in place; renaming moves,
// deleting removes, in the node's files.
export function FileTreePanel() {
  const paths = useStore((state) => state.paths);
  const shown = useRef<string[] | null>(null);
  const selected = useRef<string | null>(null);
  // Entries being named (tree paths without a trailing slash), and files
  // named but not yet written (whose tab createFile opens).
  const creating = useRef(new Set<string>());
  const writing = useRef(new Set<string>());

  // What the tree shows changes with what it did (`from` moved to `to`,
  // made at `to`, or removed): the next refresh from the node then finds
  // nothing to add or remove for it.
  const follow = (from: string | null, to: string | null) => {
    if (!shown.current) return;
    const under = (path: string) =>
      from !== null && (path.replace(/\/$/, '') === from || path.startsWith(`${from}/`));
    const base = to?.replace(/\/$/, '') ?? '';
    const moved = shown.current.filter(under).map((path) => base + path.slice(from!.length));
    shown.current = [
      ...shown.current.filter((path) => !under(path)),
      ...(to === null ? [] : moved.length ? moved : [to]),
    ];
  };

  const { model } = useFileTree({
    paths: [],
    density: 'compact',
    icons: ICONS,
    search: true,
    fileTreeSearchMode: 'hide-non-matches',
    // Room around the search field, which sits flush with the panel's top.
    // The rows' right edge assumes the scrollbar gutter the tree measured,
    // but WebKit reserves none (scrollbar-gutter: stable) until the list
    // overflows: rows ran 6 px past their context menu button. A scrollbar
    // always there (the tree's thin one, its thumb shown on hover) keeps
    // the gutter in Chromium and WebKit; Firefox has its own branch.
    unsafeCSS:
      '[data-file-tree-search-container] { padding-block: 8px 4px; }' +
      ' @supports not (-moz-appearance: none) {' +
      ' [data-file-tree-virtualized-scroll="true"] { overflow-y: scroll; } }',
    composition: { contextMenu: { enabled: true, triggerMode: 'both' } },
    // Dropping moves what was dragged into the folder (or /work), in the
    // node's files too; it is refused where a name exists already, and put
    // back if the node refuses it.
    dragAndDrop: {
      canDrop: ({ draggedPaths, target }) =>
        draggedPaths.every((path) => {
          const destination = (target.directoryPath ?? '') + baseName(path);
          return !shown.current?.some((p) => p === destination || p.startsWith(`${destination}/`));
        }),
      onDropComplete({ draggedPaths, target }) {
        for (const path of draggedPaths) {
          const from = path.replace(/\/$/, '');
          const to = (target.directoryPath ?? '') + baseName(path);
          const folder = path.endsWith('/');
          if (from === to) continue;
          follow(from, folder ? `${to}/` : to);
          movePath(absolute(from), absolute(to)).catch((error: Error) => {
            report(error);
            follow(to, folder ? `${from}/` : from);
            model.move(folder ? `${to}/` : to, path);
          });
        }
      },
      onDropError: (message) => useStore.getState().setStatus(message),
    },
    renaming: {
      onError: (message) => useStore.getState().setStatus(message),
      onRename({ sourcePath, destinationPath, isFolder }) {
        const to = isFolder ? `${destinationPath}/` : destinationPath;
        if (creating.current.delete(sourcePath)) {
          follow(null, to);
          writing.current.add(destinationPath);
          (isFolder ? createDirectory : createFile)(absolute(destinationPath))
            .catch(report)
            .finally(() => writing.current.delete(destinationPath));
        } else {
          follow(sourcePath, to);
          movePath(absolute(sourcePath), absolute(destinationPath)).catch(report);
        }
      },
    },
    onSelectionChange(selection) {
      const path = selection.length === 1 ? selection[0] : null;
      selected.current = path;
      if (!path || path.endsWith('/') || model.getItem(path)?.isDirectory()) return;
      if (creating.current.has(path) || writing.current.has(path)) return;
      const file = absolute(path);
      read(file).then(
        (bytes) => useStore.getState().open(file, decoder.decode(bytes)),
        (error: Error) => useStore.getState().setStatus(error.message),
      );
    },
  });

  // A new file or folder in `dir` ('' for /work), named in place.
  const create = (dir: string, folder: boolean) => {
    const taken = new Set(shown.current ?? []);
    let name = folder ? 'new_folder' : 'new_file';
    for (let n = 2; taken.has(dir + name) || taken.has(`${dir + name}/`); n++)
      name = `${folder ? 'new_folder' : 'new_file'}_${n}`;
    const path = dir + name;
    if (dir) {
      const parent = model.getItem(dir);
      if (parent && 'expand' in parent) parent.expand();
    }
    model.add(folder ? `${path}/` : path);
    creating.current.add(path);
    model.startRenaming(folder ? `${path}/` : path, { removeIfCanceled: true });
  };
  // Where the header's buttons create: the selected folder, or the
  // selected file's.
  const here = () => {
    const path = selected.current;
    if (!path) return '';
    const folder = path.endsWith('/') || model.getItem(path)?.isDirectory();
    return folder ? path.replace(/\/?$/, '/') : parentOf(path);
  };

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
    // Against the model too: what it did itself (a move, a folder left
    // empty) may already be there, or gone.
    const operations = [
      ...paths
        .filter((path) => !was.has(path) && !model.getItem(path))
        .map((path) => ({ type: 'add' as const, path })),
      ...before
        .filter((path) => !now.has(path) && model.getItem(path))
        // An empty directory that now has files is no removal.
        .filter((path) => !(path.endsWith('/') && paths.some((p) => p.startsWith(path))))
        .map((path) => ({ type: 'remove' as const, path, recursive: true })),
    ];
    if (operations.length) model.batch(operations);
  }, [model, paths]);

  return (
    <FileTree
      model={model}
      className="file-tree"
      header={
        <div className="tree-actions">
          <button
            type="button"
            className="icon-button"
            title="New file"
            onClick={() => create(here(), false)}
          >
            <RiFileAddLine size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="New folder"
            onClick={() => create(here(), true)}
          >
            <RiFolderAddLine size={15} />
          </button>
        </div>
      }
      renderContextMenu={(item, context) => (
        <TreeMenu
          item={item}
          context={context}
          onCreate={(folder) => {
            context.close({ restoreFocus: false });
            create(
              item.kind === 'directory' ? item.path.replace(/\/?$/, '/') : parentOf(item.path),
              folder,
            );
          }}
          onRename={() => {
            context.close({ restoreFocus: false });
            model.startRenaming(item.path);
          }}
          onDelete={() => {
            context.close();
            const path = item.path.replace(/\/$/, '');
            removePath(absolute(path)).then(() => {
              follow(path, null);
              model.remove(item.path, item.kind === 'directory' ? { recursive: true } : undefined);
            }, report);
          }}
        />
      )}
    />
  );
}

// The menu goes in the top layer (a manual popover), so the tree's panel
// does not cut it off; it sits under its anchor, kept inside the window.
function TreeMenu({
  item,
  context,
  onCreate,
  onRename,
  onDelete,
}: {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  onCreate(folder: boolean): void;
  onRename(): void;
  onDelete(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current!;
    element.showPopover();
    const anchor = context.anchorRect;
    const { width, height } = element.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, innerWidth - width - 8));
    const below = anchor.bottom + 2;
    const top = below + height > innerHeight - 8 ? Math.max(8, anchor.top - height - 2) : below;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    return () => {
      if (element.matches(':popover-open')) element.hidePopover();
    };
  }, [context.anchorRect]);
  return (
    <div
      ref={menu}
      className="tree-menu"
      role="menu"
      popover="manual"
      data-file-tree-context-menu-root="true"
    >
      <button type="button" role="menuitem" onClick={() => onCreate(false)}>
        <RiFileAddLine size={14} /> New file
      </button>
      <button type="button" role="menuitem" onClick={() => onCreate(true)}>
        <RiFolderAddLine size={14} /> New folder
      </button>
      <button type="button" role="menuitem" onClick={onRename}>
        <RiEditLine size={14} /> Rename
      </button>
      {confirming ? (
        <button type="button" role="menuitem" className="danger" onClick={onDelete}>
          <RiDeleteBinLine size={14} /> Delete {item.name}?
        </button>
      ) : (
        <button type="button" role="menuitem" onClick={() => setConfirming(true)}>
          <RiDeleteBinLine size={14} /> Delete
        </button>
      )}
    </div>
  );
}
