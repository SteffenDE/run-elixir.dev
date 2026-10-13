// The user's projects: what each is, in IndexedDB (Dexie). A project's
// files and its database are stores of their own, named after its id
// (storage.ts), so deleting a project deletes them whole.
import Dexie, { type Table } from 'dexie';
import { randomName } from './names';

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

class Database extends Dexie {
  projects!: Table<Project, string>;

  constructor() {
    super('playground');
    this.version(1).stores({ projects: 'id, openedAt' });
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

export async function createProject(kind: Kind): Promise<Project> {
  const now = Date.now();
  const project = { id: newId(), name: randomName(), kind, createdAt: now, openedAt: now };
  await database.projects.add(project);
  return project;
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
  await database.projects.delete(id);
}
