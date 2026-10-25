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
        This project is trying to connect to <code>{asking}</code>. The host's CORS policy prevents
        a direct request from the browser.
      </p>
      <p>
        The relay supports low-bandwidth traffic to selected hosts, including GitHub, GitLab,
        Codeberg and Anthropic's API. Your code handles TLS, so the relay can see the destination
        and traffic volume but cannot read the contents. To connect to any host, you can use your
        own Tailscale exit node.
      </p>
      <p className="nif-build-meta">
        You can change this in Project settings.{' '}
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
