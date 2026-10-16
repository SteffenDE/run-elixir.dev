import { RiFileTextLine, RiSearchLine } from '@remixicon/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { WORK, useStore } from '@/project/lib/store';
import { workspace } from '@/project/lib/workspace';
import { matchingPaths, type PathMatch } from '@/shared/lib/file-search';
import { isModifierKeyPressed } from '@/shared/lib/keys';

const LIMIT = 50;

// ⌘P / Ctrl+P: a file of the project by a fuzzy match of its path, in a
// modal dialog. Without a query, the open tabs come first, then the tree's
// order. It works in the terminals too (as in VS Code; the shell's
// history is also on the up arrow); keys pressed in the preview are the
// app's, not ours.
export function QuickOpen() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isModifierKeyPressed(event) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'p') return;
      // Also keeps the browser's print dialog away.
      event.preventDefault();
      event.stopPropagation();
      setOpen((shown) => !shown);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="quick-open"
      aria-label="Open file"
      onClose={() => setOpen(false)}
      // A click on the backdrop lands on the dialog itself.
      onClick={(event) => event.target === event.currentTarget && setOpen(false)}
    >
      {open && <Finder onOpen={() => setOpen(false)} />}
    </dialog>
  );
}

function Finder({ onOpen }: { onOpen: () => void }) {
  const paths = useStore((state) => state.paths);
  const tabs = useStore((state) => state.tabs);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const matches = useMemo((): PathMatch[] => {
    const files = paths.filter((path) => !path.endsWith('/'));
    if (query) return matchingPaths(query, files, LIMIT);
    const opened = tabs
      .map((tab) => tab.path.slice(WORK.length + 1))
      .filter((path) => files.includes(path));
    const rest = files.filter((path) => !opened.includes(path));
    return [...opened, ...rest].slice(0, LIMIT).map((path) => ({ path, score: 0, positions: [] }));
  }, [paths, tabs, query]);

  const choose = (path: string | undefined) => {
    if (path === undefined) return;
    onOpen();
    workspace()
      .openFile(`${WORK}/${path}`)
      .catch((error: Error) => useStore.getState().setStatus(error.message));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = matches.length;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      setSelected((index) => (index + 1) % count);
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      setSelected((index) => (index - 1 + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(matches[selected]?.path);
    }
  };

  return (
    <>
      <label className="quick-open-search">
        <RiSearchLine size={16} />
        <input
          autoFocus
          value={query}
          placeholder="Go to file"
          spellCheck={false}
          aria-controls="quick-open-results"
          aria-activedescendant={matches.length ? `quick-open-${selected}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {matches.length > 0 ? (
        <div id="quick-open-results" className="quick-open-results" role="listbox">
          {matches.map((match, index) => (
            <button
              key={match.path}
              id={`quick-open-${index}`}
              ref={index === selected ? scrollTo : undefined}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === selected}
              className="quick-open-row"
              title={match.path}
              onMouseMove={() => setSelected(index)}
              onClick={() => choose(match.path)}
            >
              <RiFileTextLine size={14} />
              <MatchedPath match={match} />
            </button>
          ))}
        </div>
      ) : (
        <p className="quick-open-empty muted">{query ? 'No matching files' : 'No files'}</p>
      )}
    </>
  );
}

// The selected row, kept in view as the arrows move.
const scrollTo = (row: HTMLElement | null) => row?.scrollIntoView({ block: 'nearest' });

// The file's name, then its directory, faint (cut at the start when it
// is long); the query's letters marked in both.
function MatchedPath({ match }: { match: PathMatch }) {
  const { path, positions } = match;
  const slash = path.lastIndexOf('/');
  const marked = new Set(positions);
  const part = (from: number, to: number): ReactNode[] => {
    const nodes: ReactNode[] = [];
    let run = from;
    for (let i = from; i <= to; i++) {
      if (i < to && marked.has(i) === marked.has(run)) continue;
      const text = path.slice(run, i);
      nodes.push(marked.has(run) ? <mark key={run}>{text}</mark> : text);
      run = i;
    }
    return nodes;
  };
  return (
    <span className="quick-open-path">
      <span className="quick-open-name">{part(slash + 1, path.length)}</span>
      {slash > 0 && (
        <span className="quick-open-dir">
          <bdi>{part(0, slash)}</bdi>
        </span>
      )}
    </span>
  );
}
