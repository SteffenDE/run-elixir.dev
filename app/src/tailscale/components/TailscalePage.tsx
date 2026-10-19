import { RiArrowLeftLine, RiLoader4Line } from '@remixicon/react';
import { useEffect, useRef, useState } from 'react';
import { listProjects } from '@/shared/lib/projects';
import {
  act,
  connectTailscale,
  consents,
  describe,
  IEX,
  setConsent,
  useTailscale,
} from '@/tailscale/client';
import { SetupSteps } from '@/tailscale/components/SetupSteps';
import { TailscaleIcon } from '@/tailscale/components/TailscaleButton';
import { CONTROL_URL, TAG, type Status } from '@/tailscale/protocol';

// /tailscale on the apex: this browser's Tailscale node, how to set it up,
// signing in and out, its exit node, and (for Headscale) its control
// server. Signing in happens here, a page no project's code runs on.
export function TailscalePage() {
  const status = useTailscale((state) => state.status);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The tab Tailscale's sign-in page goes to, opened on the click (a
  // popup opened later, when the URL comes, would be blocked).
  const signingIn = useRef<Window | null>(null);

  useEffect(() => {
    document.title = 'Tailscale · Elixir Playground';
    void connectTailscale();
  }, []);
  useEffect(() => {
    if (status?.loginURL && signingIn.current) {
      signingIn.current.location.href = status.loginURL;
      signingIn.current = null;
    }
  }, [status?.loginURL]);

  const run = (action: Parameters<typeof act>[0]) => {
    setError(null);
    setBusy(true);
    return act(action)
      .catch((failed: Error) => setError(failed.message))
      .finally(() => setBusy(false));
  };
  const signIn = () => {
    if (status?.loginURL) {
      window.open(status.loginURL, '_blank');
      return;
    }
    signingIn.current = window.open('', '_blank');
    void run({ kind: 'login' });
  };

  const running = status?.state === 'Running';
  const signInButton = running ? (
    <span className="muted">(done)</span>
  ) : (
    <button
      type="button"
      className="button primary"
      onClick={signIn}
      disabled={!status || busy || status.state === 'waiting'}
    >
      <TailscaleIcon size={14} />
      Sign in with Tailscale
    </button>
  );

  return (
    <div className="home">
      <main className="home-main tailscale-page">
        <a className="tailscale-back" href="/">
          <RiArrowLeftLine size={14} /> Projects
        </a>
        <h1 className="home-title">
          <TailscaleIcon size={22} /> Tailscale
        </h1>
        <p className="muted home-lead">
          Connect the playground to your tailnet: the HTTPS requests your projects' code makes,
          which the browser only makes to sites that allow it, go through one of your exit nodes
          instead. One device for this browser, shared by its projects.
        </p>
        <>
          <h2>This browser</h2>
          {status ? (
            <Device status={status} busy={busy} run={run} signIn={signIn} />
          ) : (
            <p className="muted">
              <RiLoader4Line size={14} className="spin" /> Connecting…
            </p>
          )}
          {error && <pre className="start-error-message">{error}</pre>}
          <h2>Projects</h2>
          <Projects />
          <h2>Setting it up</h2>
          <SetupSteps signIn={signInButton} />
          {status && <ControlServer key={status.controlURL} status={status} run={run} />}
        </>
      </main>
    </div>
  );
}

function Device({
  status,
  busy,
  run,
  signIn,
}: {
  status: Status;
  busy: boolean;
  run(action: Parameters<typeof act>[0]): Promise<unknown>;
  signIn(): void;
}) {
  const { label, tone } = describe(status);
  const running = status.state === 'Running';
  const tagged = status.tags?.includes(TAG);
  return (
    <div className="tailscale-device">
      <p className={`tailscale-state tailscale-${tone}`}>
        <span className="tailscale-dot" /> {label}
      </p>
      {status.warnings && status.warnings.length > (status.state === 'Running' ? 0 : 1) && (
        <ul className="tailscale-warnings">
          {status.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {[status.error, ...(status.warnings ?? [])].some(
        (text) => text && /tags?\b.*not permitted|invalid.*tag/i.test(text),
      ) && (
        <p>
          Your tailnet did not let the playground sign in with <code>{TAG}</code>: add it to the
          policy file (step 1 below) and sign in again.
        </p>
      )}
      {running && (
        <dl className="tailscale-facts">
          <dt>Device</dt>
          <dd>
            <code>{status.name?.replace(/\.$/, '')}</code> {status.addresses?.join(', ')}
          </dd>
          {status.tailnet && (
            <>
              <dt>Tailnet</dt>
              <dd>{status.tailnet}</dd>
            </>
          )}
          <dt>Tags</dt>
          <dd>{status.tags?.length ? status.tags.join(', ') : 'none'}</dd>
          <dt>Exit node</dt>
          <dd>
            <select
              value={status.exitNode ?? ''}
              disabled={busy}
              onChange={(event) => void run({ kind: 'exit-node', id: event.target.value })}
            >
              <option value="">None: the tailnet only</option>
              {status.exitNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name.replace(/\.$/, '')}
                  {node.online ? '' : ' (offline)'}
                </option>
              ))}
            </select>
            {status.exitNodes.length === 0 && (
              <span className="muted"> None it may use yet (step 2 below).</span>
            )}
          </dd>
        </dl>
      )}
      {running && !tagged && (
        <p>
          This device is not tagged <code>{TAG}</code>: it has your access to the tailnet, not only
          exit nodes. Sign out, add the tag to the policy file and sign in again.
        </p>
      )}
      <div className="tailscale-actions">
        {running || status.state === 'NeedsMachineAuth' ? (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => void run({ kind: 'logout' })}
          >
            Sign out
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={busy || status.state === 'waiting'}
            onClick={signIn}
          >
            <TailscaleIcon size={14} />
            Sign in with Tailscale
          </button>
        )}
        {status.loginURL && !running && (
          <a href={status.loginURL} target="_blank" rel="noreferrer">
            Tailscale's sign-in page
          </a>
        )}
      </div>
    </div>
  );
}

// Which projects may use the tailnet (each asks the first time its code
// reaches for it), and changing that.
function Projects() {
  const [all, setAll] = useState(consents);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    void listProjects().then((list) =>
      setNames(Object.fromEntries(list.map((project) => [project.id, project.name]))),
    );
    // A project's page answered in another tab.
    const changed = () => setAll(consents());
    addEventListener('storage', changed);
    return () => removeEventListener('storage', changed);
  }, []);
  const change = (key: string, allowed: boolean | null) => {
    setConsent(key, allowed);
    setAll(consents());
  };
  const entries = Object.entries(all);
  if (!entries.length)
    return (
      <p className="muted">
        None yet: a project asks the first time its code reaches for the tailnet.
      </p>
    );
  return (
    <ul className="tailscale-projects">
      {entries.map(([key, allowed]) => {
        const name = key === IEX ? 'Temporary IEx' : (names[key] ?? key);
        return (
          <li key={key} className="tailscale-row">
            <span>
              {name} <span className="muted">{allowed ? 'may use it' : 'may not use it'}</span>
            </span>
            <span className="tailscale-row-actions">
              <button type="button" className="button" onClick={() => change(key, !allowed)}>
                {allowed ? 'Stop' : 'Allow'}
              </button>
              <button type="button" className="button" onClick={() => change(key, null)}>
                Forget
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Another control server than Tailscale's (Headscale), while signed out
// (keyed by the one in use: a new one starts it over).
function ControlServer({
  status,
  run,
}: {
  status: Status;
  run(action: Parameters<typeof act>[0]): Promise<unknown>;
}) {
  const [url, setUrl] = useState(status.controlURL);
  const signedIn = status.state === 'Running' || status.state === 'NeedsMachineAuth';
  return (
    <details className="tailscale-control" open={status.controlURL !== CONTROL_URL}>
      <summary>Another control server</summary>
      <p className="muted">For Headscale: its URL, before signing in (sign out to change it).</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run({ kind: 'control-url', url: url.trim() });
        }}
      >
        <input
          className="tailscale-input"
          value={url}
          disabled={signedIn}
          onChange={(event) => setUrl(event.target.value)}
          aria-label="Control server URL"
        />
        <button type="submit" className="button" disabled={signedIn || url === status.controlURL}>
          Save
        </button>
      </form>
    </details>
  );
}
