import { Tabs } from '@base-ui/react/tabs';
import {
  RiAddLine,
  RiCloseLine,
  RiFullscreenExitLine,
  RiFullscreenLine,
  RiServerLine,
  RiTerminalBoxLine,
} from '@remixicon/react';
import { FIRST_SESSION } from '@/project/lib/playground';
import { workspace } from '@/project/lib/workspace';
import { useStore } from '@/project/lib/store';
import { disposeTerminal } from '@/project/lib/terminal-handle';
import { Pending } from '@/shared/components/Pending';
import { TerminalPanel } from './TerminalPanel';

// The shells, in tabs: the first runs what the project starts with (the
// Phoenix server, IEx); more run mix and friends beside it (each a node of
// its own over the same files). `firstTab`: the first one's name;
// `maximized`: the terminals have the files' and the editor's room, which
// `onMaximize` gives or gives back (no button without it).
export function Terminals({
  firstTab,
  maximized,
  onMaximize,
}: {
  firstTab: string;
  maximized?: boolean;
  onMaximize?: () => void;
}) {
  const terminals = useStore((state) => state.terminals);
  const active = useStore((state) => state.activeTerminal);
  const activate = useStore((state) => state.activateTerminal);
  const ready = useStore((state) => state.ready);
  const startError = useStore((state) => state.startError);

  return (
    <Tabs.Root
      className="terminals"
      value={active}
      onValueChange={(value) => activate(value as number)}
    >
      <div className="bar tab-bar terminal-bar">
        <Tabs.List className="tab-list">
          {terminals.map((id, index) => (
            <Tabs.Tab key={id} value={id} className="tab">
              {id === FIRST_SESSION && firstTab === 'Server' ? (
                <RiServerLine size={14} />
              ) : (
                <RiTerminalBoxLine size={14} />
              )}
              <span className="tab-name">{id === FIRST_SESSION ? firstTab : `Shell ${index}`}</span>
              {id !== FIRST_SESSION && (
                <span
                  className="tab-close"
                  role="button"
                  aria-label={`Close shell ${index}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    workspace().closeTerminal(id);
                    disposeTerminal(id);
                  }}
                >
                  <RiCloseLine size={14} />
                </span>
              )}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <button
          type="button"
          className="icon-button"
          title="New shell"
          disabled={!ready}
          onClick={() => workspace().openTerminal()}
        >
          <RiAddLine size={16} />
        </button>
        {onMaximize && (
          <button
            type="button"
            className="icon-button"
            title={maximized ? 'Show the files and the editor' : 'Maximize the terminals'}
            aria-pressed={maximized}
            onClick={onMaximize}
          >
            {maximized ? <RiFullscreenExitLine size={16} /> : <RiFullscreenLine size={16} />}
          </button>
        )}
      </div>
      <div className="terminal-stack">
        {terminals.map((id) => (
          <TerminalPanel key={id} id={id} visible={id === active} />
        ))}
        {!terminals.length && !startError && <Pending label="Starting the shell" />}
      </div>
    </Tabs.Root>
  );
}
