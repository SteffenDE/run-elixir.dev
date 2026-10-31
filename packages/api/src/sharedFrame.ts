// A package's shared frames (docs/packages.md, `frames`): a page of the
// package's (`playground.frames`: NAME → its path, claude.html), framed
// once per page and kept, on an origin of its own on the shared domain
// (NAME-HASH, salted: usercontent.ts), whose storage every project of
// the page shares (the claude package's cache of Claude Code). Its
// package's page program asks for a port to it (exec/host.ts framePort);
// the frame's page takes each port (lib/sharedFrame.ts). The apex holds
// none of its code, and runs none of it.
import { transfer, type Transfer } from '@elixir-playground/runtime/lib/rpc';
import { FRAME_LOADED, FRAME_PORT } from '@elixir-playground/runtime/lib/sharedFrame';
import { bridgeFrame } from './bridge';
import { unseen } from './execFrame';
import { bridgeSalt, frameTable, nameOf, type Bridge } from './usercontent';

// A frame's name: an origin's first label with a hash after it. One
// letter is not one: e-KEY and v-KEY-PORT are the projects'.
const NAME = /^[a-z][a-z0-9]{1,15}$/;

type Framed = { element: HTMLIFrameElement; origin: string };
// By origin: one frame for every sandbox that uses it.
const loading = new Map<string, Promise<Framed>>();

// The origin of package `name`'s frame `frame` on the bridge's domain:
// another for each package and frame, and for each page (salted), so no
// other frame can tell it, nor share its storage.
export async function frameOrigin(bridge: Bridge, name: string, frame: string): Promise<string> {
  if (!NAME.test(frame)) throw new Error(`${name}: ${frame} is not a frame's name (${NAME})`);
  const hash = await nameOf(`frame:${bridgeSalt()}:${name}:${frame}`);
  return `${location.protocol}//${frame}-${hash}.${bridge.domain}`;
}

// The frame, framed once: its page below the bridge (`page`, the
// package's path for it).
function framed(bridge: Bridge, origin: string, page: string): Promise<Framed> {
  const known = loading.get(origin);
  if (known) return known;
  const made = new Promise<Framed>((resolve, reject) => {
    // Unseen, as the exec frame (a hidden frame's workers are slowed in WebKit).
    const element = unseen(document.createElement('iframe'));
    let unbridge = () => {};
    const failed = (message: string) => {
      removeEventListener('message', loaded);
      clearTimeout(timer);
      unbridge();
      element.remove();
      reject(new Error(message));
    };
    const timer = setTimeout(() => failed(`${origin}: the frame did not start`), 30000);
    unbridge = bridgeFrame(element, origin, page, frameTable(bridge.table), failed);
    const loaded = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== element.contentWindow) return;
      if (event.data?.kind !== FRAME_LOADED) return;
      removeEventListener('message', loaded);
      clearTimeout(timer);
      resolve({ element, origin });
    };
    addEventListener('message', loaded);
    document.body.append(element);
  }).catch((error: Error) => {
    if (loading.get(origin) === made) loading.delete(origin);
    throw error;
  });
  loading.set(origin, made);
  return made;
}

// A port to package `name`'s frame `frame`, whose page is `page` (relative
// to the package), for its page program. With it go the paths below the
// bridge of the package's peers (`peers`: their names) that the site has.
export async function framePort(
  bridge: Bridge,
  name: string,
  frame: string,
  page: string,
  peers: string[] = [],
): Promise<Transfer<MessagePort>> {
  const base = bridge.packages.get(name);
  if (!base) throw new Error(`${name}: not among the plugins`);
  const origin = await frameOrigin(bridge, name, frame);
  const { element } = await framed(bridge, origin, `${base}${page.replace(/^\.?\//, '')}`);
  const packages: Record<string, string> = {};
  for (const peer of peers) {
    const path = bridge.packages.get(peer);
    if (path) packages[peer] = path;
  }
  const channel = new MessageChannel();
  element.contentWindow!.postMessage({ kind: FRAME_PORT, packages }, origin, [channel.port2]);
  return transfer(channel.port1, [channel.port1]);
}
