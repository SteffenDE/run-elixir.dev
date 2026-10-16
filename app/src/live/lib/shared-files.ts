// Files open in a live session: a Yjs document each (docs/collaboration.md
// #files-and-editing), kept by the host and copied by the guests that open
// them, and how an editor follows one.
//
// An editor bound to a file sends its edits into the document (with its
// binding as their origin) and applies everyone else's with applyEdits,
// flagged so they do not come back out. Undo is the binding's
// Y.UndoManager, which undoes this editor's edits only: ⌘Z and ⌘⇧Z (and
// the browser's undo) are taken before the editor sees them.
import type { Editor, EditorCaret, EditorChange, TextEdit } from '@pierre/diffs/edit';
import * as Y from 'yjs';
import { fromBase64Url, toBase64Url } from './crypto';
import { useLive, type Cursor } from './store';

// What the editor draws for another person's caret: their name (and
// their id, so a page following them finds it).
export interface CaretInfo {
  id: string;
  name: string;
}

export type FileEditor = Editor<'file', undefined, CaretInfo>;

export interface SharedFile {
  path: string;
  doc: Y.Doc;
  text: Y.Text;
  // What is saved in /work (the dirty mark is the text against it).
  saved: string;
}

// Updates that came from elsewhere (the relay, the disk): not this page's
// editor's.
export const REMOTE = 'remote';

const files = new Map<string, SharedFile>();
const listeners = new Set<() => void>();

export function sharedFile(path: string): SharedFile | undefined {
  return files.get(path);
}

export function sharedPaths(): string[] {
  return [...files.keys()];
}

// Told when files are added, moved or dropped (an editor binds anew).
export function onSharedFiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const changed = () => {
  for (const listener of listeners) listener();
};

export function addSharedFile(path: string, doc: Y.Doc, saved: string): SharedFile {
  const file = { path, doc, text: doc.getText('text'), saved };
  files.set(path, file);
  changed();
  return file;
}

export function dropSharedFile(path: string): void {
  files.get(path)?.doc.destroy();
  if (files.delete(path)) changed();
}

export function dropAllSharedFiles(): void {
  for (const file of files.values()) file.doc.destroy();
  files.clear();
  changed();
}

// A file or a directory moved: the files below it follow.
export function moveSharedFiles(from: string, to: string): void {
  let moved = false;
  for (const [path, file] of [...files]) {
    if (path !== from && !path.startsWith(`${from}/`)) continue;
    files.delete(path);
    file.path = to + path.slice(from.length);
    files.set(file.path, file);
    moved = true;
  }
  if (moved) changed();
}

export function removeSharedFiles(path: string): void {
  for (const key of [...files.keys()])
    if (key === path || key.startsWith(`${path}/`)) dropSharedFile(key);
}

// Turns `text` into `next` by one replacement (what lies between their
// common start and end), so carets elsewhere stay where they were.
export function replaceText(text: Y.Text, next: string, origin: unknown): void {
  const current = text.toString();
  if (current === next) return;
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let end = 0;
  while (
    end < current.length - start &&
    end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  text.doc!.transact(() => {
    if (current.length - start - end > 0) text.delete(start, current.length - start - end);
    if (next.length - start - end > 0) text.insert(start, next.slice(start, next.length - end));
  }, origin);
}

// Positions that survive edits, as the relay carries them.
export function relative(text: Y.Text, offset: number): string {
  return toBase64Url(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset)));
}

export function absolute(file: SharedFile, position: string): number | null {
  try {
    const decoded = Y.decodeRelativePosition(fromBase64Url(position));
    return Y.createAbsolutePositionFromRelativePosition(decoded, file.doc)?.index ?? null;
  } catch {
    return null;
  }
}

export interface Binding {
  // The editor's own edits (its onChange).
  local(changes: EditorChange[]): void;
  // Where this editor's caret is, as a Cursor (null: no selection).
  cursor(): Cursor | null;
  unbind(): void;
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

// Binds `editor` to `file`: the editor shows the document's text, and
// edits go both ways. `element` holds the editor (for its keys);
// `readOnly`: this page may not edit (keys and input that would change
// the text are dropped).
export function bind(
  editor: FileEditor,
  file: SharedFile,
  element: HTMLElement,
  readOnly: () => boolean,
): Binding {
  const origin = { binding: file.path };
  const undo = new Y.UndoManager(file.text, {
    trackedOrigins: new Set([origin]),
    captureTimeout: 500,
  });
  let applying = false;
  const document = () => editor.getEditState()?.document;

  // Applies a change made elsewhere (positions are in the text before it).
  const apply = (edits: TextEdit[]) => {
    if (!edits.length) return;
    applying = true;
    try {
      editor.applyEdits(edits, false);
    } finally {
      applying = false;
    }
    // Its history is not the undo here (the editor would undo others' edits).
    document()?.clearHistory();
  };

  // The editor starts from the document's text.
  const current = editor.getText();
  const wanted = file.text.toString();
  if (current !== wanted) {
    const end = document()?.positionAt(current.length) ?? { line: 0, character: 0 };
    apply([{ range: { start: { line: 0, character: 0 }, end }, newText: wanted }]);
  }

  const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin === origin) return;
    const doc = document();
    if (!doc) return;
    const edits: TextEdit[] = [];
    let at = 0;
    for (const delta of event.delta) {
      if (delta.retain) at += delta.retain;
      else if (delta.delete) {
        const start = doc.positionAt(at);
        edits.push({ range: { start, end: doc.positionAt(at + delta.delete) }, newText: '' });
        at += delta.delete;
      } else if (typeof delta.insert === 'string') {
        const position = doc.positionAt(at);
        edits.push({ range: { start: position, end: position }, newText: delta.insert });
      }
    }
    apply(edits);
  };
  file.text.observe(observer);

  // Keys: undo and redo go to the UndoManager; a read-only editor keeps
  // only what moves, selects, copies and finds.
  const onKey = (event: KeyboardEvent) => {
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    const isUndo = mod && key === 'z' && !event.shiftKey;
    const isRedo = mod && ((key === 'z' && event.shiftKey) || (key === 'y' && !isMac()));
    if (isUndo || isRedo) {
      event.preventDefault();
      event.stopPropagation();
      if (readOnly()) return;
      if (isUndo) undo.undo();
      else undo.redo();
      return;
    }
    if (!readOnly()) return;
    const moves = /^(Arrow(Left|Right)|Home|End|Page(Up|Down)|Escape|F\d+)$/.test(event.key);
    const vertical = /^Arrow(Up|Down)$/.test(event.key) && !event.altKey;
    const harmless = mod && ['a', 'c', 'f', 'g'].includes(key);
    if (moves || vertical || harmless || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key))
      return;
    if (event.key.length === 1 && !mod && !event.altKey) return; // beforeinput drops it
    event.preventDefault();
    event.stopPropagation();
  };
  const onInput = (event: InputEvent) => {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault();
      event.stopPropagation();
      if (readOnly()) return;
      if (event.inputType === 'historyUndo') undo.undo();
      else undo.redo();
    } else if (readOnly()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onClipboard = (event: Event) => {
    if (!readOnly()) return;
    event.preventDefault();
    event.stopPropagation();
  };
  element.addEventListener('keydown', onKey, true);
  element.addEventListener('beforeinput', onInput, true);
  for (const type of ['paste', 'cut', 'drop']) element.addEventListener(type, onClipboard, true);

  return {
    local(changes) {
      if (applying || !changes.length) return;
      const sorted = [...changes].sort((a, b) => b.start - a.start);
      file.doc.transact(() => {
        for (const change of sorted) {
          if (change.end > change.start) file.text.delete(change.start, change.end - change.start);
          if (change.text) file.text.insert(change.start, change.text);
        }
      }, origin);
    },
    cursor() {
      const selection = editor.getViewState().selections?.at(-1);
      const doc = document();
      if (!selection || !doc) return null;
      let anchor = doc.offsetAt(selection.start);
      let focus = doc.offsetAt(selection.end);
      if (selection.direction === -1) [anchor, focus] = [focus, anchor];
      return {
        path: file.path,
        anchor: relative(file.text, anchor),
        focus: relative(file.text, focus),
        line: doc.positionAt(focus).line + 1,
      };
    },
    unbind() {
      file.text.unobserve(observer);
      undo.destroy();
      element.removeEventListener('keydown', onKey, true);
      element.removeEventListener('beforeinput', onInput, true);
      for (const type of ['paste', 'cut', 'drop'])
        element.removeEventListener(type, onClipboard, true);
    },
  };
}

// Another person's caret: a bar in their color with their name above.
export function renderCaret(caret: EditorCaret<CaretInfo>): HTMLElement {
  const { color, name, id } = caret.metadata;
  const bar = document.createElement('div');
  bar.dataset.person = id;
  bar.style.cssText = `position:absolute;left:-1px;top:0;width:2px;height:1lh;background:${color};`;
  const label = document.createElement('div');
  label.textContent = name;
  label.style.cssText =
    `position:absolute;left:-1px;bottom:100%;padding:0 4px;border-radius:3px 3px 3px 0;` +
    `background:${color};color:#fff;font:600 10px/16px system-ui,sans-serif;white-space:nowrap;`;
  bar.append(label);
  return bar;
}

// The others' cursors in `file`, as the editor draws them.
export function caretsIn(file: SharedFile, editor: FileEditor): EditorCaret<CaretInfo>[] {
  const { cursors, people, me } = useLive.getState();
  const doc = editor.getEditState()?.document;
  if (!doc) return [];
  const carets: EditorCaret<CaretInfo>[] = [];
  for (const [id, cursor] of Object.entries(cursors)) {
    if (id === me || cursor.path !== file.path) continue;
    const person = people.find((p) => p.id === id);
    const anchor = absolute(file, cursor.anchor);
    const focus = absolute(file, cursor.focus);
    if (!person || anchor === null || focus === null) continue;
    carets.push({
      anchor: doc.positionAt(anchor),
      focus: doc.positionAt(focus),
      metadata: { color: person.color, name: person.name, id },
    });
  }
  return carets;
}
