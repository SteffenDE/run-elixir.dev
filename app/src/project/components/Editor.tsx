import { Tabs } from '@base-ui/react/tabs';
import type { FileContents } from '@pierre/diffs';
import { Editor as PierreEditor, type EditorFactory } from '@pierre/diffs/edit';
import { EditProvider, File, Virtualizer } from '@pierre/diffs/react';
import { RiCloseLine, RiSave3Line } from '@remixicon/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspace } from '@/project/lib/workspace';
import '@/project/lib/languages';
import { WORK, useStore, type Tab } from '@/project/lib/store';
import { followed, resumeFollowing, showFollowed } from '@/live/lib/follow';
import { publishCursor } from '@/live/lib/presence';
import { FollowNotice } from '@/live/components/FollowNotice';
import {
  bind,
  caretsIn,
  onSharedFiles,
  renderCaret,
  sharedFile,
  type Binding,
  type CaretInfo,
  type FileEditor,
} from '@/live/lib/shared-files';
import { useLive } from '@/live/lib/store';
import { Shortcut } from '@/shared/components/Kbd';
import { isModifierKeyPressed, modifierKey } from '@/shared/lib/keys';

const createEditor: EditorFactory<undefined, CaretInfo> = (type, options, key) =>
  new PierreEditor(type, options, key);

// The caret on `line`, in view (the editor would show its caret wherever
// it was, the end for a new session). Focus stays in the file tree when
// the user is there (selecting, renaming). The file of someone followed
// shows their caret instead (live/lib/follow.ts): focus would move this
// page's caret, which the editor keeps in view on each of their edits.
function goTo(editor: FileEditor, path: string, line: number) {
  if (followed(path)) showFollowed(line);
  else if (!document.activeElement?.closest('.file-tree'))
    editor.focus({ lineNumber: line, offset: 80 });
  if (line === 1) {
    requestAnimationFrame(() =>
      document.querySelector('.tab-panel:not([hidden]) .editor-scroll')?.scrollTo(0, 0),
    );
  }
}

const fileOptions = {
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  disableFileHeader: true,
  // The editor's background is the IDE's panel, in both schemes.
  unsafeCSS: ':host { --diffs-bg: light-dark(#ffffff, #18171d); }',
} as const;

// In a live session, a file open in it is shared (src/live): edits go
// both ways, others' carets show, and this one's goes to them.
function useSharedFile(path: string, editor: FileEditor | null, holder: HTMLElement | null) {
  const binding = useRef<Binding | null>(null);
  const [files, setFiles] = useState(0);
  useEffect(() => onSharedFiles(() => setFiles((n) => n + 1)), []);
  // oxlint-disable-next-line react/exhaustive-deps -- `files` is the signal.
  useEffect(() => {
    const file = sharedFile(path);
    if (!editor || !holder || !file) return;
    const bound = bind(editor, file, holder, () => !useStore.getState().access.edit);
    binding.current = bound;
    const draw = () => editor.setCarets(caretsIn(file, editor));
    draw();
    const unwatch = useLive.subscribe((state, before) => {
      if (state.cursors !== before.cursors || state.people !== before.people) draw();
    });
    // The editor takes the selection's change first. Keys and clicks in it
    // say so too: a selection in a shadow root does not reach the document
    // in every browser.
    const onSelection = () => {
      if (holder.contains(document.activeElement))
        setTimeout(() => publishCursor(bound.cursor()), 0);
    };
    // Escape in the file of someone followed goes back to following, unless
    // it is the editor's (closing its search, leaving one of many carets).
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !followed(path)) return;
      if (event.composedPath()[0] instanceof HTMLInputElement) return;
      if ((editor.getViewState().selections?.length ?? 0) > 1) return;
      setTimeout(() => {
        editor.blur();
        resumeFollowing();
      }, 0);
    };
    // Focus in the file of someone followed detaches (FollowNotice);
    // leaving the editor follows again.
    const onFocusIn = () => {
      if (followed(path) && !useLive.getState().detached)
        useLive.getState().set({ detached: 'notice' });
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!holder.contains(event.relatedTarget as Node | null))
        useLive.getState().set({ detached: null });
    };
    document.addEventListener('selectionchange', onSelection);
    holder.addEventListener('focusin', onFocusIn);
    holder.addEventListener('focusout', onFocusOut);
    holder.addEventListener('keyup', onSelection);
    holder.addEventListener('mouseup', onSelection);
    holder.addEventListener('keydown', onEscape, true);
    return () => {
      bound.unbind();
      binding.current = null;
      unwatch();
      document.removeEventListener('selectionchange', onSelection);
      holder.removeEventListener('keyup', onSelection);
      holder.removeEventListener('mouseup', onSelection);
      holder.removeEventListener('keydown', onEscape, true);
      holder.removeEventListener('focusin', onFocusIn);
      holder.removeEventListener('focusout', onFocusOut);
      useLive.getState().set({ detached: null });
      editor.setCarets([]);
    };
  }, [path, editor, holder, files]);
  return binding;
}

function TabEditor({ tab }: { tab: Tab }) {
  const edit = useStore((state) => state.edit);
  const editor = useRef<FileEditor | null>(null);
  const [attached, setAttached] = useState<FileEditor | null>(null);
  const [holder, setHolder] = useState<HTMLDivElement | null>(null);
  const binding = useSharedFile(tab.path, attached, holder);
  const line = useRef(tab.line);
  useEffect(() => {
    line.current = tab.line;
  }, [tab.line]);
  const editorOptions = useMemo(
    () => ({
      onAttach: (next: FileEditor) => {
        editor.current = next;
        setAttached(next);
        goTo(next, tab.path, line.current);
      },
      renderCaret,
    }),
    [tab.path],
  );
  // Asked again for a line (a terminal's link) while open.
  useEffect(() => {
    if (tab.jump && editor.current) goTo(editor.current, tab.path, tab.line);
  }, [tab.jump, tab.path, tab.line]);
  // A new object only when the file is (re)loaded: the editor owns the text
  // in between.
  const file = useMemo<FileContents>(
    () => ({
      name: tab.path.slice(tab.path.lastIndexOf('/') + 1),
      contents: tab.contents,
      cacheKey: `${tab.path}@${tab.version}`,
    }),
    [tab.path, tab.contents, tab.version],
  );
  return (
    <>
      <div className="editor-holder" ref={setHolder}>
        <Virtualizer className="editor-scroll">
          <File
            file={file}
            options={fileOptions}
            edit
            editorOptions={editorOptions}
            editStateKey={`${tab.path}@${tab.version}`}
            onEditChange={(event) => {
              binding.current?.local(event.changes);
              edit(tab.path, event.file.contents);
            }}
            onEditComplete={() => 'accept'}
          />
        </Virtualizer>
      </div>
      <FollowNotice />
    </>
  );
}

// Open files in tabs; ⌘S / Ctrl+S saves the active one. `phoenix`: saving
// reloads a server's preview, which Phoenix recompiles for.
export function EditorArea({ phoenix }: { phoenix: boolean }) {
  const tabs = useStore((state) => state.tabs);
  const active = useStore((state) => state.active);
  const activate = useStore((state) => state.activate);
  const close = useStore((state) => state.close);
  const current = tabs.find((tab) => tab.path === active);
  const canEdit = useStore((state) => state.access.edit);

  const saveCurrent = useCallback(() => {
    if (current && current.draft !== current.saved)
      workspace()
        .save(current.path, current.draft)
        .catch((error: Error) => useStore.getState().setStatus(error.message));
  }, [current]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isModifierKeyPressed(event) && event.key === 's') {
        event.preventDefault();
        saveCurrent();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [saveCurrent]);

  if (!tabs.length) {
    return (
      <div className="editor-empty">
        <p>
          Open a file from the tree, or find one with <Shortcut keyName="P" />, to edit it.
        </p>
        <p className="muted">
          Save with <Shortcut keyName="S" />
          {phoenix ? '; the preview reloads, and Phoenix recompiles what changed.' : '.'}
        </p>
      </div>
    );
  }

  return (
    <Tabs.Root
      className="editor"
      value={active}
      onValueChange={(value) => activate(value as string)}
    >
      <div className="bar tab-bar">
        <Tabs.List className="tab-list">
          {tabs.map((tab) => {
            const name = tab.path.slice(tab.path.lastIndexOf('/') + 1);
            const dirty = tab.draft !== tab.saved;
            return (
              <Tabs.Tab
                key={tab.path}
                value={tab.path}
                className="tab"
                title={tab.path.slice(WORK.length + 1)}
              >
                <span className="tab-name">{name}</span>
                <span
                  className={dirty ? 'tab-close dirty' : 'tab-close'}
                  role="button"
                  aria-label={`Close ${name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    close(tab.path);
                  }}
                >
                  <RiCloseLine size={14} />
                </span>
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
        {canEdit && (
          <button
            type="button"
            className="icon-button"
            disabled={!current || current.draft === current.saved}
            onClick={saveCurrent}
            title={`Save (${modifierKey()} S)`}
          >
            <RiSave3Line size={16} />
          </button>
        )}
      </div>
      <EditProvider createEditor={createEditor}>
        {tabs.map((tab) => (
          <Tabs.Panel key={tab.path} value={tab.path} className="tab-panel" keepMounted={false}>
            <TabEditor tab={tab} />
          </Tabs.Panel>
        ))}
      </EditProvider>
    </Tabs.Root>
  );
}
