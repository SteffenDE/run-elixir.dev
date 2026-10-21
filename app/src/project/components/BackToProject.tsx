import { RiArrowLeftLine } from '@remixicon/react';
import { useActive } from '@/project/lib/active';
import { useStore } from '@/project/lib/store';

// The project this tab runs, while another page shows: the way back to it.
export function BackToProject() {
  const active = useActive((state) => state.active);
  const here = useActive((state) => state.here);
  const unsaved = useStore((state) => state.tabs.some((tab) => tab.draft !== tab.saved));
  if (!active || here === active.path) return null;
  return (
    <a
      className="back-to-project"
      href={active.path}
      title={`${active.name} is still running${unsaved ? ', with unsaved changes' : ''}`}
    >
      <RiArrowLeftLine size={16} />
      <span className="back-to-project-name">Back to {active.name}</span>
      <span className={unsaved ? 'running-dot unsaved' : 'running-dot'} aria-hidden />
    </a>
  );
}
