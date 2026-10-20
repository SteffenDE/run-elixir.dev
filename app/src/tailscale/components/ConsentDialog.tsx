import { useLayoutEffect, useRef } from 'react';
import { decide, useTailscale } from '@/tailscale/client';
import { TailscaleIcon } from '@/tailscale/components/TailscaleButton';
import { TAG } from '@/tailscale/protocol';

// The first time a project's code reaches for the tailnet: whether it may.
// Its connection waits for the answer, which the apex keeps for the
// project (the Tailscale menu changes it); closing it says no.
export function ConsentDialog({ name }: { name: string }) {
  const asking = useTailscale((state) => state.asking);
  const status = useTailscale((state) => state.status);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !asking) return;
    element.showModal();
    return () => element.close();
  }, [asking]);
  if (!asking) return null;
  const exit = status?.exitNodes.find((node) => node.id === status.exitNode);
  return (
    <dialog
      ref={dialog}
      className="start-error tailscale-dialog"
      aria-labelledby="tailscale-consent-title"
      onClose={() => {
        if (useTailscale.getState().asking) decide(false);
      }}
    >
      <h2 id="tailscale-consent-title" className="start-error-title">
        <TailscaleIcon size={18} />
        Let {name} use your tailnet?
      </h2>
      <p>
        Its code is reaching <code>{asking}</code>. Through your tailnet, it reaches{' '}
        {exit
          ? `the internet from ${exit.name.replace(/\.$/, '')}, your exit node`
          : 'your tailnet'}
        , and whatever your policy lets <code>{TAG}</code> reach.
      </p>
      <p className="nif-build-meta">The Tailscale menu in the top bar changes this later.</p>
      <div className="start-error-actions">
        <button type="button" className="button" onClick={() => decide(false)}>
          Not this project
        </button>
        <button
          type="button"
          className="button primary"
          // The dialog's focus, not its first button.
          autoFocus
          onClick={() => decide(true)}
        >
          Allow
        </button>
      </div>
    </dialog>
  );
}
