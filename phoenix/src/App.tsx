import { RiLoader4Line, RiRestartLine, RiSideBarLine } from '@remixicon/react';
import { useEffect, useRef } from 'react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { EditorArea } from './components/Editor';
import { FileTreePanel } from './components/FileTreePanel';
import { Preview } from './components/Preview';
import { Terminals } from './components/Terminals';
import { restartServer, start } from './playground';
import { closePopup } from './previewChannel';
import { useStore } from './store';

let started = false;

export function App() {
  const status = useStore((state) => state.status);
  const ready = useStore((state) => state.ready);
  const running = useStore((state) => state.serverRunning);
  const popped = useStore((state) => state.previewPopped);
  const workspace = useGroupRef();
  // The tree's width while the preview is docked: popping out redistributes
  // before the layout below runs.
  const treeSize = useRef(18);

  // The preview's width goes to the editor while it is popped out, and
  // comes back from it; the tree keeps its size.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const tree = treeSize.current;
      workspace.current?.setLayout(
        popped
          ? { tree, work: 100 - tree }
          : { tree, work: Math.max(30, 62 - tree), preview: Math.min(100 - tree - 30, 38) },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [popped, workspace]);

  useEffect(() => {
    if (started) return;
    started = true;
    start().catch((error: Error) => useStore.getState().setStatus(`failed: ${error.message}`));
  }, []);

  return (
    <div className="app">
      <header className="top-bar">
        <h1>
          Phoenix <span>Playground</span>
        </h1>
        <div className="status">
          {!ready && <RiLoader4Line size={14} className="spin" />}
          {status}
        </div>
        {popped && (
          <button
            type="button"
            className="button"
            onClick={closePopup}
            title="Bring the preview back into this window"
          >
            <RiSideBarLine size={16} />
            Dock preview
          </button>
        )}
        <button type="button" className="button" onClick={restartServer} disabled={!ready}>
          <RiRestartLine size={16} />
          {running ? 'Restart server' : 'Start server'}
        </button>
      </header>
      <Group
        orientation="horizontal"
        className="workspace"
        groupRef={workspace}
        onLayoutChanged={(layout) => {
          if (layout.preview !== undefined && layout.tree !== undefined)
            treeSize.current = layout.tree;
        }}
      >
        <Panel id="tree" defaultSize="18" minSize={160} className="panel">
          <FileTreePanel />
        </Panel>
        <Separator className="separator" />
        <Panel id="work" defaultSize="44" minSize={240} className="panel">
          <Group orientation="vertical">
            <Panel defaultSize="62" minSize={120} className="panel">
              <EditorArea />
            </Panel>
            <Separator className="separator horizontal" />
            <Panel defaultSize="38" minSize={100} className="panel">
              <Terminals />
            </Panel>
          </Group>
        </Panel>
        {!popped && (
          <>
            <Separator className="separator" />
            <Panel id="preview" defaultSize="38" minSize={240} className="panel">
              <Preview />
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}
