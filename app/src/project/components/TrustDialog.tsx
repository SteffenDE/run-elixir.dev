import { RiSettings3Line } from '@remixicon/react';
import { useLayoutEffect, useRef } from 'react';
import { answerTrust, useTrust } from '@/project/lib/trust';

// A project from a link or a fork, before it starts: whether it takes the
// user's settings. Its code could read them (a token in the environment,
// what /shared holds), so it does only if the user says; closing says no.
export function TrustDialog() {
  const asking = useTrust((state) => state.asking);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !asking) return;
    element.showModal();
    return () => element.close();
  }, [asking]);
  if (!asking) return null;
  const setup = asking.setup.trim().split('\n');
  return (
    <dialog
      ref={dialog}
      className="start-error trust-dialog"
      aria-labelledby="trust-title"
      onClose={() => {
        if (useTrust.getState().asking) answerTrust(false);
      }}
    >
      <h2 id="trust-title" className="start-error-title">
        <RiSettings3Line size={18} />
        Use your settings in {asking.name}?
      </h2>
      <p>
        This project came from someone else. With your settings, its code can read what they give
        it:
      </p>
      <ul className="trust-list">
        {asking.env.length > 0 && (
          <li>
            Your environment: <code>{asking.env.join(', ')}</code>
          </li>
        )}
        {asking.shared && (
          <li>
            Your shared folder, <code>/shared</code>
          </li>
        )}
        {asking.setup.trim() && (
          <li>
            Your setup script, run once now: <code>{setup[0]}</code>
            {setup.length > 1 && ` and ${setup.length - 1} more line${setup.length > 2 ? 's' : ''}`}
          </li>
        )}
      </ul>
      <p className="nif-build-meta">The project's settings in the top bar change this later.</p>
      <div className="start-error-actions">
        <button type="button" className="button" onClick={() => answerTrust(false)}>
          Not this project
        </button>
        <button
          type="button"
          className="button primary"
          autoFocus
          onClick={() => answerTrust(true)}
        >
          Use my settings
        </button>
      </div>
    </dialog>
  );
}
