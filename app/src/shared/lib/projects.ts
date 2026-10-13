// The user's projects: what each is, in IndexedDB (Dexie). A project's
// files and its database are stores of their own, named after its id
// (storage.ts), so deleting a project deletes them whole.
import Dexie, { type Table } from 'dexie';
import { randomName } from './names';
import type { Shared } from './share';

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

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID = /^[a-z0-9]{10}$/;

// Ten random letters and digits: the project's path (/ID/) and the name
// its stores are kept under.
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export function isId(text: string): boolean {
  return ID.test(text);
}

export async function createProject(kind: Kind, name = randomName()): Promise<Project> {
  const now = Date.now();
  const project = { id: newId(), name, kind, createdAt: now, openedAt: now };
  await database.projects.add(project);
  return project;
}

// A new project from a link: its files come with its first start.
export async function importProject(shared: Shared): Promise<Project> {
  return database.transaction('rw', database.projects, database.seeds, async () => {
    const project = await createProject(shared.kind, shared.name);
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
