import { RiCodeSSlashLine, RiFolder3Line, RiGlobalLine, RiTerminalBoxLine } from '@remixicon/react';
import { EditorArea } from '@/project/components/Editor';
import { FileTreePanel } from '@/project/components/FileTreePanel';
import { Preview } from '@/project/components/Preview';
import { Terminals } from '@/project/components/Terminals';
import { useStore, type Pane } from '@/project/lib/store';

// A phone's workspace: one pane at a time, chosen in a bar at the bottom.
// Every pane stays mounted (hidden), so terminals, tabs and the preview
// keep their state; opening a file shows the editor, following an address
// the preview.
export function NarrowWorkspace({
  phoenix,
  firstTab,
  preview,
}: {
  phoenix: boolean;
  firstTab: string;
  preview: boolean;
}) {
  const pane = useStore((state) => state.pane);
  const setPane = useStore((state) => state.setPane);
  const shown: Pane = pane === 'preview' && !preview ? 'terminal' : pane;
  const panes: [Pane, string, typeof RiFolder3Line][] = [
    ['files', 'Files', RiFolder3Line],
    ['editor', 'Editor', RiCodeSSlashLine],
    ['terminal', 'Terminal', RiTerminalBoxLine],
    ...(preview
      ? [['preview', 'Preview', RiGlobalLine] as [Pane, string, typeof RiGlobalLine]]
      : []),
  ];
  return (
    <div className="narrow-workspace">
      <div className="narrow-pane" hidden={shown !== 'files'}>
        <FileTreePanel />
      </div>
      <div className="narrow-pane" hidden={shown !== 'editor'}>
        <EditorArea phoenix={phoenix} />
      </div>
      <div className="narrow-pane" hidden={shown !== 'terminal'}>
        <Terminals firstTab={firstTab} />
      </div>
      {preview && (
        <div className="narrow-pane" hidden={shown !== 'preview'}>
          <Preview />
        </div>
      )}
      <nav className="pane-bar" aria-label="Panes">
        {panes.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            className="pane-button"
            aria-pressed={shown === id}
            onClick={() => setPane(id)}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
