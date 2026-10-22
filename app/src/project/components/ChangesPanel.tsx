import { RiGitRepositoryLine, RiUploadCloud2Line } from '@remixicon/react';
import { useState } from 'react';
import { PushDialog } from '@/project/components/PushDialog';
import type { Change } from '@/project/lib/changes';
import { initializeRepository } from '@/project/lib/review';
import { useStore } from '@/project/lib/store';

// A change's mark, as git's short status has it.
export const MARKS: Record<Change['type'], { letter: string; label: string }> = {
  new: { letter: 'A', label: 'added' },
  change: { letter: 'M', label: 'modified' },
  deleted: { letter: 'D', label: 'deleted' },
  'rename-pure': { letter: 'R', label: 'renamed' },
  'rename-changed': { letter: 'R', label: 'renamed' },
};

export const pathOf = (change: Change) => (change.after ?? change.before)!.path;

// Since the baseline or the last commit.
export function BaseSwitch() {
  const base = useStore((state) => state.base);
  const setBase = useStore((state) => state.setBase);
  return (
    <div className="changes-base" role="group" aria-label="Changes since">
      <button
        type="button"
        className="search-option"
        aria-pressed={base === 'all'}
        title="Since the project started (its baseline commit)"
        onClick={() => setBase('all')}
      >
        All changes
      </button>
      <button
        type="button"
        className="search-option"
        aria-pressed={base === 'uncommitted'}
        title="Since the last commit"
        onClick={() => setBase('uncommitted')}
      >
        Uncommitted
      </button>
    </div>
  );
}

// An empty project's repository is the user's to start (`git clone URL .`
// takes an empty directory only).
export function NoRepository() {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="changes-empty">
      <p className="muted">This project is not a git repository.</p>
      <button
        type="button"
        className="button"
        disabled={starting}
        onClick={() => {
          setStarting(true);
          initializeRepository().then(
            () => setStarting(false),
            (failure: Error) => {
              setStarting(false);
              setError(failure.message);
            },
          );
        }}
      >
        <RiGitRepositoryLine size={15} />
        Initialize repository
      </button>
      <p className="muted">
        Or clone one at the shell: <code>git clone URL .</code>
      </p>
      {error && <p className="search-error">{error}</p>}
    </div>
  );
}

// The side panel's list of what changed; a file's diff opens in the
// changes view's tab.
export function ChangesPanel() {
  const repository = useStore((state) => state.repository);
  const found = useStore((state) => state.changes);
  const error = useStore((state) => state.changesError);
  const showChanges = useStore((state) => state.showChanges);
  const [pushing, setPushing] = useState(false);

  if (repository === false) return <NoRepository />;
  const list = found?.changes ?? [];
  const added = list.reduce((sum, change) => sum + change.added, 0);
  const removed = list.reduce((sum, change) => sum + change.removed, 0);
  return (
    <div className="search-panel changes-panel">
      <div className="search-form changes-actions">
        <BaseSwitch />
        {repository && (
          <button
            type="button"
            className="search-option"
            title="Commit what changed and push it to GitHub"
            onClick={() => setPushing(true)}
          >
            <RiUploadCloud2Line size={14} />
            Push
          </button>
        )}
      </div>
      {pushing && <PushDialog onClose={() => setPushing(false)} />}
      <p className={error ? 'search-summary search-error' : 'search-summary muted'}>
        {error ??
          (found === null
            ? 'Looking for changes…'
            : list.length
              ? `${list.length} ${list.length === 1 ? 'file' : 'files'} changed, +${added} −${removed}`
              : 'No changes')}
      </p>
      <div className="search-results">
        {list.length > 0 && (
          <button type="button" className="search-file changes-all" onClick={() => showChanges()}>
            Show all changes
          </button>
        )}
        {list.map((change) => {
          const path = pathOf(change);
          const slash = path.lastIndexOf('/');
          const mark = MARKS[change.type];
          return (
            <button
              key={path}
              type="button"
              className="search-file"
              title={
                change.before && change.before.path !== path
                  ? `${change.before.path} → ${path}`
                  : path
              }
              onClick={() => showChanges(path)}
            >
              <span className={`change-mark change-${mark.label}`} aria-label={mark.label}>
                {mark.letter}
              </span>
              <span className="search-file-name">{path.slice(slash + 1)}</span>
              {slash > 0 && <span className="search-file-dir">{path.slice(0, slash)}</span>}
              <span className="change-stats">
                {change.binary ? (
                  <span className="muted">binary</span>
                ) : (
                  <>
                    {change.added > 0 && <span className="change-added">+{change.added}</span>}
                    {change.removed > 0 && (
                      <span className="change-removed">−{change.removed}</span>
                    )}
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
