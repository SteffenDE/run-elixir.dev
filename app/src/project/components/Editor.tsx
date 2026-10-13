import { Tabs } from '@base-ui/react/tabs';
import type { FileContents } from '@pierre/diffs';
import { Editor as PierreEditor, type EditorFactory } from '@pierre/diffs/edit';
import { EditProvider, File, Virtualizer } from '@pierre/diffs/react';
import { RiCloseLine, RiSave3Line } from '@remixicon/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { save } from '@/project/lib/playground';
import '@/project/lib/languages';
import { WORK, useStore, type Tab } from '@/project/lib/store';
import { Shortcut } from '@/shared/components/Kbd';
import { isModifierKeyPressed, modifierKey } from '@/shared/lib/keys';

const createEditor: EditorFactory<undefined, undefined> = (type, options, key) =>
  new PierreEditor(type, options, key);

type FileEditor = PierreEditor<'file', undefined, undefined>;

// The caret on `line`, in view (the editor would show its caret wherever
// it was, the end for a new session). Focus stays in the file tree when
// the user is there (selecting, renaming).
function goTo(editor: FileEditor, line: number) {
  if (!document.activeElement?.closest('.file-tree'))
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

function TabEditor({ tab }: { tab: Tab }) {
  const edit = useStore((state) => state.edit);
  const editor = useRef<FileEditor | null>(null);
  const line = useRef(tab.line);
  useEffect(() => {
    line.current = tab.line;
  }, [tab.line]);
  const editorOptions = useMemo(
    () => ({
      onAttach: (attached: FileEditor) => {
        editor.current = attached;
        goTo(attached, line.current);
      },
    }),
    [],
  );
  // Asked again for a line (a terminal's link) while open.
  useEffect(() => {
    if (tab.jump && editor.current) goTo(editor.current, tab.line);
  }, [tab.jump, tab.line]);
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
    <Virtualizer className="editor-scroll">
      <File
        file={file}
        options={fileOptions}
        edit
        editorOptions={editorOptions}
        editStateKey={`${tab.path}@${tab.version}`}
        onEditChange={(event) => edit(tab.path, event.file.contents)}
        onEditComplete={() => 'accept'}
      />
    </Virtualizer>
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

  const saveCurrent = useCallback(() => {
    if (current && current.draft !== current.saved) void save(current.path, current.draft);
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
        <p>Open a file from the tree to edit it.</p>
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
        <button
          type="button"
          className="icon-button"
          disabled={!current || current.draft === current.saved}
          onClick={saveCurrent}
          title={`Save (${modifierKey()} S)`}
        >
          <RiSave3Line size={16} />
        </button>
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
