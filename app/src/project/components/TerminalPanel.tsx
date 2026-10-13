import { useEffect, useRef } from 'react';
import { terminalFor } from '@/project/lib/terminal-handle';

// Where shell `id`'s terminal shows (terminal-handle.ts owns it).
export function TerminalPanel({ id, visible }: { id: number; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminal = terminalFor(id);
    terminal.attach(host.current!);
    return () => terminal.detach();
  }, [id]);
  // Shown: focus it, unless the user is busy elsewhere (renaming, typing
  // in the editor) while a shell starts.
  useEffect(() => {
    const busy = document.activeElement;
    const elsewhere =
      busy && busy !== document.body && !busy.closest('.terminals, .tab-list, .terminal-bar');
    if (visible && !elsewhere) terminalFor(id).focus();
  }, [id, visible]);
  return <div className="terminal-host" ref={host} hidden={!visible} />;
}
