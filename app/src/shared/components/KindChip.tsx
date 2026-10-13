import { RiFireLine, RiFolderLine, RiTerminalLine } from '@remixicon/react';
import type { WorkspaceKind } from '@/shared/lib/projects';

const LABELS: Record<WorkspaceKind, string> = { phoenix: 'Phoenix', empty: 'Empty', iex: 'IEx' };

// What kind of project this is, as a small label.
export function KindChip({ kind }: { kind: WorkspaceKind }) {
  const Icon = kind === 'phoenix' ? RiFireLine : kind === 'iex' ? RiTerminalLine : RiFolderLine;
  return (
    <span className={`chip kind-${kind}`}>
      <Icon size={12} />
      {LABELS[kind]}
    </span>
  );
}
