// A live session's host: this page runs the project, and guests see it
// through the relay (docs/collaboration.md). Everything a guest asks for
// is checked against what the host allows, done with the same functions
// the IDE calls (playground.ts), and what changes is sent to everyone,
// signed.
import * as Y from 'yjs';
import { built } from '@/project/lib/programs/tailwind';
import {
  FIRST_SESSION,
  connectServer,
  createFile,
  initialLines,
  live,
  local,
  onOutput,
  onTerminalMode,
  read,
  shareable,
} from '@/project/lib/playground';
import { HIDDEN, WORK, useStore } from '@/project/lib/store';
import type { WorkspaceKind } from '@/shared/lib/projects';
import { apexUrl } from '@/shared/lib/site';
import type { Template } from '@/shared/lib/templates';
import { fragment, newKeys, randomId, storedKeys, utf8, type StoredKeys } from './crypto';
import { PROTOCOL, Peer, type Message, type Received } from './peer';
import { startFollowing } from './follow';
import { setActiveSender, setCursorSender } from './presence';
import type { Connection } from '@/runtime/host/node';
import type { Joined } from './relay';
import {
  REMOTE,
  addSharedFile,
  dropAllSharedFiles,
  moveSharedFiles,
  removeSharedFiles,
  replaceText,
  sharedFile,
  sharedPaths,
} from './shared-files';
import { NONE, colorFor, permissionsOf, useLive, type Permissions, type Person } from './store';

export interface HostProject {
  id: string | null;
  kind: WorkspaceKind;
  name: string;
  template?: Template;
}

// What a reload needs to take the session up again (sessionStorage).
interface Stored {
  session: string;
  token: string;
  keys: StoredKeys;
  name: string;
  admit: boolean;
  everyone: Permissions;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const storageKey = (project: HostProject) => `playground-live:${project.id}`;

let peer: Peer | null = null;
let project: HostProject | null = null;
let stored: Stored | null = null;
let people = new Map<string, Person & { admitted: boolean; hello: boolean }>();
let joinedOnce = false;
let stops: (() => void)[] = [];
let joins = 0;
// Guests' connections to the app's servers (their previews), by guest and
// the guest's number for it.
const tunnels = new Map<string, Connection>();

export const isHosting = () => peer !== null;

// For a bug hunt, in the console: playgroundLive.debug() (set as a
// session starts).
const debug = {
  playgroundLive: {
    debug: () => ({
      role: 'host',
      me: peer?.id,
      cursor: peer?.id ? useLive.getState().cursors[peer.id] : undefined,
      active: useLive.getState().active,
      status: useLive.getState().status,
      relay: peer?.relay.debug(),
      guests: [...people.values()].map(({ id, name, admitted }) => ({ id, name, admitted })),
      tunnels: [...tunnels].map(([key, connection]) => ({
        key,
        ...(connection as { describe?: () => object }).describe?.(),
      })),
    }),
  },
};

// Starts a live session of `of` (or takes up the one a reload left).
export async function startSession(
  of: HostProject,
  options: { name: string; admit: boolean },
): Promise<void> {
  if (peer) return;
  const { keys, secrets, stored: storedSecrets } = await newKeys();
  const session = randomId(16);
  stored = {
    session,
    token: '',
    keys: storedSecrets,
    name: options.name,
    admit: options.admit,
    everyone: { ...NONE },
  };
  const link = new URL(apexUrl(`/live/${session}#${fragment(secrets)}`), location.href).href;
  useLive.getState().set({
    role: 'host',
    status: 'connecting',
    link,
    admit: options.admit,
    everyone: { ...NONE },
    perGuest: {},
    reason: null,
  });
  connect(of, keys, { admit: options.admit });
}

// A session this page hosted before a reload, if any.
export async function resumeSession(of: HostProject): Promise<void> {
  if (peer || !of.id) return;
  let saved: Stored | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(storageKey(of)) ?? 'null') as Stored | null;
  } catch {
    return;
  }
  if (!saved?.token) return;
  stored = saved;
  const keys = await storedKeys(saved.keys);
  const link = new URL(apexUrl(`/live/${saved.session}#${fragment(saved.keys)}`), location.href)
    .href;
  useLive.getState().set({
    role: 'host',
    status: 'connecting',
    link,
    admit: saved.admit,
    everyone: saved.everyone,
    perGuest: {},
    reason: null,
  });
  connect(of, keys, { token: saved.token });
}

function connect(
  of: HostProject,
  keys: Awaited<ReturnType<typeof storedKeys>>,
  params: Record<string, unknown>,
) {
  project = of;
  joinedOnce = false;
  Object.assign(globalThis, debug);
  peer = new Peer(stored!.session, 'host', params, keys, {
    joined,
    refused(reason) {
      finish(
        reason === 'taken'
          ? 'The session is open in another tab.'
          : `The relay refused the session (${reason}).`,
      );
    },
    news,
    receive: (received) => void receive(received).catch((error: Error) => console.warn(error)),
  });
}

function save() {
  if (!project?.id || !stored) return;
  try {
    sessionStorage.setItem(
      storageKey(project),
      JSON.stringify({
        ...stored,
        everyone: useLive.getState().everyone,
        admit: useLive.getState().admit,
      }),
    );
  } catch {
    // Not kept: a reload ends the session.
  }
}

function joined(answer: Joined) {
  if (answer.token) stored!.token = answer.token;
  peer!.relay.rejoinWith({ role: 'host', token: stored!.token });
  save();
  const host: Person & { admitted: boolean; hello: boolean } = {
    id: answer.id,
    name: stored!.name,
    color: colorFor(0),
    host: true,
    admitted: true,
    hello: true,
  };
  people = new Map([[answer.id, host]]);
  // Joined again: what the relay could not pass on meanwhile is lost, so
  // the guests' connections end (their previews ask again).
  for (const connection of tunnels.values()) connection.close();
  tunnels.clear();
  for (const participant of answer.participants)
    people.set(participant.id, {
      id: participant.id,
      name: '',
      color: colorFor(++joins),
      admitted: participant.admitted,
      hello: false,
      waiting: !participant.admitted,
    });
  useLive.getState().set({ status: 'live', me: answer.id });
  publishPeople();
  if (!joinedOnce) {
    joinedOnce = true;
    watch();
  }
  // After a reload: the guests say who they are again, and start over.
  if (answer.participants.length) void send({ t: 'who' });
}

function news(event: string, payload: Record<string, unknown>) {
  const id = payload.id as string;
  if (event === 'joined') {
    people.set(id, {
      id,
      name: '',
      color: colorFor(++joins),
      admitted: payload.admitted as boolean,
      hello: false,
      waiting: !payload.admitted,
    });
    publishPeople();
  } else if (event === 'admitted') {
    const person = people.get(id);
    if (!person) return;
    person.admitted = true;
    person.waiting = false;
    if (person.hello) void welcome(id);
    publishPeople();
  } else if (event === 'left') {
    people.delete(id);
    for (const [key, connection] of tunnels)
      if (key.startsWith(`${id}:`)) {
        tunnels.delete(key);
        connection.close();
      }
    leftSession(id);
    publishPeople();
  } else if (event === 'replaced') {
    finish('The session moved to another tab.', false);
  } else if (event === 'ended') {
    finish('The session ended.');
  }
}

// Who is in, for this page, and for the guests (the admitted, who said
// who they are).
function publishPeople() {
  const all = [...people.values()].filter((p) => p.hello || p.waiting);
  useLive.getState().set({
    people: all.map(({ id, name, color, host, waiting }) => ({ id, name, color, host, waiting })),
  });
  void send({ t: 'people', people: inSession() });
}

const inSession = () =>
  [...people.values()]
    .filter((p) => p.admitted && p.hello)
    .map(({ id, name, color, host }) => ({ id, name, color, host }));

function send(message: Message, bytes: Uint8Array | null = null, to: string | null = null) {
  return peer?.send(message, bytes, to) ?? Promise.resolve();
}

function reply(to: string, req: unknown, value: unknown = null, bytes: Uint8Array | null = null) {
  return send({ t: 'reply', req, ok: true, value }, bytes, to);
}

function refuse(to: string, req: unknown, error: string) {
  return send({ t: 'reply', req, ok: false, error }, null, to);
}

// What a joining guest sees first.
async function welcome(id: string) {
  const state = useStore.getState();
  const terminals = state.terminals;
  const modes: Record<number, boolean> = {};
  for (const term of terminals) onTerminalMode(term, (raw) => (modes[term] = raw))();
  await send(
    {
      t: 'welcome',
      protocol: PROTOCOL,
      you: id,
      people: inSession(),
      perms: permissionsOf(id),
      project: { kind: project!.kind, name: project!.name },
      paths: state.paths,
      cwd: local.searchPath(),
      terminals,
      modes,
      initial: Object.fromEntries(terminals.map((term) => [term, initialLines(term)])),
      previewPort: state.previewPort,
      cursors: useLive.getState().cursors,
      active: useLive.getState().active,
    },
    null,
    id,
  );
  for (const term of terminals) {
    let backlog = '';
    onOutput(term, (text) => (backlog += text))();
    if (backlog) await send({ t: 'output', term, replay: true }, utf8(backlog), id);
  }
}

// The project's changes, as they happen, to everyone.
function watch() {
  const outputs = new Map<number, () => void>();
  const pending = new Map<number, string>();
  let flushing: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    flushing = null;
    for (const [term, text] of pending) void send({ t: 'output', term }, utf8(text));
    pending.clear();
  };
  const watchTerminal = (term: number) => {
    let replaying = true;
    const off = onOutput(term, (text) => {
      if (replaying) return;
      pending.set(term, (pending.get(term) ?? '') + text);
      flushing ??= setTimeout(flush, 30);
    });
    replaying = false;
    const offMode = onTerminalMode(term, (raw) => void send({ t: 'mode', term, raw }));
    outputs.set(term, () => {
      off();
      offMode();
    });
  };
  for (const term of useStore.getState().terminals) watchTerminal(term);

  let tree: ReturnType<typeof setTimeout> | null = null;
  stops.push(
    useStore.subscribe((state, before) => {
      if (state.paths !== before.paths) {
        if (tree) clearTimeout(tree);
        tree = setTimeout(() => void send({ t: 'tree', paths: useStore.getState().paths }), 100);
      }
      if (state.terminals !== before.terminals) {
        for (const term of state.terminals) if (!outputs.has(term)) watchTerminal(term);
        for (const [term, stop] of outputs)
          if (!state.terminals.includes(term)) {
            stop();
            outputs.delete(term);
          }
        void send({ t: 'terminals', terminals: state.terminals });
      }
      if (state.previewPort !== before.previewPort)
        void send({ t: 'preview', port: state.previewPort });
      // A save's reload, and Tailwind's new CSS, in the guests' previews too.
      if (state.previewKey !== before.previewKey) void send({ t: 'reload' });
    }),
    () => {
      for (const stop of outputs.values()) stop();
      if (flushing) clearTimeout(flushing);
    },
  );
  const css = () => void send({ t: 'css' });
  built.add(css);
  stops.push(() => {
    built.delete(css);
    for (const connection of tunnels.values()) connection.close();
    tunnels.clear();
  });

  live.moved = hostMoved;
  live.removed = hostRemoved;
  live.saved = (path, text) => {
    const file = sharedFile(path);
    if (!file) return;
    file.saved = text;
    void send({ t: 'saved', path, text });
  };
  // Files the nodes changed: open ones without unsaved changes take the
  // new text, as tabs do.
  live.changed = async (paths) => {
    const handled = new Set<string>();
    for (const path of paths) {
      const file = sharedFile(path);
      if (!file) continue;
      handled.add(path);
      if (file.text.toString() !== file.saved) continue;
      let text: string;
      try {
        text = decoder.decode(await read(path));
      } catch {
        continue;
      }
      if (text === file.saved) continue;
      replaceText(file.text, text, REMOTE);
      file.saved = text;
      useStore.getState().saved(path, text);
      void send({ t: 'saved', path, text });
    }
    return handled;
  };
  setActiveSender((path) => {
    const me = useLive.getState().me;
    if (me) useLive.getState().setActive(me, path);
    void send({ t: 'active', path });
  });
  startFollowing();
  setCursorSender((cursor) => {
    const me = useLive.getState().me;
    if (me) useLive.getState().setCursor(me, cursor);
    void send({ t: 'cursor', cursor });
  });
}

// A file's shared document, made when someone first opens it: from the
// host's tab if it has one (with its unsaved text), else from /work.
async function documentFor(path: string) {
  const existing = sharedFile(path);
  if (existing) return existing;
  const tab = useStore.getState().tabs.find((t) => t.path === path);
  let text: string;
  let saved: string;
  if (tab) {
    text = tab.draft;
    saved = tab.saved;
  } else {
    text = decoder.decode(await read(path));
    saved = text;
  }
  // Another request may have made it meanwhile.
  const again = sharedFile(path);
  if (again) return again;
  const doc = new Y.Doc();
  doc.getText('text').insert(0, text);
  const file = addSharedFile(path, doc, saved);
  doc.on('update', (update: Uint8Array) => void send({ t: 'update', path: file.path }, update));
  return file;
}

const below = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.startsWith(`${WORK}/`) &&
  !path.split('/').some((part) => part === '..' || HIDDEN.includes(part));

async function receive({ from, message, bytes }: Received) {
  const person = people.get(from);
  if (!person) return;
  const { t, req } = message;
  if (t === 'hello') {
    if (message.protocol !== PROTOCOL) {
      await send({ t: 'outdated' }, null, from);
      return kick(from);
    }
    person.name =
      String(message.name ?? '')
        .trim()
        .slice(0, 40) || 'Guest';
    person.hello = true;
    if (person.admitted) await welcome(from);
    publishPeople();
    return;
  }
  if (!person.admitted || !person.hello) return;
  const can = permissionsOf(from);
  const path = message.path;
  switch (t) {
    case 'cursor':
      useLive.getState().setCursor(from, (message.cursor as never) ?? null);
      return;
    case 'active':
      useLive.getState().setActive(from, typeof path === 'string' ? path : null);
      return;
    case 'open':
      if (!below(path)) return refuse(from, req, 'not a project file');
      try {
        const file = await documentFor(path);
        return reply(from, req, { saved: file.saved }, Y.encodeStateAsUpdate(file.doc));
      } catch {
        return refuse(from, req, 'This file is not text.');
      }
    case 'read':
      if (!below(path)) return refuse(from, req, 'not a project file');
      return read(path).then(
        (data) => reply(from, req, null, data),
        (error: Error) => refuse(from, req, error.message),
      );
    case 'stat':
      return reply(from, req, below(path) ? await local.stat(path) : null);
    case 'update': {
      const file = typeof path === 'string' ? sharedFile(path) : undefined;
      if (!file || !bytes) return;
      if (!can.edit) {
        // Edits it may not make: it starts over from the host's text.
        return send({ t: 'reset', path, saved: file.saved }, Y.encodeStateAsUpdate(file.doc), from);
      }
      Y.applyUpdate(file.doc, bytes, REMOTE);
      return;
    }
    case 'save': {
      const file = typeof path === 'string' ? sharedFile(path) : undefined;
      if (!can.edit) return refuse(from, req, 'The host has not let you edit.');
      if (!file) return refuse(from, req, 'This file is not open.');
      await local.save(file.path, file.text.toString());
      return reply(from, req);
    }
  }
  // The rest change the project.
  if (['create', 'move', 'remove'].includes(t)) {
    if (!can.edit) return refuse(from, req, 'The host has not let you edit.');
    try {
      if (t === 'create' && below(path)) {
        if (message.dir) await local.createDirectory(path);
        else await createFile(path, false);
      } else if (t === 'move' && below(message.from) && below(message.to)) {
        await local.movePath(message.from, message.to);
      } else if (t === 'remove' && below(path)) {
        await local.removePath(path);
      } else return refuse(from, req, 'not a project file');
      return reply(from, req);
    } catch (error) {
      return refuse(from, req, (error as Error).message);
    }
  }
  if (['input', 'interrupt', 'open-terminal', 'close-terminal', 'restart'].includes(t)) {
    if (!can.terminal) return refuse(from, req, 'The host has not let you use the terminals.');
    const term = Number(message.term);
    if (t === 'input') local.type(term, String(message.text ?? ''));
    else if (t === 'interrupt') local.interrupt(term);
    else if (t === 'open-terminal') local.openTerminal();
    else if (t === 'close-terminal' && term !== FIRST_SESSION) {
      local.closeTerminal(term);
    } else if (t === 'restart') local.restartServer();
    return req === undefined ? undefined : reply(from, req);
  }
  if (t.startsWith('tcp-')) return tunnel(from, message, bytes);
  if (t === 'fork') {
    if (!can.fork) return refuse(from, req, 'The host has not let you fork.');
    const shared = await shareable(project!.name, project!.template);
    // Unsaved text in the session goes with it.
    for (const open of sharedPaths()) {
      const file = sharedFile(open)!;
      if (file.text.toString() !== file.saved)
        shared.files[open.slice(WORK.length + 1)] = file.text.toString();
    }
    return reply(from, req, shared);
  }
}

// A guest's preview's connection to the app, its bytes both ways; what
// the app sends goes out every few milliseconds, together.
function tunnel(guest: string, message: Message, bytes: Uint8Array | null) {
  const conn = Number(message.conn);
  const key = `${guest}:${conn}`;
  const open = tunnels.get(key);
  if (message.t === 'tcp-data' && bytes) open?.write(bytes);
  else if (message.t === 'tcp-end') open?.end();
  else if (message.t === 'tcp-close') {
    tunnels.delete(key);
    open?.close();
  } else if (message.t === 'tcp-open' && !open) {
    const connection = connectServer(Number(message.port));
    if (!connection) return send({ t: 'tcp-close', conn, why: 'refused' }, null, guest);
    tunnels.set(key, connection);
    let pending: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!size) return;
      const data = new Uint8Array(size);
      let at = 0;
      for (const chunk of pending) {
        data.set(chunk, at);
        at += chunk.length;
      }
      pending = [];
      size = 0;
      void send({ t: 'tcp-data', conn }, data, guest);
    };
    connection.ondata = (data) => {
      pending.push(data.slice());
      size += data.length;
      if (size >= 128 * 1024) flush();
      else timer ??= setTimeout(flush, 5);
    };
    connection.onend = () => {
      flush();
      void send({ t: 'tcp-end', conn }, null, guest);
    };
    connection.onclose = (why) => {
      flush();
      if (tunnels.delete(key)) void send({ t: 'tcp-close', conn, why }, null, guest);
    };
  }
}

// The tree's moves and removals (the host's own, and guests'), for the
// session's files and the guests' tabs.
function hostMoved(from: string, to: string): void {
  moveSharedFiles(from, to);
  void send({ t: 'moved', from, to });
}

function hostRemoved(path: string): void {
  removeSharedFiles(path);
  void send({ t: 'removed', path });
}

// The host's switches.
export function setEveryone(perms: Permissions): void {
  useLive.getState().set({ everyone: perms, perGuest: {} });
  save();
  for (const id of people.keys()) if (id !== peer?.id) void send({ t: 'perms', perms }, null, id);
}

export function setGuest(id: string, perms: Partial<Permissions>): void {
  const { perGuest } = useLive.getState();
  useLive.getState().set({ perGuest: { ...perGuest, [id]: { ...perGuest[id], ...perms } } });
  void send({ t: 'perms', perms: permissionsOf(id) }, null, id);
}

export function setAdmission(on: boolean): void {
  useLive.getState().set({ admit: on });
  save();
  void peer?.relay.command('admission', { on });
}

export function admit(id: string): Promise<void> {
  return peer?.relay.command('admit', { id }) ?? Promise.resolve();
}

export function kick(id: string): Promise<void> {
  return peer?.relay.command('kick', { id }) ?? Promise.resolve();
}

export async function endSession(): Promise<void> {
  await peer?.relay.command('end').catch(() => {});
  finish(null);
}

function finish(reason: string | null, forget = true) {
  peer?.close();
  peer = null;
  for (const stop of stops) stop();
  stops = [];
  live.saved = undefined;
  live.changed = undefined;
  live.moved = undefined;
  live.removed = undefined;
  setCursorSender(null);
  setActiveSender(null);
  dropAllSharedFiles();
  people.clear();
  if (forget && project?.id) {
    try {
      sessionStorage.removeItem(storageKey(project));
    } catch {
      // Nothing kept.
    }
  }
  useLive.getState().set({
    role: null,
    status: 'ended',
    reason,
    link: null,
    people: [],
    cursors: {},
    active: {},
    following: null,
    me: null,
  });
}

// Someone left: their cursor and file go, and following them ends.
function leftSession(id: string) {
  const state = useLive.getState();
  state.setCursor(id, null);
  state.setActive(id, null);
  if (state.following === id) state.set({ following: null });
}
