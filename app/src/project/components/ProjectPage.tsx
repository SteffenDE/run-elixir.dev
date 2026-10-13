import { RiLoader4Line, RiRestartLine, RiSideBarLine } from '@remixicon/react';
import { useEffect, useRef } from 'react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { EditorArea } from '@/project/components/Editor';
import { FileTreePanel } from '@/project/components/FileTreePanel';
import { OpenElsewhere } from '@/project/components/OpenElsewhere';
import { Preview } from '@/project/components/Preview';
import { ProjectTitle } from '@/project/components/ProjectTitle';
import { Terminals } from '@/project/components/Terminals';
import { setup } from '@/project/lib/kinds';
import { restartServer, start } from '@/project/lib/playground';
import { closePopup } from '@/project/lib/previewChannel';
import { useStore } from '@/project/lib/store';
import type { Project } from '@/shared/lib/projects';

let started = false;

// A project in the IDE: tree, editor over terminals, and the preview while
// there is something to show. `project` is null for a temporary IEx.
export function ProjectPage({ project }: { project: Project | null }) {
  const kind = project?.kind ?? 'iex';
  const status = useStore((state) => state.status);
  const ready = useStore((state) => state.ready);
  const previewPort = useStore((state) => state.previewPort);
  const popped = useStore((state) => state.previewPopped);
  const elsewhere = useStore((state) => state.elsewhere);
  const docked = !popped && (setup(kind).alwaysPreview || previewPort !== null);
  const workspace = useGroupRef();
  // The tree's width while the preview is docked: undocking redistributes
  // before the layout below runs.
  const treeSize = useRef(18);

  // The preview's width goes to the editor while it is not docked, and
  // comes back from it; the tree keeps its size.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const tree = treeSize.current;
      workspace.current?.setLayout(
        docked
          ? { tree, work: Math.max(30, 62 - tree), preview: Math.min(100 - tree - 30, 38) }
          : { tree, work: 100 - tree },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [docked, workspace]);

  useEffect(() => {
    if (started) return;
    started = true;
    start(kind, project?.id ?? null).catch((error: Error) =>
      useStore.getState().setStatus(`failed: ${error.message}`),
    );
  }, [kind, project]);

  if (elsewhere && project) return <OpenElsewhere project={project} moved />;

  return (
    <div className="app">
      <header className="top-bar">
        <a className="brand" href="/">
          Elixir <span>Playground</span>
        </a>
        <ProjectTitle project={project} />
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
        {kind === 'phoenix' && (
          <button type="button" className="button" onClick={restartServer} disabled={!ready}>
            <RiRestartLine size={16} />
            {previewPort !== null ? 'Restart server' : 'Start server'}
          </button>
        )}
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
              <Terminals firstTab={setup(kind).firstTab} />
            </Panel>
          </Group>
        </Panel>
        {docked && (
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
