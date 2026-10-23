import { RiArrowLeftLine, RiArrowRightLine } from '@remixicon/react';
import { useEffect } from 'react';
import list from '../../../../backend/priv/relay/hosts.json';
import { apexUrl } from '@/shared/lib/site';
import { TailscaleIcon } from '@/tailscale/components/TailscaleButton';

// /relay on the apex: what the site's TCP relay is (docs/relay.md), which
// hosts it reaches, what it sees, and how a project turns it on or off.
// The project's settings and its first question (RelayDialog) link here.
export function RelayPage() {
  useEffect(() => {
    document.title = 'The relay · Elixir Playground';
  }, []);
  return (
    <div className="home">
      <main className="home-main tailscale-page relay-page">
        <a className="tailscale-back" href="/">
          <RiArrowLeftLine size={14} /> Projects
        </a>
        <h1 className="home-title">The relay</h1>
        <p className="muted home-lead">
          The playground runs in your browser, where CORS restricts HTTPS requests to other sites.
          The relay lets your code connect to selected hosts that do not support these requests.
        </p>

        <h2>How it works</h2>
        <p>
          The relay opens a TCP connection to the destination host. Your code handles TLS in the
          browser, so the relay forwards encrypted traffic. It can see the destination host and
          traffic volume, but cannot read the request or response contents. It does not log which
          users connect to which hosts.
        </p>
        <p>
          Only the hosts listed below are allowed, on port 443. Before forwarding traffic, the relay
          checks that the TLS ClientHello specifies the requested hostname.
        </p>

        <h2>Allowed hosts</h2>
        <ul className="relay-hosts">
          {list.hosts.map((host) => (
            <li key={host}>
              <code>{host}</code>
            </li>
          ))}
        </ul>
        <p className="muted">
          <code>*.</code> matches subdomains of that domain. {list.fetch.join(' and ')} support
          CORS, so requests to them use browser fetch directly.
        </p>

        <h2>Limits</h2>
        <p>
          The relay is intended for low-bandwidth traffic, such as API calls and small downloads.
          Each connection allows up to 1 GiB of traffic and closes after 5 minutes of inactivity.
          Each project can have up to 16 connections open at once.
        </p>

        <h2>Using a Tailscale exit node</h2>
        <p>
          A Tailscale exit node lets your code connect to any host without the relay's limits. When
          an exit node is active and the project has permission to use Tailscale, connections use
          that exit node instead of the relay.
        </p>
        <p>
          <a className="button" href={apexUrl('/tailscale')}>
            <TailscaleIcon size={16} /> Set up Tailscale <RiArrowRightLine size={16} />
          </a>
        </p>

        <h2>Turning it on or off</h2>
        <p>
          When a project first needs the relay, the playground asks for permission and saves your
          choice for that project. To change it, open Project settings using the gear icon in the
          top bar, then look under <em>Network</em>.
        </p>
      </main>
    </div>
  );
}
