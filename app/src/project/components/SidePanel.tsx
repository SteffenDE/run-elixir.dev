import { Tabs } from '@base-ui/react/tabs';
import { RiFolder3Line, RiGitBranchLine, RiSearchLine } from '@remixicon/react';
import { useEffect } from 'react';
import { ChangesPanel } from '@/project/components/ChangesPanel';
import { FileTreePanel } from '@/project/components/FileTreePanel';
import { SearchPanel } from '@/project/components/SearchPanel';
import { Pending } from '@/shared/components/Pending';
import { useStore, type SideTab } from '@/project/lib/store';
import { isModifierKeyPressed } from '@/shared/lib/keys';

// The side panel: the file tree, the search of the files' contents
// (⌘⇧F / Ctrl+Shift+F, which also shows the panel), or what changed (git;
// not for a live session's guest, whose project runs elsewhere). They stay
// mounted, so each keeps its state.
export function SidePanel() {
  const tab = useStore((state) => state.sideTab);
  const setTab = useStore((state) => state.setSideTab);
  const listed = useStore((state) => state.listed);
  const startError = useStore((state) => state.startError);
  const remote = useStore((state) => state.remote);
  const changed = useStore((state) => state.changes?.changes.length ?? 0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isModifierKeyPressed(event) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      event.stopPropagation();
      useStore.getState().focusSearch();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <Tabs.Root
      className="side-panel"
      value={tab}
      onValueChange={(value) => setTab(value as SideTab)}
    >
      <div className="bar tab-bar">
        <Tabs.List className="tab-list">
          <Tabs.Tab value="files" className="tab" title="Files">
            <RiFolder3Line size={14} />
            Files
          </Tabs.Tab>
          <Tabs.Tab value="search" className="tab" title="Search">
            <RiSearchLine size={14} />
            Search
          </Tabs.Tab>
          {!remote && (
            <Tabs.Tab value="changes" className="tab" title="Changes">
              <RiGitBranchLine size={14} />
              Changes
              {changed > 0 && <span className="tab-count">{changed}</span>}
            </Tabs.Tab>
          )}
        </Tabs.List>
      </div>
      <Tabs.Panel value="files" keepMounted className="side-pane">
        <FileTreePanel />
        {!listed && !startError && <Pending label="Loading the files" />}
      </Tabs.Panel>
      <Tabs.Panel value="search" keepMounted className="side-pane">
        <SearchPanel />
      </Tabs.Panel>
      {!remote && (
        <Tabs.Panel value="changes" keepMounted className="side-pane">
          <ChangesPanel />
        </Tabs.Panel>
      )}
    </Tabs.Root>
  );
}
