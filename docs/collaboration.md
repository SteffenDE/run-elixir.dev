---
kind: design
status: live
last_updated: 2026-10-16
---

# Sharing and live sessions

*Share* makes a link to a copy of the project, or starts a live session of
it: others join the project as it runs in this tab. This covers how a live
session works, what the relay sees, and what is left
([below](#not-built-yet)). The link is [projects.md](projects.md#sharing)'s.

Code: `app/src/live` (the session), `backend/lib/playground/live*` and
`backend/lib/playground_web/channels` (the relay). Tests:
`app/test/e2e/live.spec.ts` and `live-domain.spec.ts`
([testing.md](testing.md)), `backend/test/playground_web/channels`.

## What *Share* offers

*Share* in the top bar opens a popover with two choices
(`project/components/ShareButton.tsx`):

| | Link | Live session |
| --- | --- | --- |
| What the other side gets | A copy: a new project of their own, made from the project's changes (`/import#DATA`). | This project, as it runs in this tab: files, open editors, terminals, preview. |
| Server | None (the fragment never reaches it). Later, optionally, a stored share ([below](#later-stored-shares-and-accounts)). | The backend's `/socket` relays encrypted messages between the browsers. It cannot read them. |
| Lifetime | For ever. | While the host's tab runs the session (at most 24 hours). |
| Guests can | Everything (it is their project). | Watch; edit, use the terminals and fork only if the host allows it. |

A temporary IEx has no link, only a live session (showing someone an IEx).
While a session runs, the button reads *Live*, shows who is in, and opens
on the session's panel: its link, who is in and what each may do, who
waits to be let in, and *End live session* (`live/components/HostPanel.tsx`).

## A live session

### Who runs what

**The host's tab runs the project; guests run no nodes.** A guest's page
is the IDE over a remote workspace: the components call `workspace()`
(`project/lib/workspace.ts`), which in a project's page is its nodes
(`playground.ts`'s `local`) and in a guest's page asks the host
(`live/lib/guest.ts`'s `remote`). The host does what a guest asks with
the same functions its own IDE calls (`live/lib/host.ts`).

- One truth: one `/work`, one database, one server. Two browsers each
  running the project would diverge (Mix's builds, PGlite, the server's
  state) with no way to reconcile.
- Guests start in a second: no runtime download, no boot. A phone can
  join.

The cost: the session ends with the host's tab, and every request of a
guest's preview crosses the relay twice.

### The link

```
https://DOMAIN/live/ID#k=KEY&h=HOSTKEY
```

- `ID`: 128 random bits, base64url. The Phoenix topic is `live:ID`.
- `KEY`: a random AES-256-GCM key, made by the host's browser.
- `HOSTKEY`: the host's Ed25519 public key. Guests take the session's
  state only from what the host signed ([why](#permissions)).

The fragment never reaches a server. Anyone with the link can read the
session, so it is the secret: the panel says so, and the host sees who is
in.

On a project domain a guest's page runs on an origin of its own,
`l-ID.DOMAIN` (lowercased; `shared/lib/site.ts`): the host's app runs in
the guest's preview and must not share an origin with the guest's
projects or the apex. `DOMAIN/live/ID` goes there, the page adding the
fragment itself. Without a project domain the guest's page is the site's
`/live/ID`, as projects share the one origin there.

A guest's page asks for a name (kept in local storage, as the host's is),
then joins.

### The relay

`PlaygroundWeb.LiveChannel` on the backend's `/socket`
([backend.md](backend.md#live-sessions-relay)). It knows nothing about
projects:

- `join "live:ID"` with `role: "host"` makes the session
  (`Playground.Live.Session`) and answers a host token, kept for a
  reload; the host joins again with it. Guests join sessions that exist.
- Each participant gets an id from the session; the relay stamps `from`
  on what it passes on.
- `b` (binary): to every other admitted participant. `s` (binary, a
  target id first): to one. Both arrive as `m`.
- The host's commands: `admission` (ask before letting guests in),
  `admit`, `kick` and `end`. A guest waiting to be let in reaches only the
  host and hears nothing else, enforced by the relay.
- News: `joined`, `admitted`, `left`, `host` (gone for now, or back),
  `kicked`, `ended`, `replaced` (the host joined again from elsewhere).
- Limits (`config/config.exs`): 16 participants, 256 KiB a message, 1 MiB
  and 200 messages a second per participant with four seconds' worth at
  once, 30 s for a host to come back, 24 hours a session. A message over
  the rate waits (and those after it, so the order holds); a participant
  with more than 1,000 waiting is closed. The page paces itself under them
  (`live/lib/relay.ts`), and never sends a message again: a receiver drops
  one older than what it has seen. Sockets only from the site's origins
  (`PLAYGROUND_ORIGINS` in production).
- A preview's connections through the relay end when the host goes away
  or either side joins again (a lost connection): what the relay could not
  pass on meanwhile is lost, and the preview asks again.
- Nothing is stored. The relay knows ids, roles and who is admitted;
  names travel encrypted.

What the server does see: IP addresses, when and how much each
participant sends, how many are in a session, and how long it lasts.

A kicked guest's channel is closed. The link still works for it: it can
join again as a new guest, unless the host asks before letting people in.

### Encryption

`live/lib/peer.ts`, all WebCrypto (`live/lib/crypto.ts`). On the wire,
each message is an 8-byte sequence number and the AES-256-GCM ciphertext
with its random 96-bit nonce. The additional data is the session, the
sender's id (as the relay stamps it) and the sequence number, so a message
cannot be moved to another session or sender; a receiver drops a number it
has seen from that sender (numbers start from the clock, so a host's
reload keeps them growing). Inside: JSON and, if any, bytes (Yjs updates,
terminal output, a connection's data). Messages over 192 KiB go as parts
and are put back together.

Everything the host sends is signed with its Ed25519 key, inside the
ciphertext. The signature is over a SHA-256 digest of the message: WebKit
crashes its page signing 64 KB or more. WebKit also fails about one Ed25519
key generation in a hundred, which is tried again.

### Permissions

The host decides, at any time, for everyone and for each guest:

| Permission | Default | Lets a guest |
| --- | --- | --- |
| Watch | always | See the tree, open files, see others' cursors, terminal output and the preview. |
| Edit | off | Edit files, create, rename and delete them, save. |
| Terminals | off | Type into terminals, open and close them, restart the server. This is full control of the project (and its network), so it is its own switch, worded as such. |
| Fork | off | Make a project of their own from the session's current state. |

*Ask me before letting each person in* (off by default) is the host's:
the relay keeps a new guest waiting, and the panel shows its name with
*Let in* and *Turn away*.

Everyone with the link holds the key, so a watching guest could encrypt
an edit and send it. So guests apply **only what the host signed**: an
editing guest sends its edits to the host, which checks the permission,
applies them and sends them on, signed. Edits the host refuses come back
as the host's text (`reset`). Cursors are the one thing guests send
everyone directly, and take from each other unsigned.

A guest's page shows what it may do: without *Edit* the tree has no
buttons, menu or dragging, the editor drops keys and input that change
the text (moving, selecting, copying and finding still work), and there
is no save button; without *Terminals* the terminals take no input.

### Joining

1. The guest's page joins the topic and sends `hello`: its name and the
   protocol version (`PROTOCOL`, `peer.ts`). A guest speaking another is
   told to reload and removed.
2. The host answers with `welcome`: who is in and their colors, the
   guest's permissions, the project's kind and name, the tree, the
   terminals (with their first command lines and modes) and the preview's
   port, then each terminal's output so far.
3. A file's text comes when the guest opens it (`open`, below).

After the host's reload the host asks everyone to say `hello` again
(`who`), and each guest's IDE starts over from the new `welcome`
(the open tabs come back from the host).

### Files and editing

`live/lib/shared-files.ts`. A file open in the session is a **Yjs**
document (`Y.Text`), made by the host when someone first opens it (from
the host's tab, unsaved text included, else from `/work`) and kept for
the session. Yjs merges concurrent edits, and its updates are opaque
bytes that encrypt like anything else. Each update to a document goes to
everyone, signed; guests that have the file apply it. The host's own
editor is bound to the document like the guests'.

The editor (@pierre/diffs 1.5.2, `project/components/Editor.tsx`) is bound
to a document while one exists for its file:

- **Others' cursors:** `editor.setCarets(...)` with `renderCaret`, a bar
  and the person's name in their color. Cursors travel as Yjs relative
  positions, so they stay put as the text changes.
- **Local edits out:** the editor's change event gives offsets in the text
  before the change; they go into the `Y.Text`, last first.
- **Remote edits in:** `editor.applyEdits` on the attached editor, which
  keeps the local selection where it belongs, flagged so they do not come
  back out.
- **Undo:** ⌘Z and ⌘⇧Z (Ctrl+Y elsewhere, and the browser's undo) are
  taken before the editor and go to a `Y.UndoManager` that undoes only
  this editor's edits. The editor's own history is cleared after each
  remote edit, since it would undo others' typing.

**Saving** stays explicit: the document is the draft everyone sees;
*Save* (by anyone who may edit) writes it to the host's `/work`, and the
dirty mark is everyone's. The host's nodes see the saved file, as before,
and Phoenix's reload follows a save, in everyone's preview.

**Changes on disk** (a generator, `mix format`) reach everyone's tree. A
file with a document and no unsaved changes takes the new text as one
replacement on the `Y.Text`, so carets and undo survive. One with unsaved
changes keeps them, as a tab does without a session; saving writes them
over the disk's.

Tree operations are requests to the host, which applies them and sends
the new tree; moves and removals move or close everyone's tabs.

A binary file does not open for a guest (there is no text to share).

### Terminals

The host sends each terminal's output, in batches of 30 ms, to everyone.
A guest's terminal fits its own panel; the node keeps the host's size, so
a narrower guest sees long lines wrapped where the host's terminal wraps
them. With *Terminals*, the guest's input and Ctrl+C go to the host's
node, and the guest may open and close terminals (not the first) and
restart the server.

### The preview

A guest's preview runs the host's app as itself: its own cookies, its own
LiveView. The guest's page runs a bridge (`runtime/bridge.ts`) and a
service worker as a project's page does; the bridge's connections are
tunnelled through the relay (`tcp-open`, `tcp-data`, `tcp-end`,
`tcp-close`) to the host, which connects them to the node that serves the
port (only servers' ports: not PGlite's, not Mix's locks). HTTP, cookies
and WebSockets are the guest's bridge's, as they are for the host's own
preview. The host's data goes out every 5 ms or 128 KiB, so a page's
assets are a few messages.

The host's preview reloads (after a save, a new esbuild bundle) and
Tailwind's new CSS reach the guests' previews.

### Presence

Names (chosen on joining), colors (by the order people joined), where
each cursor is (with its line), and the file each person has in front of
them (their active tab, `active`). Both go from everyone to everyone,
unsigned: they only say where someone is. The top bar shows who is in.

### Following

`live/lib/follow.ts`. Following someone, the file in front of them opens
here at their caret's line, and as their caret moves it stays in view
(scrolled to where the editor draws it; outside what the editor has
rendered, scrolled to its line first). Following never focuses the
editor: that would move this page's caret, which the editor keeps in
view on each of their edits, and the two would pull the view back and
forth. While this page types in their file, its own caret is the one in
view; Escape there goes back to theirs (unless it closes the editor's
search or leaves one of several carets). A guest follows the host from
the start; the top bar says *Following NAME · Stop*, else offers *Follow
NAME* (the host). Clicking anyone's initials in a guest's top bar follows
them, or stops; the host follows a guest from the session's panel.

Choosing another file here (the tree, a tab, a terminal's link) stops
following: the active tab changed to a file that is not theirs. Typing in
their file does not. Following again opens theirs.

### When the host goes away

- **Reload:** the host keeps the session's id, token and keys in
  `sessionStorage` and joins again; the relay keeps the session for 30 s
  and guests show *The host is away*. The documents are made again from
  `/work` (and the host's tabs), so unsaved text the host's page held is
  lost.
- ***End live session***, or the tab closed for longer than 30 s: guests
  are told, and keep a read-only view of what they had open until they
  leave.
- **Open it here** in another tab of the host's (one tab per project,
  [projects.md](projects.md#one-tab-per-project)) ends the session first.

### Forking

A guest with *Fork* asks the host for the project as `shareable()` makes
it for a link, with the documents' unsaved text, in parts (no URL limit).
It becomes a project of the guest's browser in a new tab: made directly
where the guest's page shares the projects' origin, else (a guest's own
origin on a project domain) through the apex's `/import#DATA` page, where
a link's limits apply.

## Not built yet

- **Key rotation** after a kick (each guest sends an X25519 public key on
  joining; the host sends the new key to each). Until then the answer to
  a leaked link is ending the session and starting a new one.
- **Presence on tabs and the tree** (who has which file open).
- **A guest's preview cache:** every asset crosses the relay each time.
- **Deploying on a site without a project domain**
  (elixir-playground.steffend.me): Caddy routes `/socket` only on
  run-elixir.dev, and the backend lets only its origins in
  ([deploy.md](deploy.md)).

## Later: stored shares and accounts

A link holds what a URL can. A stored share puts the same payload,
encrypted in the browser, on the backend: `/s/ID#KEY`, the key again in
the fragment, so the server keeps bytes it cannot read, with a size limit
and an expiry. That needs no accounts.

Accounts come after: a signed-in user's projects kept on the server with
a lasting id or slug, opened from any browser, and a stored share that
can be updated in place. Whether those are encrypted too (with a key the
account holds) is open.

WebRTC between the browsers (less relay traffic for previews) is for
later too; the relay would then carry its signalling and stay the
fallback.

## Open questions

- Edits through the host cost a round trip and the host's tab; whether
  editors should also apply each other's updates directly once they hold
  per-guest keys.
- How much preview traffic the relay should carry before it limits a
  session (a Phoenix app's first page is a few MB of assets).
- Whether a host may hand the session to a guest (who would then run
  the project, from a fork) instead of ending it.
