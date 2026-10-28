// The pglite plugin (@elixir-playground/pglite, part of
// @elixir-playground/standard): Postgres on port 5432 for the project's
// nodes, PGlite on the page. A kept project's database is in this page's
// IndexedDB (/pglite/playground-pg-KEY); another's is in memory.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { hstore } from '@electric-sql/pglite/contrib/hstore';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { postgres } from '@/runtime/postgres';
import { pgliteDataDir } from '@/shared/lib/stores';
import type { ApexContext, ApexInstance, ApexPlugin } from './types';

export const PGLITE_PLUGIN = '@elixir-playground/pglite';

// One sandbox's Postgres: started on the first connection.
export interface PgliteInstance extends ApexInstance {
  database(): Promise<PGlite>;
  // What its sessions wait for (runtime/postgres.ts), for a bug hunt.
  debug(): unknown;
}

export function pgliteInstance({ projectId, persist }: ApexContext): PgliteInstance {
  let db: Promise<PGlite> | null = null;
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
    db ??= PGlite.create(persist ? pgliteDataDir(projectId) : undefined, { extensions });
    return db;
  };
  // One handler for every node, so that their connections take turns in
  // PGlite's one session.
  const serve = postgres(database);
  return {
    services: { postgres: serve },
    database,
    debug: () => serve.debug(),
    async close() {
      const pglite = await db?.catch(() => null);
      await pglite?.close().catch(() => {});
      db = null;
    },
  };
}

export const pglite = (): ApexPlugin => ({ name: PGLITE_PLUGIN, apex: pgliteInstance });

export default pglite;
