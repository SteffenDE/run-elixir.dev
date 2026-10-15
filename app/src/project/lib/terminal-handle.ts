// A shell's terminal: an xterm Terminal that lives as long as the shell,
// not as long as the React component showing it. `attach(container)` puts
// it in the page and fits it; `detach()` takes it out, keeping everything.
//
// The terminal opens in an unpadded element inside a padded root: the fit
// addon measures its parent as if padding were free space, which made the
// last rows and columns spill out. Resizes to nothing (a hidden tab) are
// skipped; showing it again fits it.
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { lineDiscipline } from '@runtime/terminal';
import {
  initialLines,
  interrupt,
  onOutput,
  onTerminalMode,
  resize,
  type,
} from '@/project/lib/playground';
import { linkProvider, openWebLink } from '@/project/lib/terminal-links';
import { onSchemeChange, terminalTheme } from '@/project/lib/terminal-theme';

export class TerminalHandle {
  private readonly root = document.createElement('div');
  private readonly container = document.createElement('div');
  private readonly terminal: Terminal;
  private readonly fit = new FitAddon();
  private resize: ResizeObserver | null = null;
  private unsubscribe: (() => void) | null = null;
  private unwatchMode: (() => void) | null = null;
  private readonly unwatchScheme: () => void;
  private opened = false;

  constructor(private readonly id: number) {
    this.root.className = 'terminal-root';
    this.container.className = 'terminal-container';
    this.root.append(this.container);
    this.terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      // A little smaller on phones, for more columns.
      fontSize: matchMedia('(max-width: 720px)').matches ? 12 : 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: terminalTheme(),
      scrollback: 5000,
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        openWebLink(uri);
      }),
    );
    this.terminal.registerLinkProvider(linkProvider(this.terminal));
    this.unwatchScheme = onSchemeChange(() => {
      this.terminal.options.theme = terminalTheme();
    });
  }

  // The first attach opens the terminal and connects it to its shell.
  private open() {
    this.opened = true;
    this.terminal.open(this.container);
    this.resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width && height) this.fit.fit();
    });
    this.resize.observe(this.container);
    const discipline = lineDiscipline(
      this.terminal,
      {
        input: (text) => type(this.id, text),
        interrupt: () => interrupt(this.id),
      },
      initialLines(this.id),
    );
    // The node's line editing needs the terminal's size.
    this.terminal.onResize(({ cols, rows }) => resize(this.id, cols, rows));
    resize(this.id, this.terminal.cols, this.terminal.rows);
    this.unsubscribe = onOutput(this.id, (text) => this.terminal.write(text));
    this.unwatchMode = onTerminalMode(this.id, (raw) => discipline.raw(raw));
  }

  attach(parent: HTMLElement) {
    parent.append(this.root);
    if (!this.opened) this.open();
    if (this.container.clientWidth && this.container.clientHeight) this.fit.fit();
  }

  detach() {
    this.root.remove();
  }

  focus() {
    this.terminal.focus();
  }

  dispose() {
    this.unsubscribe?.();
    this.unwatchMode?.();
    this.unwatchScheme();
    this.resize?.disconnect();
    this.terminal.dispose();
    this.root.remove();
  }
}

const handles = new Map<number, TerminalHandle>();

// The terminal of shell `id`, made on first use.
export function terminalFor(id: number): TerminalHandle {
  let handle = handles.get(id);
  if (!handle) {
    handle = new TerminalHandle(id);
    handles.set(id, handle);
  }
  return handle;
}

export function disposeTerminal(id: number): void {
  handles.get(id)?.dispose();
  handles.delete(id);
}
