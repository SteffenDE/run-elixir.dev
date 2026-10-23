// What the apex answers for a project's nodes (docs/frames.md): the exec
// frame's worker carries their connections here (exec/host.ts `apex`),
// each over a port of its own. Postgres (PGlite, kept in the apex's
// IndexedDB for a stored project) and Hex's cache, for the IDE's page and
// for embed.html alike; embed.html adds the ports its embedder answers.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { hstore } from '@electric-sql/pglite/contrib/hstore';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import type { Connection } from '@/runtime/host/node';
import { PortConnection } from '@/runtime/portConnection';
import { postgres } from '@/runtime/postgres';
import { pgliteDataDir } from '@/shared/lib/storage';
import { hex } from './hex';

export type Service = (connection: Connection) => void;

// A project's services: `id` is the stored project's (its Postgres kept),
// or null (a temporary one's, in memory). `others`: more services by name.
export function apexServices(id: string | null, others: Record<string, Service> = {}) {
  let db: Promise<PGlite> | null = null;
  // Started on the first connection to 5432.
  const database = (): Promise<PGlite> => {
    // The extensions Phoenix apps ask for (phx.gen.auth: citext), a few KB
    // each, for CREATE EXTENSION.
    const extensions = {
      citext,
      fuzzystrmatch,
      hstore,
      ltree,
      pg_trgm,
      pgcrypto,
      unaccent,
      uuid_ossp,
    };
    db ??= PGlite.create(id ? pgliteDataDir(id) : undefined, { extensions });
    return db;
  };
  // Postgres on 5432 for every node: one handler, so that the nodes'
  // connections take turns in PGlite's one session.
  const serveDatabase = postgres(database);
  const services: Record<string, Service> = { postgres: serveDatabase, hex, ...others };
  // Each remote node has a stand-in, which postgres.ts tells nodes apart by.
  const standIns = new Map<number, object>();
  return {
    database,
    serveDatabase,
    services,
    // A connection the exec frame carried here (rpc `connect`).
    connect(service: string, node: number, connection: number, port: MessagePort): void {
      const serve = services[service];
      if (!serve) return port.close();
      if (!standIns.has(node)) standIns.set(node, {});
      serve(new PortConnection(port, standIns.get(node)!, connection) as unknown as Connection);
    },
    async close(): Promise<void> {
      const pglite = await db?.catch(() => null);
      await pglite?.close().catch(() => {});
      db = null;
    },
  };
}

export type ApexServices = ReturnType<typeof apexServices>;
