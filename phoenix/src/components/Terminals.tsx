import { Tabs } from '@base-ui/react/tabs';
import { RiAddLine, RiCloseLine, RiServerLine, RiTerminalBoxLine } from '@remixicon/react';
import { SERVER_SESSION, closeTerminal, openTerminal } from '../playground';
import { useStore } from '../store';
import { TerminalPanel } from './TerminalPanel';

// The shells, in tabs: the first runs the Phoenix server; more run mix
// and friends beside it (each a node of its own over the same files).
export function Terminals() {
  const terminals = useStore((state) => state.terminals);
  const active = useStore((state) => state.activeTerminal);
  const activate = useStore((state) => state.activateTerminal);
  const ready = useStore((state) => state.ready);

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
              {id === SERVER_SESSION ? <RiServerLine size={14} /> : <RiTerminalBoxLine size={14} />}
              <span className="tab-name">
                {id === SERVER_SESSION ? 'Server' : `Shell ${index}`}
              </span>
              {id !== SERVER_SESSION && (
                <span
                  className="tab-close"
                  role="button"
                  aria-label={`Close shell ${index}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTerminal(id);
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
          title="New shell (beside the server)"
          disabled={!ready}
          onClick={() => openTerminal()}
        >
          <RiAddLine size={16} />
        </button>
      </div>
      <div className="terminal-stack">
        {terminals.map((id) => (
          <TerminalPanel key={id} id={id} visible={id === active} />
        ))}
      </div>
    </Tabs.Root>
  );
}
