import { RiArrowDownSLine, RiArrowRightSLine, RiRefreshLine } from '@remixicon/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchHit, SearchQuery, SearchResult } from '@/runtime/host/files';
import { WORK, useStore } from '@/project/lib/store';
import { workspace } from '@/project/lib/workspace';

// How long typing pauses before the search runs.
const PAUSE = 200;

// The files' contents searched (workspace().search: the files on disk, not
// unsaved text), the hits grouped by file; a hit opens its file at its
// line. It runs as the query changes, again on Enter or the refresh
// button, and when the tab shows again (the files may have changed).
export function SearchPanel() {
  const [query, setQuery] = useState<SearchQuery>({ text: '', regex: false, matchCase: false });
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const field = useRef<HTMLInputElement>(null);
  // The latest search's number: older answers are dropped.
  const latest = useRef(0);
  const shown = useStore((state) => state.sideTab === 'search');
  const focus = useStore((state) => state.searchFocus);

  const run = useCallback((next: SearchQuery) => {
    const number = ++latest.current;
    if (!next.text) {
      setResult(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    workspace()
      .search(next)
      .then(
        (found) => number === latest.current && setResult(found),
        (error: Error) =>
          number === latest.current &&
          setResult({ hits: [], truncated: false, error: error.message }),
      )
      .finally(() => number === latest.current && setSearching(false));
  }, []);

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => run(query), PAUSE);
    return () => clearTimeout(timer);
  }, [query, shown, run]);

  useEffect(() => {
    if (!focus) return;
    field.current?.focus();
    field.current?.select();
  }, [focus]);

  const groups = group(result?.hits ?? []);
  const toggle = (option: 'regex' | 'matchCase') =>
    setQuery((current) => ({ ...current, [option]: !current[option] }));

  return (
    <div className="search-panel">
      <div className="search-form">
        <div className="search-field">
          <input
            ref={field}
            value={query.text}
            placeholder="Search"
            aria-label="Search the files"
            spellCheck={false}
            onChange={(event) => setQuery({ ...query, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') run(query);
            }}
          />
          <button
            type="button"
            className="search-option"
            title="Match case"
            aria-label="Match case"
            aria-pressed={query.matchCase}
            onClick={() => toggle('matchCase')}
          >
            Aa
          </button>
          <button
            type="button"
            className="search-option"
            title="Regular expression"
            aria-label="Regular expression"
            aria-pressed={query.regex}
            onClick={() => toggle('regex')}
          >
            .*
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Search again"
          disabled={!query.text}
          onClick={() => run(query)}
        >
          <RiRefreshLine size={15} className={searching ? 'spin' : undefined} />
        </button>
      </div>
      {result && (
        <p className={result.error ? 'search-summary search-error' : 'search-summary muted'}>
          {summary(result, groups.length)}
        </p>
      )}
      <div className="search-results">
        {groups.map(([path, hits]) => {
          const open = !folded.has(path);
          const relative = path.slice(WORK.length + 1);
          const slash = relative.lastIndexOf('/');
          return (
            <div key={path}>
              <button
                type="button"
                className="search-file"
                title={relative}
                aria-expanded={open}
                onClick={() =>
                  setFolded((current) => {
                    const next = new Set(current);
                    if (open) next.add(path);
                    else next.delete(path);
                    return next;
                  })
                }
              >
                {open ? <RiArrowDownSLine size={14} /> : <RiArrowRightSLine size={14} />}
                <span className="search-file-name">{relative.slice(slash + 1)}</span>
                {slash > 0 && (
                  <span className="search-file-dir">
                    <bdi>{relative.slice(0, slash)}</bdi>
                  </span>
                )}
                <span className="search-count">{hits.length}</span>
              </button>
              {open && (
                <div>
                  {hits.map((hit) => (
                    <button
                      key={`${hit.line}:${hit.column}`}
                      type="button"
                      className="search-hit"
                      title={`${relative}:${hit.line}:${hit.column}`}
                      onClick={() =>
                        workspace()
                          .openFile(path, hit.line)
                          .catch((error: Error) => useStore.getState().setStatus(error.message))
                      }
                    >
                      <span className="search-line">{hit.line}</span>
                      <span className="search-text">
                        {hit.cut && '…'}
                        {hit.text.slice(0, hit.at)}
                        <mark>{hit.text.slice(hit.at, hit.at + hit.length)}</mark>
                        {hit.text.slice(hit.at + hit.length)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Hits by file, in their order (the worker's, by path).
function group(hits: SearchHit[]): [string, SearchHit[]][] {
  const groups: [string, SearchHit[]][] = [];
  for (const hit of hits) {
    const last = groups[groups.length - 1];
    if (last && last[0] === hit.path) last[1].push(hit);
    else groups.push([hit.path, [hit]]);
  }
  return groups;
}

function summary(result: SearchResult, files: number): string {
  if (result.error) return result.error;
  if (!result.hits.length) return 'No results';
  const hits = result.hits.length;
  const counted = `${hits} result${hits === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`;
  return result.truncated ? `The first ${counted}` : counted;
}
