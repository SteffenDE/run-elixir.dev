import { RiArrowRightLine, RiLoader4Line } from '@remixicon/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLive } from '@/live/lib/store';
import { connectServer } from '@/project/lib/playground';
import { useStore } from '@/project/lib/store';
import { apexUrl } from '@/shared/lib/site';
import {
  connectTailscale,
  decide,
  describe,
  offForGuests,
  share,
  unshare,
  useTailscale,
} from '@/tailscale/client';
import { CopyButton } from '@/tailscale/components/SetupSteps';
import { TailscaleIcon } from '@/tailscale/components/TailscaleButton';
import { TAG } from '@/tailscale/protocol';

// What lets the user's devices reach the playground's ports, in the
// tailnet's policy.
const inbound = (ports: number[]) =>
  `{ "src": ["autogroup:member"], "dst": ["${TAG}"], "ip": [${ports
    .map((port) => `"tcp:${port}"`)
    .join(', ')}] }`;

// The top bar's Tailscale menu on a project's page (or the temporary
// IEx's), in a popover: the device's state, whether this project may use
// the tailnet, its servers' ports shared in the tailnet (inbound
// connections go to them), and the apex's Tailscale page. Nothing where
// Tailscale is not offered.
export function TailscaleMenu() {
  const status = useTailscale((state) => state.status);
  const consent = useTailscale((state) => state.consent);
  const shared = useTailscale((state) => state.shared);
  const serving = useStore((state) => state.serving);
  // Followed for offForGuests, which reads them.
  useLive((state) => state.people);
  useLive((state) => state.everyone);
  useLive((state) => state.perGuest);
  useLive((state) => state.tailnetOff);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => void connectTailscale(), []);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !open) return;
    if (!element.matches(':popover-open')) element.showPopover();
    const anchor = button.current!.getBoundingClientRect();
    const width = element.getBoundingClientRect().width;
    element.style.top = `${anchor.bottom + 6}px`;
    element.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
  }, [open]);
  if (!status) return null;
  const { label, tone } = describe(status);
  const running = status.state === 'Running';
  const device = status.name?.replace(/\.$/, '');
  const ports = [...new Set([...serving, ...Object.keys(shared).map(Number)])].sort(
    (a, b) => a - b,
  );
  // The device's ports this project's servers are shared at.
  const sharedPorts = ports.flatMap((port) =>
    shared[port]?.state === 'shared' ? [shared[port].as] : [],
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-button tailscale-button tailscale-${tone}`}
        title={`Tailscale: ${label}`}
        aria-label={`Tailscale: ${label}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <TailscaleIcon />
        <span className="tailscale-dot" />
      </button>
      {open && (
        <div
          ref={panel}
          className="share-panel tailscale-menu"
          popover="auto"
          onToggle={(event) => {
            if (event.newState === 'closed') setOpen(false);
          }}
        >
          <p className={`tailscale-state tailscale-${tone}`}>
            <span className="tailscale-dot" /> Tailscale: {label}
          </p>
          {status.state === 'off' ? (
            <p className="muted">
              Set it up to reach any site, and your tailnet, from this project's code.
            </p>
          ) : (
            <>
              <h3>This project</h3>
              <div className="tailscale-row">
                <span>
                  {consent === true
                    ? 'May use your tailnet.'
                    : consent === false
                      ? 'May not use your tailnet.'
                      : 'Asks when its code first reaches out.'}
                </span>
                <button type="button" className="button" onClick={() => decide(consent !== true)}>
                  {consent === true ? 'Stop' : 'Allow'}
                </button>
              </div>
              {offForGuests() && (
                <p className="muted">
                  Off while a guest of the live session may type or edit, as the session is set.
                </p>
              )}
              <h3>Its servers in your tailnet</h3>
              {ports.length === 0 ? (
                <p className="muted">No server runs in this project.</p>
              ) : (
                <ul className="tailscale-ports">
                  {ports.map((port) => {
                    const state = shared[port];
                    const url = device && state ? `http://${device}:${state.as}/` : null;
                    // Another project shares the device's port: share at a
                    // free one, or take it.
                    const elsewhere =
                      state?.state === 'failed' && (state.busy || state.free !== undefined);
                    return (
                      <li key={port} className="tailscale-port">
                        <div className="tailscale-row">
                          {state?.state === 'shared' && url ? (
                            <a href={url} target="_blank" rel="noreferrer">
                              {url}
                              {state.as !== port && <span className="muted"> (port {port})</span>}
                            </a>
                          ) : (
                            <span>
                              Port {port}
                              {state?.state === 'failed' && (
                                <span className="muted"> · {state.error}</span>
                              )}
                            </span>
                          )}
                          {state?.state === 'sharing' ? (
                            <RiLoader4Line size={16} className="spin" />
                          ) : state?.state === 'shared' ? (
                            <span className="tailscale-row-actions">
                              {url && <CopyButton text={url} />}
                              <button
                                type="button"
                                className="button"
                                onClick={() => unshare(port)}
                              >
                                Stop
                              </button>
                            </span>
                          ) : elsewhere ? null : (
                            <button
                              type="button"
                              className="button"
                              disabled={!running}
                              onClick={() => void share(port, connectServer)}
                            >
                              Share
                            </button>
                          )}
                        </div>
                        {elsewhere && (
                          <div className="tailscale-row-actions tailscale-port-choices">
                            {state.free !== undefined && (
                              <button
                                type="button"
                                className="button"
                                disabled={!running}
                                onClick={() => void share(port, connectServer, { as: state.free })}
                              >
                                Share as port {state.free}
                              </button>
                            )}
                            <button
                              type="button"
                              className="button"
                              disabled={!running}
                              onClick={() =>
                                void share(port, connectServer, { as: state.as, take: true })
                              }
                            >
                              Share here instead
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {sharedPorts.length > 0 && (
                <p className="muted">
                  Your devices reach these if your policy lets them reach {TAG}, for example:{' '}
                  <code>{inbound(sharedPorts)}</code>
                </p>
              )}
            </>
          )}
          <a className="tailscale-settings" href={apexUrl('/tailscale')}>
            <RiArrowRightLine size={14} /> Tailscale settings
          </a>
        </div>
      )}
    </>
  );
}
