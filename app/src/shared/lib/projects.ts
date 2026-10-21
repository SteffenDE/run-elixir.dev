// The user's projects: what each is, in IndexedDB (Dexie). A project's
// files and its database are stores of their own, named after its id
// (storage.ts), so deleting a project deletes them whole.
import Dexie, { type Table } from 'dexie';
import { newId } from './ids';
import { randomName } from './names';
import type { Shared } from './share';
import { siteTemplate, type Template } from './templates';

// phoenix: the phx.new template, its server and PGlite; empty: an empty
// /work. A temporary IEx is an empty project that is not stored.
export type Kind = 'phoenix' | 'empty';
export type WorkspaceKind = Kind | 'iex';

// Presets seed ordinary project settings; runtime startup reads the
// project's saved commands, including an explicitly empty value.
const STARTUP: Record<Kind, string> = {
  phoenix: 'cd playground && iex -S mix phx.server',
  empty: '',
};

export interface Project {
  id: string;
  name: string;
  kind: Kind;
  createdAt: number;
  openedAt: number;
  // The template it was made from (Phoenix; none for older projects until
  // they are opened).
  template?: Template;
  // Where it came from, if not this browser's own: a share link, or a
  // live session's fork. Such a project takes the user's settings (their
  // environment, /shared, the setup script) only once allowed (`trust`).
  origin?: 'link' | 'fork';
  trust?: boolean;
  // Its own settings (settings.ts): what its first shell runs at each start
  // (lines; empty: just a shell), and environment over the user's defaults.
  startup: string;
  env?: Record<string, string>;
  // The user's setup script ran in it (once, at its first start).
  setUp?: boolean;
}

// What a project made from a link starts with, until its first start
// lays it over the template.
interface Seed {
  id: string;
  shared: Shared;
}

// The user's settings for every project (settings.ts), under one key.
export interface SettingsRecord {
  key: string;
  value: unknown;
}

class Database extends Dexie {
  projects!: Table<Project, string>;
  seeds!: Table<Seed, string>;
  settings!: Table<SettingsRecord, string>;

  constructor() {
    super('playground');
    this.version(1).stores({ projects: 'id, openedAt' });
    this.version(2).stores({ seeds: 'id' });
    this.version(3).stores({ settings: 'key' });
    this.version(4)
      .stores({})
      .upgrade((transaction) =>
        transaction
          .table<Project>('projects')
          .toCollection()
          .modify((project) => {
            if (project.startup === undefined) project.startup = STARTUP[project.kind];
            else if (project.kind === 'phoenix' && project.startup.trim()) {
              // Older Phoenix commands ran in /work/playground implicitly.
              // Keep their meaning now that every shell starts in /work.
              project.startup = `cd playground\n${project.startup}`;
            }
          }),
      );
  }
}

export const database = new Database();

// A project's id (ids.ts).
export { isId, newId } from './ids';

export async function createProject(
  kind: Kind,
  name = randomName(),
  template?: Template,
): Promise<Project> {
  const now = Date.now();
  const made = template ?? (await siteTemplate(kind)) ?? undefined;
  // setUp false: the user's setup script runs at its first start (older
  // projects, with none, never run it).
  const project: Project = {
    id: newId(),
    name,
    kind,
    createdAt: now,
    openedAt: now,
    setUp: false,
    startup: STARTUP[kind],
  };
  if (made) project.template = made;
  await database.projects.add(project);
  return project;
}

// The template a project now takes its changes over, as the user saw.
export async function templateSeen(id: string, template: Template): Promise<void> {
  await database.projects.update(id, { template });
}

// A new project from a link or a live session's fork (`origin`), or a
// folder of this computer's (none): its files come with its first start.
export async function importProject(shared: Shared, origin?: 'link' | 'fork'): Promise<Project> {
  const template = shared.template ?? (await siteTemplate(shared.kind)) ?? undefined;
  return database.transaction('rw', database.projects, database.seeds, async () => {
    const project = await createProject(shared.kind, shared.name, template);
    if (origin) await database.projects.update(project.id, { origin });
    await database.seeds.put({ id: project.id, shared });
    return origin ? { ...project, origin } : project;
  });
}

// A project's own settings, and what the user allowed it.
export async function updateProject(
  id: string,
  changes: Partial<Pick<Project, 'trust' | 'startup' | 'env' | 'setUp'>>,
): Promise<void> {
  await database.projects.update(id, changes);
}

// The link's changes a project has yet to take (once).
export async function takeSeed(id: string): Promise<Shared | null> {
  const seed = await database.seeds.get(id);
  return seed?.shared ?? null;
}

export async function seedTaken(id: string): Promise<void> {
  await database.seeds.delete(id);
}

export function listProjects(): Promise<Project[]> {
  return database.projects.orderBy('openedAt').reverse().toArray();
}

export function getProject(id: string): Promise<Project | undefined> {
  return database.projects.get(id);
}

export async function openedProject(id: string): Promise<void> {
  await database.projects.update(id, { openedAt: Date.now() });
}

export async function renameProject(id: string, name: string): Promise<void> {
  await database.projects.update(id, { name });
}

export async function removeProject(id: string): Promise<void> {
  await database.transaction('rw', database.projects, database.seeds, async () => {
    await database.projects.delete(id);
    await database.seeds.delete(id);
  });
}
