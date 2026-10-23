// The site's TCP relay's list (backend/priv/relay/hosts.json,
// docs/relay.md): which HTTPS connections go through it (relay.ts), for the
// exec frame's gateway, and which requests a Node.js process's https
// sends by fetch() all the same (http.ts), for a host whose other paths
// send no CORS headers.
import list from '../../../backend/priv/relay/hosts.json';

const listed = (host: string, names: string[]) => {
  host = host.toLowerCase().replace(/\.$/, '');
  return names.some((name) =>
    name.startsWith('*.') ? host.endsWith(name.slice(1)) : host === name,
  );
};

// Whether a connection to host:port goes through the relay: a listed host
// on its port that sends no CORS headers (those that do, the gateway's
// fetch() reaches from the user's own address, sparing the relay).
export const relayed = (host: string, port: number): boolean =>
  port === list.port && listed(host, list.hosts) && !listed(host, list.fetch);

// Whether a request to https://host/path goes by the gateway's fetch()
// rather than the relay: a path of the host's that sends CORS headers.
export const fetchable = (host: string, path: string): boolean => {
  const paths = (list.fetch_paths as Record<string, string[]>)[
    host.toLowerCase().replace(/\.$/, '')
  ];
  return !!paths?.includes(path.split(/[?#]/)[0]);
};
