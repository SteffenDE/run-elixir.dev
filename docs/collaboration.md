---
kind: design
status: live
last_updated: 2026-10-16
---

# Sharing and live sessions (plan)

Not built yet, apart from the link share ([projects.md](projects.md#sharing)).
This is the plan: what *Share* offers, how a live session works, what the
server sees, and the order to build it in.

## What *Share* offers

*Share* in the top bar opens a dialog with two choices:

| | Link | Live session |
| --- | --- | --- |
| What the other side gets | A copy: a new project of their own, made from the project's changes (today's `/import#DATA`). | This project, as it runs in this tab: files, open editors, terminals, preview. |
| Server | None (the fragment never reaches it). Later, optionally, a stored share ([below](#later-stored-shares-and-accounts)). | The backend's `/socket` relays encrypted messages between the browsers. It cannot read them. |
| Lifetime | For ever. | While the host's tab runs the session. |
| Guests can | Everything (it is their project). | Watch; edit, type in terminals and fork only if the host allows it. |

A temporary IEx can be shared live (showing someone an IEx) but not as a
link, as today.

## A live session

### Who runs what

**The host's tab runs the project; guests run no nodes.** A guest's page
is a view of the host's: the file tree, editors, terminals and preview,
fed over the relay. Everything a guest does goes to the host, which
applies it through the same functions the IDE calls today
(`src/project/lib/playground.ts`: `read`, `save`, `createFile`,
`movePath`, `removePath`, `type`, `interrupt`, `resize`, the bridge).

- One truth: one `/work`, one database, one server. Two browsers each
  running the project would diverge (Mix's builds, PGlite, the server's
  state) with no way to reconcile.
- Guests start in a second: no runtime download, no boot. A phone can
  join.
- The guest page is the project IDE with a remote backend behind the
  `playground.ts` interface ([projects.md](projects.md#plans) left room
  for it). The IDE's components stay as they are.

The cost: the session ends with the host's tab, and every request of a
guest's preview crosses the relay twice.

### The link

```
https://DOMAIN/live/ID#k=KEY&h=HOSTKEY
```

- `ID`: 128 random bits, base64url. The Phoenix topic is `live:ID`.
- `KEY`: a random AES-256-GCM key, made by the host's browser.
- `HOSTKEY`: the host's Ed25519 public key (WebCrypto). Guests accept
  the session's state only when the host signed it ([why](#permissions)).

The fragment never reaches a server. Anyone with the link can read the
session, so it is the secret: the dialog says so, and the host sees who
is in.

A guest's page runs on an origin of its own, `l-ID.DOMAIN` (see
[projects.md](projects.md#a-project-domain)): the host's app runs in
the guest's preview, with its own cookies and storage, and must not
share an origin with the guest's projects or the apex. `DOMAIN/live/ID`
goes there, carrying the fragment along (the page navigates itself,
adding the fragment, so a redirect cannot drop it).

### The relay

A Phoenix channel in `playground/backend` on `/socket`, which
[backend.md](backend.md) keeps for it. It knows nothing about projects:

- `join "live:ID"` with `{role: "host" | "guest"}`. The first join
  creates the topic and must be a host; it gets a host token for
  moderation. The topic ends when the host leaves (after a grace period
  for a reload, below).
- Every participant gets a server-assigned id. The server stamps
  `from` on what it relays, so a guest cannot pretend to be another
  participant to the server's moderation (signatures still decide what
  guests trust).
- `broadcast` (to all others) and `send` (to one participant, by id, for
  a snapshot or a reply). The payload is opaque bytes.
- `kick` (host token only): disconnects a participant and refuses its
  rejoin.
- Limits: participants per session (16), message size (256 KiB; larger
  payloads are chunked by the client), message rate per participant,
  total bytes per session per minute, idle timeout. Sockets only from
  the site's origins.
- Nothing is stored. Presence is ids and roles only; names travel
  encrypted.

What the server does see: IP addresses, when and how much each
participant sends, how many are in a session, and how long it lasts.

### Encryption

Every message: `{seq, nonce, ciphertext}` with AES-256-GCM, a random
96-bit nonce, and the session ID, the sender's id and `seq` as additional
data, so the relay cannot move a message to another session or replay
it as another sender's. The host's messages that carry state (file
contents, Yjs updates, permissions, the participant list) are signed with
its Ed25519 key inside the ciphertext.

All of it is WebCrypto; nothing new to bundle.

### Permissions

The host decides, at any time, from a panel listing who is in:

| Permission | Default | Lets a guest |
| --- | --- | --- |
| Watch | always | See the tree, open files, follow cursors, see terminal output and the preview. |
| Edit | off | Edit files, create, rename and delete them, save. |
| Terminal | off | Type into terminals, open and close them, restart the server. This is full control of the project (and its network), so it is its own switch, worded as such. |
| Fork | off | Make a project of their own from the session's current state. |
| Admit | off | (A switch for the host: ask before each new guest gets in, instead of anyone with the link.) |

Per guest or for all; the host can also kick.

Everyone with the link holds the key, so the server cannot enforce this
and neither can the key: a watching guest could encrypt an edit and
broadcast it. So guests apply **only what the host signed**. An editing
guest sends its edits to the host (`send`), the host checks the
permission, applies them and broadcasts them signed. Edits cross the
relay twice; for typing that is still well under what a person notices.
Cursors and selections are cosmetic and go straight to everyone.

A kicked guest keeps the key and could still read what it gets hold of;
the server no longer sends it anything. Rotating the key for those who
stay (each guest sends an X25519 public key on joining; the host sends
the new key to each) comes later. Until then the answer to a leaked link
is ending the session and starting a new one.

### Joining

1. The guest's page joins the topic, sends `hello` (a display name, kept
   in local storage, and the site's version and protocol version), and
   waits. With *Admit* on, the host is asked.
2. The host answers with a signed `welcome`: the participant list and
   colors, permissions, the project's kind and name, the tree (paths and
   types; not contents), the open terminals with their current screens
   (`initialLines`), the preview's address.
3. File contents come when the guest opens a file: the host sends the
   file's shared document (below), or its bytes for a binary file.

Guests on another site version than the host's are told and may go on if
the protocol version matches; the page has nothing else in common with
the host's (no template, no runtime).

### Files and editing

Text that more than one person may type into is a **Yjs** document
(`Y.Text`), one per open file, kept by the host for as long as someone
has the file open. Yjs merges concurrent edits without a server, and its
updates are opaque bytes that encrypt like anything else. The host's own
editor is a participant like the guests.

The editor (@pierre/diffs 1.5.2, `src/project/components/Editor.tsx`)
has what this needs, with two things to work around:

- **Other people's cursors:** `editor.setCarets([{anchor, focus,
  metadata: {color, …}}])` with `renderCaret` (a caret and the person's
  name). It draws them apart from the local selection, never touching
  focus, and moves them along with edits between updates.
- **Local edits out:** `onChange` gives each change as `{start, end,
  text}` offsets, a `Y.Text` delete and insert.
- **Remote edits in:** `editor.applyEdits(edits)` on the attached editor
  (from `onAttach`), which keeps the local selection where it belongs.
  Not through the `file` prop: a new `cacheKey` replaces the session.
- **Echo:** `applyEdits` fires `onChange` too. A flag set while
  applying a remote edit keeps it from going back out.
- **Undo:** every `applyEdits` joins the editor's undo stack, so ⌘Z
  would undo someone else's typing. The keymap can only rebind built-in
  commands, so ⌘Z and ⌘⇧Z are caught before the editor (as ⌘S is) and
  go to a `Y.UndoManager` that tracks only this browser's edits. The
  editor's own history is cleared after each remote edit.

**Saving** stays explicit: a shared document is the draft everyone sees;
*Save* (by anyone who may edit) asks the host to write it to `/work`, and
the dirty mark is shared. What the host's nodes see is the saved file,
as today; Phoenix's reload follows a save, not a keystroke.

**Changes on disk** (a generator, `mix format`, `git checkout`) reach the
tree of everyone. For a file with a shared document and no unsaved
changes, the host turns the new contents into a diff on the `Y.Text`, so
carets and undo survive; with unsaved changes, the editor offers the
disk's version, as it does without a session.

Tree operations (create, rename, delete, upload) are requests to the
host, which applies them and broadcasts the new tree.

### Terminals

The host streams each terminal's output (`onOutput`) to everyone; a
joining guest gets the screen so far. A guest's terminal shows the
host's columns and rows (a guest's resize does not reach the node).
With *Terminal*, keystrokes and Ctrl+C go to the host's `type` and
`interrupt`, and a guest may open terminals.

### The preview

A guest's preview runs the host's app as itself: its own cookies, its
own LiveView. The guest's service worker sends the preview's requests to
the guest's page (as it does to a project's page today); the page sends
them over the relay to the host, whose bridge (`bridge.ts`) answers them
as it answers its own preview, WebSockets included (the injected
`WebSocket` already goes through a `MessagePort`). Each guest is then
another user of the app, which is the point of showing a Phoenix app to
someone.

Requests are chunked and streamed with ids, so a large asset does not
stall the editors' messages. Static assets the host has served once may be
cached in the guest's service worker for the session.

The host's app code runs in the guest's browser, as it would from an
imported link; the guest's origin of its own keeps it from anything else.

### Presence

Names (chosen on joining), colors (assigned by the host), who has which
file open and where the cursor is, shown on tabs and the tree. *Follow*
a participant: open what they open, scroll where they scroll.

### When the host goes away

- **Reload:** the host keeps the session's ID and keys in
  `sessionStorage` and rejoins; the relay holds the topic for a grace
  period (30 s) and guests show "reconnecting". The shared documents are
  rebuilt from `/work`; unsaved text is lost unless a guest still has
  it, so a rejoining host first takes back the documents guests hold.
- **Close, or *End session*:** guests are told, and keep a read-only
  view of what they had open until they leave. A fork needs the host
  (a guest has only the files it opened), so it is not offered then.
- **Open it here** in another tab of the host's (one tab per project,
  [projects.md](projects.md#one-tab-per-project)) ends the session first.

### Forking

A guest with *Fork* asks the host for the project as `shareable()` makes
it for a link, including the shared documents' unsaved text, over
`send` in chunks (no URL limit). The guest's apex then makes a project
from it as `/import` does, with the same template check.

## Order of work

1. **Share dialog.** Link or live; the link as today.
2. **Relay.** The channel, ids, `broadcast`/`send`/`kick`, limits; ExUnit
   tests. Deployed on `/socket` with the backend.
3. **Watching.** The guest page on `l-ID.DOMAIN`; encryption and
   signatures; `hello`/`welcome`; the remote `playground.ts` (tree,
   reading files); terminal output; the participant panel. Playwright with
   two browser contexts and the backend running locally.
4. **Editing.** Yjs documents; remote carets; ⌘Z through `Y.UndoManager`;
   shared saving; changes on disk; the *Edit* permission.
5. **Preview** over the relay; *Terminal* input.
6. **Fork**, *Admit*, follow mode, the host's reload.
7. **Key rotation** after a kick.

## Later: stored shares and accounts

A link holds what a URL can. A stored share puts the same payload,
encrypted in the browser, on the backend: `/s/ID#KEY`, the key again in
the fragment, so the server keeps bytes it cannot read, with a size limit
and an expiry. That needs no accounts.

Accounts come after: a signed-in user's projects kept on the server with
a lasting id or slug, opened from any browser, and a stored share that
can be updated in place. Whether those are encrypted too (with a key the
account holds) is open.

## Open questions

- Edits through the host cost a round trip and the host's tab; whether
  editors should also apply each other's updates directly once they hold
  per-guest keys.
- How much preview traffic the relay should carry before it limits a
  session (a Phoenix app's first page is a few MB of assets).
- Whether a host may hand the session to a guest (who would then run
  the project, from a fork) instead of ending it.
