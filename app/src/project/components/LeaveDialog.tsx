import { RiErrorWarningLine } from '@remixicon/react';
import { useLayoutEffect, useRef } from 'react';
import { answerLeave, useActive } from '@/project/lib/active';
import { WORK } from '@/project/lib/store';

// Going to another project with edits not yet saved in this one: save them,
// discard them, or stay (closing the dialog stays).
export function LeaveDialog() {
  const asking = useActive((state) => state.asking);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !asking) return;
    element.showModal();
    return () => element.close();
  }, [asking]);
  if (!asking) return null;
  const count = asking.files.length;
  return (
    <dialog
      ref={dialog}
      className="start-error leave-dialog"
      aria-labelledby="leave-title"
      onClose={() => {
        if (useActive.getState().asking) answerLeave('stay');
      }}
    >
      <h2 id="leave-title" className="start-error-title">
        <RiErrorWarningLine size={18} />
        Unsaved changes in {asking.name}
      </h2>
      <p>
        Opening another project stops this one. {count === 1 ? 'This file has' : 'These files have'}{' '}
        changes that are not saved:
      </p>
      <ul className="trust-list">
        {asking.files.map((file) => (
          <li key={file}>
            <code>{file.startsWith(`${WORK}/`) ? file.slice(WORK.length + 1) : file}</code>
          </li>
        ))}
      </ul>
      <div className="start-error-actions">
        <button type="button" className="button" onClick={() => answerLeave('stay')}>
          Stay
        </button>
        <button type="button" className="button danger" onClick={() => answerLeave('discard')}>
          Discard changes
        </button>
        <button
          type="button"
          className="button primary"
          autoFocus
          onClick={() => answerLeave('save')}
        >
          {count === 1 ? 'Save' : 'Save all'}
        </button>
      </div>
    </dialog>
  );
}
