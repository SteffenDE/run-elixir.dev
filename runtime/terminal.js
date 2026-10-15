// A tty's line discipline over xterm.js. Cooked, as a tty driver gives
// one: echo, line editing (left, right, backspace), history (up, down) and
// pastes; the node gets whole lines. Raw (the node asked for it, as IEx's
// line editing does): keys go to the node as typed, and it echoes. Ctrl+C
// interrupts the node in both. `typed`: lines the shell ran before the
// terminal opened, as if typed here (the history). raw(on) switches.
export function lineDiscipline(term, node, typed = []) {
  let line = '';
  let cursor = 0;
  const history = typed.filter((text) => text.trim());
  let recalled = history.length;
  let raw = false;
  const redraw = (next, at = next.length) => {
    term.write('\b'.repeat(cursor) + next + ' '.repeat(Math.max(0, line.length - next.length)));
    term.write('\b'.repeat(Math.max(line.length, next.length) - at));
    line = next;
    cursor = at;
  };
  const enter = (text) => {
    if (text.trim()) history.push(text);
    recalled = history.length;
    node.input(text + '\n');
  };
  term.onData((data) => {
    if (raw) {
      if (data === '\x03') {
        term.write('^C');
        node.interrupt();
      } else node.input(data);
    } else if (data === '\r') {
      term.write('\r\n');
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
        term.write('\b');
        cursor--;
      }
    } else if (data === '\x1b[C') {
      if (cursor < line.length) {
        term.write(line[cursor]);
        cursor++;
      }
    } else if (data === '\x03') {
      term.write('^C\r\n');
      line = '';
      cursor = 0;
      node.interrupt();
    } else if (!data.startsWith('\x1b')) {
      const text = data.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f]/g, '');
      if (text.includes('\n')) {
        const lines = (line.slice(0, cursor) + text + line.slice(cursor)).split('\n');
        const last = lines.pop();
        term.write(text.replace(/\n/g, '\r\n'));
        for (const each of lines) enter(each);
        line = last;
        cursor = last.length;
      } else {
        redraw(line.slice(0, cursor) + text + line.slice(cursor), cursor + text.length);
      }
    }
  });
  return {
    // A line being typed goes to the node to edit, off the screen here.
    raw(on) {
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
