import { RiErrorWarningLine, RiHome5Line, RiRestartLine } from '@remixicon/react';
import { useLayoutEffect, useRef } from 'react';
import { useStore } from '@/project/lib/store';
import { apexUrl } from '@/shared/lib/site';

// Why the project could not start, in a modal dialog in the top layer
// (the bar is too narrow for a stack, and easy to miss). It can be closed
// to look at the files and terminals; the bar keeps saying it failed.
export function StartError() {
  const error = useStore((state) => state.startError);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !error) return;
    element.showModal();
    return () => element.close();
  }, [error]);
  if (!error) return null;
  return (
    <dialog ref={dialog} className="start-error" aria-labelledby="start-error-title">
      <h2 id="start-error-title" className="start-error-title">
        <RiErrorWarningLine size={18} />
        The project could not start
      </h2>
      <pre className="start-error-message">{error}</pre>
      <div className="start-error-actions">
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
        <a className="button" href={apexUrl('/')}>
          <RiHome5Line size={16} />
          All projects
        </a>
        <button type="button" className="button primary" onClick={() => location.reload()}>
          <RiRestartLine size={16} />
          Reload
        </button>
      </div>
    </dialog>
  );
}
