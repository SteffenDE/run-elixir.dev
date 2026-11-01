// What the page answers for a project's nodes (docs/frames.md): the exec
// frame's worker carries their connections here (exec/host.ts `apex`),
// each over a port of its own: the plugins' services (pglite's Postgres,
// the elixir package's Hex cache); the sandbox adds the ports its caller
// serves.
import { PortConnection } from '@elixir-playground/runtime/portConnection';
import type { Service, ServiceConnection } from './types';

export function apexServices(plugins: Record<string, Service>[]) {
  const services: Record<string, Service> = Object.assign({}, ...plugins);
  // Each remote node has a stand-in, which postgres.ts tells nodes apart by.
  const standIns = new Map<number, object>();
  return {
    has: (service: string) => service in services,
    // A connection the exec frame carried here (rpc `connect`).
    connect(service: string, node: number, connection: number, port: MessagePort): void {
      const serve = services[service];
      if (!serve) return port.close();
      if (!standIns.has(node)) standIns.set(node, {});
      serve(new PortConnection(port, standIns.get(node)!, connection) as ServiceConnection);
    },
  };
}
