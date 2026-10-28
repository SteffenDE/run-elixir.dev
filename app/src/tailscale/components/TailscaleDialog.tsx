import { RiArrowRightLine } from '@remixicon/react';
import { useLayoutEffect, useRef } from 'react';
import { apexUrl } from '@elixir-playground/runtime/lib/site';
import { dismissHint, useTailscale } from '@/tailscale/client';
import { SetupSteps } from '@/tailscale/components/SetupSteps';
import { TailscaleIcon } from '@/tailscale/components/TailscaleButton';

// Once per browser: a request of the node's that the browser would not
// make, while Tailscale is not set up, and how to set it up. However it
// closes, it does not show again (the top bar's Tailscale button stays).
export function TailscaleDialog() {
  const blocked = useTailscale((state) => state.blocked);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !blocked) return;
    element.showModal();
    return () => element.close();
  }, [blocked]);
  if (!blocked) return null;
  const host = URL.canParse(blocked) ? new URL(blocked).host : blocked;
  const setup = <a href={apexUrl('/tailscale')}>Sign in on the playground's Tailscale page</a>;
  return (
    <dialog
      ref={dialog}
      className="start-error tailscale-dialog"
      aria-labelledby="tailscale-dialog-title"
      onClose={dismissHint}
    >
      <h2 id="tailscale-dialog-title" className="start-error-title">
        <TailscaleIcon size={18} />
        {host} can't be reached from the browser
      </h2>
      <p>
        Browser CORS restrictions can block HTTPS requests from your code. Connect a Tailscale exit
        node to send these requests through your tailnet and reach any host.
      </p>
      <SetupSteps signIn={setup} />
      <p className="nif-build-meta">
        This notice appears once. You can reopen setup using the Tailscale button in the top bar.
      </p>
      <div className="start-error-actions">
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Not now
        </button>
        <a
          className="button primary"
          // The dialog's focus, not the first link in its text.
          autoFocus
          href={apexUrl('/tailscale')}
          onClick={() => dialog.current?.close()}
        >
          <RiArrowRightLine size={16} />
          Set up Tailscale
        </a>
      </div>
    </dialog>
  );
}
