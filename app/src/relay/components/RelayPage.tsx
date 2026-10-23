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
          The playground runs in this tab, so your code's HTTPS requests go through the browser,
          which only reads sites that allow other sites to (CORS). For a few sites that don't, the
          playground's relay can make the connection for your code.
        </p>

        <h2>How it works</h2>
        <p>
          Your code opens a TCP connection to the site through the relay, a server of the
          playground's, and does TLS over it itself, as it would on your computer. The relay passes
          the encrypted bytes on: it sees which site, and how many bytes pass, never what they say.
          It keeps no log of who reached which site.
        </p>
        <p>
          It only connects to the sites below, on port 443, and only once your code's first bytes
          ask for that same site over TLS. Anything else is refused.
        </p>

        <h2>Sites</h2>
        <ul className="relay-hosts">
          {list.hosts.map((host) => (
            <li key={host}>
              <code>{host}</code>
            </li>
          ))}
        </ul>
        <p className="muted">
          <code>*.</code> means every name below that domain. {list.fetch.join(' and ')} allow
          browsers, so the browser reaches them itself.
        </p>

        <h2>Limits</h2>
        <p>
          The relay is for low-bandwidth requests: cloning a repository, an API call, a release's
          download. A connection carries at most 1 GiB, and ends after 5 minutes without traffic; a
          project has at most 16 open at once.
        </p>

        <h2>Your own exit node instead</h2>
        <p>
          Connected to your tailnet, the playground sends your code's requests through one of your
          Tailscale exit nodes, to any site, with no limits of the playground's. While Tailscale
          runs with an exit node, a project that may use it goes there, not through the relay.
        </p>
        <p>
          <a className="button" href={apexUrl('/tailscale')}>
            <TailscaleIcon size={16} /> Set up Tailscale <RiArrowRightLine size={16} />
          </a>
        </p>

        <h2>Turning it on or off</h2>
        <p>
          The first time a project's code connects to one of these sites, the playground asks
          whether it may use the relay, and keeps the answer for that project. Its settings (the
          gear in the project's top bar, under <em>Network</em>) change it later.
        </p>
      </main>
    </div>
  );
}
