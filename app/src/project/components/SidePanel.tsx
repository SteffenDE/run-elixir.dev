import { Tabs } from '@base-ui/react/tabs';
import { RiFolder3Line, RiSearchLine } from '@remixicon/react';
import { useEffect } from 'react';
import { FileTreePanel } from '@/project/components/FileTreePanel';
import { SearchPanel } from '@/project/components/SearchPanel';
import { useStore, type SideTab } from '@/project/lib/store';
import { isModifierKeyPressed } from '@/shared/lib/keys';

// The side panel: the file tree, or the search of the files' contents
// (⌘⇧F / Ctrl+Shift+F, which also shows the panel). Both stay mounted, so
// each keeps its state.
export function SidePanel() {
  const tab = useStore((state) => state.sideTab);
  const setTab = useStore((state) => state.setSideTab);

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
          <Tabs.Tab value="files" className="tab">
            <RiFolder3Line size={14} />
            Files
          </Tabs.Tab>
          <Tabs.Tab value="search" className="tab">
            <RiSearchLine size={14} />
            Search
          </Tabs.Tab>
        </Tabs.List>
      </div>
      <Tabs.Panel value="files" keepMounted className="side-pane">
        <FileTreePanel />
      </Tabs.Panel>
      <Tabs.Panel value="search" keepMounted className="side-pane">
        <SearchPanel />
      </Tabs.Panel>
    </Tabs.Root>
  );
}
