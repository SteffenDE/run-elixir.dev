import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiErrorWarningLine,
  RiFolderOpenLine,
} from '@remixicon/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  chosenFolder,
  droppedFolder,
  folderShared,
  folderTree,
  isMixProject,
  losesDotfiles,
  leftOutAtFirst,
  tooLarge,
  without,
  type Folder,
  type Tree,
} from '@/shared/lib/folder';
import { navigate } from '@/shared/lib/navigate';
import { importProject } from '@/shared/lib/projects';
import { projectUrl } from '@/shared/lib/site';

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

// Is the path, or a directory above it, left out?
const outBelow = (out: Set<string>, path: string) => {
  for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1))
    if (out.has(path.slice(0, at))) return true;
  return out.has(path);
};

function TreeRows({
  dir,
  out,
  shown,
  onToggle,
  onShow,
}: {
  dir: Tree;
  out: Set<string>;
  shown: Set<string>;
  onToggle(path: string): void;
  onShow(path: string): void;
}) {
  return (
    <ul>
      {dir.dirs.map((child) => {
        const above = child.path.includes('/') && outBelow(out, dirname(child.path));
        const kept = !above && !out.has(child.path);
        const open = shown.has(child.path);
        return (
          <li key={child.path}>
            <div className="folder-row">
              {child.dirs.length ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${open ? 'Hide' : 'Show'} what is in ${child.name}`}
                  onClick={() => onShow(child.path)}
                >
                  {open ? <RiArrowDownSLine size={14} /> : <RiArrowRightSLine size={14} />}
                </button>
              ) : (
                <span className="folder-row-space" />
              )}
              <label>
                <input
                  type="checkbox"
                  checked={kept}
                  disabled={above}
                  onChange={() => onToggle(child.path)}
                />
                <span className="folder-row-name">{child.name}/</span>
              </label>
              <span className="muted folder-row-size">
                {files(child.count)}, {size(child.bytes)}
              </span>
            </div>
            {open && (
              <TreeRows dir={child} out={out} shown={shown} onToggle={onToggle} onShow={onShow} />
            )}
          </li>
        );
      })}
      {dir.own > 0 && (
        <li className="folder-row muted">
          <span className="folder-row-space" />
          <span className="folder-row-name">
            {dir.path ? `${files(dir.own)} in ${dir.name}/ itself` : `${files(dir.own)} at the top`}
          </span>
          <span className="folder-row-size">{size(dir.ownBytes)}</span>
        </li>
      )}
    </ul>
  );
}

const dirname = (path: string) => path.slice(0, path.lastIndexOf('/'));

// What of a folder goes into the project: its directories, to leave out
// more of (until it fits).
function FolderReview({ folder, onClose }: { folder: Folder; onClose(): void }) {
  const tree = useMemo(() => folderTree(folder), [folder]);
  const [out, setOut] = useState(() => leftOutAtFirst(folder));
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = useMemo(() => without(folder, out), [folder, out]);
  let bytes = 0;
  for (const file of kept.files.values()) bytes += file.size;
  const over = tooLarge(kept.files.size, bytes);
  const flip = (set: Set<string>, path: string) => {
    const next = new Set(set);
    if (!next.delete(path)) next.add(path);
    return next;
  };

  return (
    <div
      className={`home-alert folder-review${over ? ' over' : ''}`}
      role="region"
      aria-label="New project from a folder"
    >
      <p className="folder-review-title">
        <RiFolderOpenLine size={16} />
        <strong>{folder.name}</strong>
        <span className="muted">
          {files(kept.files.size)}, {size(bytes)}
        </span>
      </p>
      <p className="muted">
        Excluded by default: <code>_build</code>, <code>deps</code>, <code>node_modules</code>,{' '}
        <code>.git</code>, <code>.elixir_ls</code> and files matched by <code>.gitignore</code>.
        Uncheck any other files you want to exclude.
        {!isMixProject(folder) &&
          ' No mix.exs found in the root folder. Check that you selected a Mix project.'}
      </p>
      {losesDotfiles() && (
        <p className="folder-review-warning">
          <RiErrorWarningLine size={16} />
          <span>
            This browser skips symlinks and files or folders whose names start with a dot, including{' '}
            <code>.formatter.exs</code> and <code>.gitignore</code>. Without <code>.gitignore</code>
            , its exclusion rules cannot be applied. Use Chrome or Firefox to include these files.
          </span>
        </p>
      )}
      <div className="folder-tree">
        <TreeRows
          dir={tree}
          out={out}
          shown={shown}
          onToggle={(path) => setOut((now) => flip(now, path))}
          onShow={(path) => setShown((now) => flip(now, path))}
        />
      </div>
      {over && (
        <p className="folder-review-over" role="alert">
          <RiErrorWarningLine size={16} />
          Selection exceeds the limit: {over}. Projects support up to 5000 files and 64 MB. Exclude
          more files to continue.
        </p>
      )}
      {error && <p className="project-error">{error}</p>}
      <p className="elsewhere-actions">
        <button
          type="button"
          className="button primary"
          disabled={Boolean(over) || opening || !kept.files.size}
          onClick={() => {
            setOpening(true);
            void folderShared(kept)
              .then((shared) => importProject(shared))
              .then(
                (project) => navigate(projectUrl(project.id)),
                (failure: Error) => {
                  setOpening(false);
                  setError(failure.message);
                },
              );
          }}
        >
          {opening ? 'Opening…' : 'Open as a new project'}
        </button>
        <button type="button" className="button" disabled={opening} onClick={onClose}>
          Cancel
        </button>
      </p>
    </div>
  );
}

// A folder from this computer, dropped anywhere on the home page or chosen:
// what of it to take, and a new empty project with its files (folder.ts).
export function FolderImport() {
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // dragenter and dragleave come for each element on the way.
  const depth = useRef(0);

  const read = useCallback(async (pending: Promise<Folder>) => {
    setError(null);
    setFolder(null);
    setReading(true);
    try {
      setFolder(await pending);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setReading(false);
    }
  }, []);

  useEffect(() => input.current?.setAttribute('webkitdirectory', ''), []);

  useEffect(() => {
    const dragged = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    const enter = (event: DragEvent) => {
      if (!dragged(event)) return;
      depth.current += 1;
      setOver(true);
    };
    const leave = (event: DragEvent) => {
      if (!dragged(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const dragOver = (event: DragEvent) => {
      if (!dragged(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = 'copy';
    };
    const drop = (event: DragEvent) => {
      if (!dragged(event)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      // The items are read while the event runs: after it, they are gone.
      void read(droppedFolder(event.dataTransfer!.items));
    };
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragleave', leave);
    document.addEventListener('dragover', dragOver);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('dragenter', enter);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('dragover', dragOver);
      document.removeEventListener('drop', drop);
    };
  }, [read]);

  return (
    <>
      {over && (
        <div className="home-drop" aria-hidden>
          Drop the folder to open it as a new project
        </div>
      )}
      {folder ? (
        <FolderReview folder={folder} onClose={() => setFolder(null)} />
      ) : (
        <div className="home-alert">
          <RiFolderOpenLine size={16} />
          <p>
            {reading ? (
              'Reading the folder…'
            ) : (
              <>
                Have a Mix project on this computer? Drop its folder anywhere on this page, or{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => input.current?.click()}
                >
                  choose it
                </button>
                .
              </>
            )}
          </p>
          <input
            ref={input}
            type="file"
            hidden
            aria-label="Open a folder"
            onChange={(event) => {
              const list = event.currentTarget.files;
              if (list?.length) void read(chosenFolder(list));
              event.currentTarget.value = '';
            }}
          />
        </div>
      )}
      {error && (
        <p className="home-alert error" role="alert">
          <RiErrorWarningLine size={16} />
          {error}
        </p>
      )}
    </>
  );
}
