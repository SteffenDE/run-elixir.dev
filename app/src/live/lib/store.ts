// A live session as this page takes part in it: as its host or a guest,
// who is in it, what each may do, and where their cursors are.
import { create } from 'zustand';

export interface Permissions {
  edit: boolean;
  terminal: boolean;
  fork: boolean;
}

export const NONE: Permissions = { edit: false, terminal: false, fork: false };

export interface Person {
  id: string;
  name: string;
  color: string;
  host?: boolean;
  // Waiting to be let in (the host's Admit).
  waiting?: boolean;
}

// Where a person's cursor is: a file, and Yjs relative positions
// (base64), which stay put while the text around them changes.
export interface Cursor {
  path: string;
  anchor: string;
  focus: string;
  // The caret's line (one-based), for following it.
  line: number;
}

export type LiveStatus =
  | 'connecting'
  | 'waiting' // for the host to let this guest in
  | 'live'
  | 'reconnecting' // the host's page went away, for now
  | 'ended'
  | 'refused'; // the relay or the host would not have this guest

interface LiveState {
  role: 'host' | 'guest' | null;
  status: LiveStatus;
  // Why it ended or was refused, for people.
  reason: string | null;
  // The host's link to share.
  link: string | null;
  me: string | null;
  people: Person[];
  // The host's: what guests may do (`everyone`, and per guest), and
  // whether guests wait to be let in.
  everyone: Permissions;
  perGuest: Record<string, Partial<Permissions>>;
  admit: boolean;
  // The host's choice: no tailnet for the project while a guest who may
  // type or edit is in (docs/tailscale.md); off unless chosen.
  tailnetOff: boolean;
  // The host's choice: none of the user's settings (settings.ts: their
  // environment in new shells, /shared) while a guest who may type or
  // edit is in; on unless chosen otherwise.
  settingsOff: boolean;
  // A guest's own.
  mine: Permissions;
  cursors: Record<string, Cursor>;
  // The file each person has in front of them (their active tab), and
  // whom this page follows (their file opens here, and their caret stays
  // in view): a guest follows the host from the start.
  active: Record<string, string | null>;
  following: string | null;
  // Following, but this page's editor has focus: its own caret is the
  // one in view (Escape follows again). 'quiet' once its notice is closed.
  detached: 'notice' | 'quiet' | null;
  setActive(id: string, path: string | null): void;
  // A guest's: bumped by each welcome, which starts the IDE over.
  generation: number;
  set(partial: Partial<LiveState>): void;
  setCursor(id: string, cursor: Cursor | null): void;
}

export const useLive = create<LiveState>((set) => ({
  role: null,
  status: 'connecting',
  reason: null,
  link: null,
  me: null,
  people: [],
  everyone: { ...NONE },
  perGuest: {},
  admit: false,
  tailnetOff: false,
  settingsOff: true,
  mine: { ...NONE },
  cursors: {},
  active: {},
  following: null,
  detached: null,
  setActive: (id, path) => set((state) => ({ active: { ...state.active, [id]: path } })),
  generation: 0,
  set: (partial) => set(partial),
  setCursor: (id, cursor) =>
    set((state) => {
      const cursors = { ...state.cursors };
      if (cursor) cursors[id] = cursor;
      else delete cursors[id];
      return { cursors };
    }),
}));

export function permissionsOf(id: string): Permissions {
  const { everyone, perGuest } = useLive.getState();
  return { ...everyone, ...perGuest[id] };
}

// Colors for people, in the order they join (the host's is the first).
const COLORS = [
  '#e5532d',
  '#2f7de1',
  '#2ea36b',
  '#a052d6',
  '#d69a1a',
  '#d6417f',
  '#1aa3a8',
  '#7a8a1a',
];

export const colorFor = (index: number) => COLORS[index % COLORS.length];

// The name people know this browser by, asked once.
const NAME = 'playground-name';

export function savedName(): string {
  try {
    return localStorage.getItem(NAME) ?? '';
  } catch {
    return '';
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(NAME, name);
  } catch {
    // Not kept: asked again next time.
  }
}

// This page hosts a live session with a guest in who may type into its
// terminals or edit its files: who runs code in its project.
export function guestMayType(): boolean {
  const { role, people } = useLive.getState();
  if (role !== 'host') return false;
  return people.some((person) => {
    if (person.host || person.waiting) return false;
    const may = permissionsOf(person.id);
    return may.terminal || may.edit;
  });
}
