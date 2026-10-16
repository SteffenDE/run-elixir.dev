import { RiHome5Line, RiLoader4Line, RiRestartLine, RiSideBarLine } from '@remixicon/react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  Group,
  Panel,
  Separator,
  useGroupRef,
  usePanelRef,
  type PanelImperativeHandle,
} from 'react-resizable-panels';
import { GuestBar } from '@/live/components/GuestBar';
import { resumeSession } from '@/live/lib/host';
import type { GuestProject } from '@/live/lib/guest';
import { EditorArea } from '@/project/components/Editor';
import { KindChip } from '@/shared/components/KindChip';
import { SidePanel } from '@/project/components/SidePanel';
import { OpenElsewhere } from '@/project/components/OpenElsewhere';
import { Preview } from '@/project/components/Preview';
import { QuickOpen } from '@/project/components/QuickOpen';
import { ProjectTitle } from '@/project/components/ProjectTitle';
import { ShareButton } from '@/project/components/ShareButton';
import { NifBuildDialog } from '@/project/components/NifBuildDialog';
import { StartError } from '@/project/components/StartError';
import { TemplateNotice } from '@/project/components/TemplateNotice';
import { Terminals } from '@/project/components/Terminals';
import { setup } from '@/project/lib/kinds';
import { start } from '@/project/lib/playground';
import { workspace as current } from '@/project/lib/workspace';
import { closePopup } from '@/project/lib/previewChannel';
import { useStore } from '@/project/lib/store';
import { NarrowWorkspace } from '@/project/components/NarrowWorkspace';
import { useNarrow } from '@/shared/lib/narrow';
import type { Project } from '@/shared/lib/projects';
import { apexUrl } from '@/shared/lib/site';

let started = false;

// Panels and their usual sizes (percent).
type FilePanels = [PanelImperativeHandle | null, number][];

// The tree and the editor, shown (at no less than half their usual sizes)
// or collapsed, giving their room to the terminals and the preview.
function showPanels(panels: FilePanels, show: boolean) {
  for (const [panel, usual] of panels) {
    if (!panel) continue;
    if (!show) panel.collapse();
    else if (panel.isCollapsed()) {
      panel.expand();
      if (panel.getSize().asPercentage < usual / 2) panel.resize(`${usual}%`);
    }
  }
}

// A project in the IDE: tree, editor over terminals, and the preview while
// there is something to show. `project` is null for a temporary IEx, and
// for a live session's guest, which shows `guest`, the host's project.
export function ProjectPage({ project, guest }: { project: Project | null; guest?: GuestProject }) {
  const kind = guest?.kind ?? project?.kind ?? 'iex';
  const canRestart = useStore((state) => state.access.terminal);
  const status = useStore((state) => state.status);
  const ready = useStore((state) => state.ready);
  const startError = useStore((state) => state.startError);
  const previewPort = useStore((state) => state.previewPort);
  const popped = useStore((state) => state.previewPopped);
  const elsewhere = useStore((state) => state.elsewhere);
  const docked = !popped && (setup(kind).alwaysPreview || previewPort !== null);
  const workspace = useGroupRef();
  // The tree's width while the preview is docked: undocking redistributes
  // before the layout below runs.
  const showFiles = setup(kind).showFiles;
  const treeSize = useRef(showFiles ? 18 : 0);
  const treePanel = usePanelRef();
  const editorPanel = usePanelRef();
  const filesShown = useStore((state) => state.filesShown);
  const setFilesShown = useStore((state) => state.setFilesShown);
  const files = (): FilePanels => [
    [treePanel.current, 18],
    [editorPanel.current, 62],
  ];

  const narrow = useNarrow();
  // The kind's default, before the first paint; then as asked (a terminal's
  // link to a file shows them). On a phone: Phoenix's preview first, else
  // the terminal.
  useLayoutEffect(() => {
    setFilesShown(showFiles);
    useStore.getState().setPane(kind === 'phoenix' ? 'preview' : 'terminal');
  }, [showFiles, setFilesShown, kind]);
  useEffect(() => {
    showPanels(
      [
        [treePanel.current, 18],
        [editorPanel.current, 62],
      ],
      filesShown,
    );
  }, [filesShown, treePanel, editorPanel]);
  // The toggle goes by what shows, which dragging may have changed.
  const toggleFiles = () => {
    const shown = files().some(([panel]) => panel && !panel.isCollapsed());
    if (shown === filesShown) setFilesShown(!shown);
    else showPanels(files(), !shown);
  };

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
    if (started || guest) return;
    started = true;
    start(kind, project?.id ?? null).then(
      () =>
        project &&
        resumeSession({
          id: project.id,
          kind,
          name: project.name,
          template: project.template,
        }),
      (error: Error) => useStore.getState().failedToStart(error.message),
    );
  }, [kind, project, guest]);

  if (elsewhere && project) return <OpenElsewhere project={project} moved />;

  return (
    <div className="app">
      <header className="top-bar">
        <a className="brand" href={apexUrl('/')} title="All projects">
          <RiHome5Line size={18} className="brand-icon" />
          <span className="brand-name">
            Elixir <span>Playground</span>
          </span>
        </a>
        {guest ? (
          <div className="project-title">
            <span className="project-name">{guest.name}</span>
            <KindChip kind={guest.kind} />
          </div>
        ) : (
          <ProjectTitle project={project} />
        )}
        <div className="status">
          {!ready && !startError && <RiLoader4Line size={14} className="spin" />}
          <span className="status-text">{status}</span>
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
        {guest ? (
          <GuestBar />
        ) : (
          <ShareButton
            project={{
              id: project?.id ?? null,
              kind,
              name: project?.name ?? 'iex',
              template: project?.template,
            }}
          />
        )}
        {kind === 'phoenix' && canRestart && (
          <button
            type="button"
            className="button"
            onClick={() => current().restartServer()}
            disabled={!ready}
            title={previewPort !== null ? 'Restart server' : 'Start server'}
          >
            <RiRestartLine size={16} />
            <span className="button-label">
              {previewPort !== null ? 'Restart server' : 'Start server'}
            </span>
          </button>
        )}
      </header>
      <TemplateNotice project={project} />
      <StartError />
      <NifBuildDialog />
      <QuickOpen />
      {narrow ? (
        <NarrowWorkspace
          phoenix={kind === 'phoenix'}
          firstTab={setup(kind).firstTab}
          preview={setup(kind).alwaysPreview || previewPort !== null}
        />
      ) : (
        <Group
          orientation="horizontal"
          className="workspace"
          groupRef={workspace}
          onLayoutChanged={(layout) => {
            if (layout.preview !== undefined && layout.tree !== undefined)
              treeSize.current = layout.tree;
          }}
        >
          <Panel
            id="tree"
            panelRef={treePanel}
            defaultSize={showFiles ? '18' : '0'}
            minSize={160}
            collapsible
            className="panel"
          >
            <SidePanel />
          </Panel>
          <Separator className="separator" />
          <Panel id="work" defaultSize="44" minSize={240} className="panel">
            <Group orientation="vertical">
              <Panel
                panelRef={editorPanel}
                defaultSize={showFiles ? '62' : '0'}
                minSize={120}
                collapsible
                className="panel"
              >
                <EditorArea phoenix={kind === 'phoenix'} />
              </Panel>
              <Separator className="separator horizontal" />
              <Panel defaultSize={showFiles ? '38' : '100'} minSize={100} className="panel">
                <Terminals
                  firstTab={setup(kind).firstTab}
                  maximized={!filesShown}
                  onMaximize={toggleFiles}
                />
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
      )}
    </div>
  );
}
