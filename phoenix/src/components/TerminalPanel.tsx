import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { cooked } from '../../../runtime/terminal.js';
import { interrupt, onOutput, type } from '../playground';

// One shell's terminal (playground.ts session `id`).
export function TerminalPanel({ id, visible }: { id: number; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#16141c' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    terminal.current = term;
    const resize = new ResizeObserver(() => {
      if (host.current?.offsetParent) fit.fit();
    });
    resize.observe(host.current!);
    cooked(term, { input: (text) => type(id, text), interrupt: () => interrupt(id) });
    const unsubscribe = onOutput(id, (text) => term.write(text));
    return () => {
      unsubscribe();
      resize.disconnect();
      term.dispose();
      terminal.current = null;
    };
  }, [id]);
  useEffect(() => {
    if (visible) terminal.current?.focus();
  }, [visible]);
  return <div className="terminal-host" ref={host} hidden={!visible} />;
}
