import { RiLoader4Line, RiRestartLine } from '@remixicon/react';
import { useEffect } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { EditorArea } from './components/Editor';
import { FileTreePanel } from './components/FileTreePanel';
import { Preview } from './components/Preview';
import { TerminalPanel } from './components/TerminalPanel';
import { restartServer, start } from './playground';
import { useStore } from './store';

let started = false;

export function App() {
  const status = useStore((state) => state.status);
  const ready = useStore((state) => state.ready);
  const running = useStore((state) => state.serverRunning);

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
        <button type="button" className="button" onClick={restartServer} disabled={!ready}>
          <RiRestartLine size={16} />
          {running ? 'Restart server' : 'Start server'}
        </button>
      </header>
      <Group orientation="horizontal" className="workspace">
        <Panel defaultSize="18" minSize={160} className="panel">
          <FileTreePanel />
        </Panel>
        <Separator className="separator" />
        <Panel defaultSize="44" minSize={240} className="panel">
          <Group orientation="vertical">
            <Panel defaultSize="62" minSize={120} className="panel">
              <EditorArea />
            </Panel>
            <Separator className="separator horizontal" />
            <Panel defaultSize="38" minSize={100} className="panel">
              <TerminalPanel />
            </Panel>
          </Group>
        </Panel>
        <Separator className="separator" />
        <Panel defaultSize="38" minSize={240} className="panel">
          <Preview />
        </Panel>
      </Group>
    </div>
  );
}
