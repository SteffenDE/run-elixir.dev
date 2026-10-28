// What the page answers for a project's nodes (docs/frames.md): the exec
// frame's worker carries their connections here (exec/host.ts `apex`),
// each over a port of its own. Hex's cache is the API's own; the plugins
// add theirs (pglite: Postgres); the sandbox adds the ports its caller
// serves.
import type { Connection } from '@elixir-playground/runtime/host/node';
import { PortConnection } from '@elixir-playground/runtime/portConnection';
import { hex } from '@elixir-playground/runtime/hex';
import type { Service } from './types';

export function apexServices(plugins: Record<string, Service>[]) {
  const services: Record<string, Service> = Object.assign({ hex }, ...plugins);
  // Each remote node has a stand-in, which postgres.ts tells nodes apart by.
  const standIns = new Map<number, object>();
  return {
    has: (service: string) => service in services,
    // A connection the exec frame carried here (rpc `connect`).
    connect(service: string, node: number, connection: number, port: MessagePort): void {
      const serve = services[service];
      if (!serve) return port.close();
      if (!standIns.has(node)) standIns.set(node, {});
      serve(new PortConnection(port, standIns.get(node)!, connection) as unknown as Connection);
    },
  };
}
