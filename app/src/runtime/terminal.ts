// A tty's line discipline, one per shell, as a tty driver keeps it.
// Cooked: echo, line editing (left, right, backspace), history (up, down)
// and pastes; the node gets whole lines. Raw (the node asked for it, as
// IEx's line editing does): keys go to the node as typed, and it echoes.
// Ctrl+C interrupts the node in both. `keys` are what anyone's terminal
// typed (a live session's guests too); `echo` goes into the shell's
// output, so everyone sees it, as they see the node's. `typed`: lines the
// shell ran before the terminal opened, as if typed here (the history).
// raw(on) switches.
export interface Typist {
  input(text: string): void;
  interrupt(): void;
}

export function lineDiscipline(
  echo: (text: string) => void,
  node: Typist,
  typed: string[] = [],
): { keys(data: string): void; raw(on: boolean): void } {
  let line = '';
  let cursor = 0;
  const history = typed.filter((text) => text.trim());
  let recalled = history.length;
  let raw = false;
  // The line as `next`, the caret at `at`: from where the two first
  // differ, so a key typed at the end echoes just itself.
  const redraw = (next: string, at = next.length) => {
    let same = 0;
    while (same < line.length && same < next.length && line[same] === next[same]) same++;
    const from = cursor > same ? '\b'.repeat(cursor - same) : line.slice(cursor, same);
    const rest = next.slice(same) + ' '.repeat(Math.max(0, line.length - next.length));
    echo(from + rest + '\b'.repeat(same + rest.length - at));
    line = next;
    cursor = at;
  };
  const enter = (text: string) => {
    if (text.trim()) history.push(text);
    recalled = history.length;
    node.input(text + '\n');
  };
  const keys = (data: string) => {
    if (raw) {
      if (data === '\x03') {
        echo('^C');
        node.interrupt();
      } else node.input(data);
    } else if (data === '\r') {
      echo('\r\n');
      enter(line);
      line = '';
      cursor = 0;
    } else if (data === '\x7f') {
      if (cursor > 0) redraw(line.slice(0, cursor - 1) + line.slice(cursor), cursor - 1);
    } else if (data === '\x1b[A' || data === '\x1b[B') {
      recalled = Math.max(0, Math.min(history.length, recalled + (data === '\x1b[A' ? -1 : 1)));
      redraw(history[recalled] ?? '');
    } else if (data === '\x1b[D') {
      if (cursor > 0) {
        echo('\b');
        cursor--;
      }
    } else if (data === '\x1b[C') {
      if (cursor < line.length) {
        echo(line[cursor]);
        cursor++;
      }
    } else if (data === '\x03') {
      echo('^C\r\n');
      line = '';
      cursor = 0;
      node.interrupt();
    } else if (!data.startsWith('\x1b')) {
      // oxlint-disable-next-line no-control-regex -- control keys, but newlines.
      const text = data.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f]/g, '');
      if (text.includes('\n')) {
        const lines = (line.slice(0, cursor) + text + line.slice(cursor)).split('\n');
        const last = lines.pop()!;
        echo(text.replace(/\n/g, '\r\n'));
        for (const each of lines) enter(each);
        line = last;
        cursor = last.length;
      } else {
        redraw(line.slice(0, cursor) + text + line.slice(cursor), cursor + text.length);
      }
    }
  };
  return {
    keys,
    // A line being typed goes to the node to edit, off the screen here.
    raw(on: boolean) {
      if (on === raw) return;
      raw = on;
      if (raw && line) {
        const typing = line;
        redraw('', 0);
        node.input(typing);
      }
      line = '';
      cursor = 0;
    },
  };
}
