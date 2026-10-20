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

export interface Project {
  id: string;
  name: string;
  kind: Kind;
  createdAt: number;
  openedAt: number;
  // The template it was made from (Phoenix; none for older projects until
  // they are opened).
  template?: Template;
}

// What a project made from a link starts with, until its first start
// lays it over the template.
interface Seed {
  id: string;
  shared: Shared;
}

class Database extends Dexie {
  projects!: Table<Project, string>;
  seeds!: Table<Seed, string>;

  constructor() {
    super('playground');
    this.version(1).stores({ projects: 'id, openedAt' });
    this.version(2).stores({ seeds: 'id' });
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
  const project: Project = { id: newId(), name, kind, createdAt: now, openedAt: now };
  if (made) project.template = made;
  await database.projects.add(project);
  return project;
}

// The template a project now takes its changes over, as the user saw.
export async function templateSeen(id: string, template: Template): Promise<void> {
  await database.projects.update(id, { template });
}

// A new project from a link: its files come with its first start.
export async function importProject(shared: Shared): Promise<Project> {
  const template = shared.template ?? (await siteTemplate(shared.kind)) ?? undefined;
  return database.transaction('rw', database.projects, database.seeds, async () => {
    const project = await createProject(shared.kind, shared.name, template);
    await database.seeds.put({ id: project.id, shared });
    return project;
  });
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
