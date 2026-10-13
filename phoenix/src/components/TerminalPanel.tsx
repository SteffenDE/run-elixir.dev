import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { cooked } from '../../../runtime/terminal.js';
import { interrupt, onOutput, type } from '../playground';

// The node's shell: the Phoenix server's IEx, and mix after Ctrl+C.
export function TerminalPanel() {
  const host = useRef<HTMLDivElement>(null);
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
    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(host.current!);
    cooked(term, { input: type, interrupt });
    const unsubscribe = onOutput((text) => term.write(text));
    return () => {
      unsubscribe();
      resize.disconnect();
      term.dispose();
    };
  }, []);
  return <div className="terminal-host" ref={host} />;
}
