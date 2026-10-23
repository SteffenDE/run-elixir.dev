import { RiArrowRightLine } from '@remixicon/react';
import { useLayoutEffect, useRef } from 'react';
import { decideRelay, exitNodeReady, useRelay } from '@/relay/client';
import { apexUrl } from '@/shared/lib/site';
import { useTailscale } from '@/tailscale/client';
import { TailscaleIcon } from '@/tailscale/components/TailscaleButton';

// The first time a project's code connects to one of the relay's hosts
// without a way there (docs/relay.md): the site's relay, the user's own
// Tailscale exit node, or neither. Its connection waits for the answer,
// which the apex keeps for the project (its settings change it); closing
// it says no.
export function RelayDialog({ name }: { name: string }) {
  const asking = useRelay((state) => state.asking);
  // Running with an exit node, refused for this project: allowing it is
  // one click; otherwise it is set up on the Tailscale page.
  const tailnet = useTailscale(() => exitNodeReady());
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !asking) return;
    element.showModal();
    return () => element.close();
  }, [asking]);
  if (!asking) return null;
  return (
    <dialog
      ref={dialog}
      className="start-error tailscale-dialog"
      aria-labelledby="relay-dialog-title"
      onClose={() => {
        if (useRelay.getState().asking) decideRelay('deny');
      }}
    >
      <h2 id="relay-dialog-title" className="start-error-title">
        Let {name} connect to {asking}?
      </h2>
      <p>
        Its code is connecting to <code>{asking}</code>, which does not allow requests from a
        browser (CORS), where the playground runs.
      </p>
      <p>
        The playground's relay can connect for it, to a short list of hosts (GitHub, GitLab,
        Codeberg, Anthropic's API) and for low-bandwidth requests. Your code still does TLS itself:
        the relay sees which host, and how many bytes pass, not what they say. Or connect the
        playground to your own Tailscale exit node, for any host.
      </p>
      <p className="nif-build-meta">
        The project's settings change this later.{' '}
        <a href={apexUrl('/relay')} target="_blank" rel="noopener">
          More about the relay
        </a>
      </p>
      <div className="start-error-actions">
        <button type="button" className="button" onClick={() => decideRelay('deny')}>
          Don't allow
        </button>
        {tailnet ? (
          <button type="button" className="button" onClick={() => decideRelay('tailnet')}>
            <TailscaleIcon size={16} />
            Allow Tailscale
          </button>
        ) : (
          <a
            className="button"
            href={apexUrl('/tailscale')}
            target="_blank"
            rel="noopener"
            onClick={() => decideRelay('later')}
          >
            <TailscaleIcon size={16} />
            Set up Tailscale
            <RiArrowRightLine size={16} />
          </a>
        )}
        <button
          type="button"
          className="button primary"
          // The dialog's focus, not its first button.
          autoFocus
          onClick={() => decideRelay('relay')}
        >
          Enable relay
        </button>
      </div>
    </dialog>
  );
}
