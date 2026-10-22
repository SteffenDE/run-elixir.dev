import { RiLoader4Line } from '@remixicon/react';

// A spinner over a pane with nothing to show yet (the tree before its
// first listing, a shell before its first output); clicks go through.
export function Pending({ label }: { label: string }) {
  return (
    <div className="pending" role="status" aria-label={label}>
      <RiLoader4Line size={20} className="spin" />
    </div>
  );
}
