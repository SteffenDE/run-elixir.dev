import type { CodeViewDiffItem, FileDiffMetadata } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react';
import { RiFileTextLine } from '@remixicon/react';
import { useEffect, useMemo, useRef } from 'react';
import { BaseSwitch, NoRepository } from '@/project/components/ChangesPanel';
import '@/project/lib/languages';
import { WORK, useStore } from '@/project/lib/store';
import { workspace } from '@/project/lib/workspace';

// A version per diff object: changes.ts keeps a file's diff the same object
// while it is unchanged, and the view takes in an item again only when its
// version does (by 2: the view bumps it by 1 itself for an edit).
const versions = new WeakMap<FileDiffMetadata, number>();
let nextVersion = 0;
const versionOf = (diff: FileDiffMetadata) => {
  let version = versions.get(diff);
  if (version === undefined) {
    version = nextVersion += 2;
    versions.set(diff, version);
  }
  return version;
};

const open = (path: string, line?: number) =>
  workspace()
    .openFile(`${WORK}/${path}`, line)
    .catch((error: Error) => useStore.getState().setStatus(error.message));

// Every changed file's diff, both files whole (a hunk expands to the rest),
// in one scroll; the side panel's list goes to one.
export function ChangesView() {
  const repository = useStore((state) => state.repository);
  const found = useStore((state) => state.changes);
  const error = useStore((state) => state.changesError);
  const diffStyle = useStore((state) => state.diffStyle);
  const setDiffStyle = useStore((state) => state.setDiffStyle);
  const target = useStore((state) => state.changesTarget);
  const view = useRef<CodeViewHandle<undefined, undefined>>(null);

  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      (found?.diffs ?? []).map((diff) => ({
        id: diff.name,
        type: 'diff',
        fileDiff: diff,
        version: versionOf(diff),
      })),
    [found],
  );

  // The view compares options by reference: a new object renders every
  // file again.
  const options = useMemo(
    () => ({
      theme: { dark: 'pierre-dark', light: 'pierre-light' } as const,
      diffStyle,
      stickyHeaders: true,
      overflow: 'scroll' as const,
      unsafeCSS: ':host { --diffs-bg: light-dark(#ffffff, #18171d); }',
      // ⌘-click (Ctrl-click) a line: the file, there, in the editor.
      onLineClick: ((
        { lineNumber, annotationSide, event }: LineClick,
        { item }: { item: { id: string } },
      ) => {
        if ((event.metaKey || event.ctrlKey) && annotationSide !== 'deletions')
          void open(item.id, lineNumber);
      }) as CodeViewReactOptions<undefined, undefined>['onLineClick'],
    }),
    [diffStyle],
  );

  // To the file asked for (the side panel's list, the tree's marks), once
  // its diff is there; once each time, so a refresh does not go back.
  const gone = useRef(0);
  useEffect(() => {
    const id = target.path;
    if (!id || gone.current === target.jump || !items.some((item) => item.id === id)) return;
    gone.current = target.jump;
    requestAnimationFrame(() => view.current?.scrollTo({ type: 'item', id, align: 'start' }));
  }, [target, items]);

  if (repository === false) return <NoRepository />;
  const total = found?.changes.length ?? 0;
  return (
    <div className="changes-view">
      <div className="changes-toolbar">
        <BaseSwitch />
        <span className={error ? 'search-error' : 'muted'}>
          {error ??
            (found === null
              ? 'Looking for changes…'
              : total
                ? `${total} ${total === 1 ? 'file' : 'files'} changed`
                : 'No changes')}
        </span>
        <span className="changes-spacer" />
        <div className="changes-base" role="group" aria-label="Layout">
          <button
            type="button"
            className="search-option"
            aria-pressed={diffStyle === 'split'}
            onClick={() => setDiffStyle('split')}
          >
            Split
          </button>
          <button
            type="button"
            className="search-option"
            aria-pressed={diffStyle === 'unified'}
            onClick={() => setDiffStyle('unified')}
          >
            Unified
          </button>
        </div>
      </div>
      <CodeView
        ref={view}
        className="changes-scroll"
        items={items}
        options={options}
        renderHeaderMetadata={(item) =>
          item.type === 'diff' && item.fileDiff.type !== 'deleted' ? (
            <button
              type="button"
              className="icon-button"
              title="Open in the editor"
              onClick={() => void open(item.id)}
            >
              <RiFileTextLine size={14} />
            </button>
          ) : null
        }
      />
    </div>
  );
}

interface LineClick {
  lineNumber: number;
  annotationSide?: 'deletions' | 'additions';
  event: PointerEvent;
}
