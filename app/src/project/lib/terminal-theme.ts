// The terminal's colours, one set for each colour scheme, drawn from the
// palette in styles.css. The background is `--term` there too, so the
// padding around xterm matches. The light set uses darker ANSI colours so
// that yellow, cyan and white stay readable on a pale background.
import type { ITheme } from '@xterm/xterm';

export type Scheme = 'light' | 'dark';

const dark: ITheme = {
  background: '#16141c',
  foreground: '#e8e5ee',
  cursor: '#ff7a50',
  cursorAccent: '#16141c',
  selectionBackground: '#b79ae044',
  black: '#2c2a33',
  red: '#f47067',
  green: '#8ccf7e',
  yellow: '#e5c07b',
  blue: '#7aa2f7',
  magenta: '#c49bf0',
  cyan: '#6cc8c8',
  white: '#d4d0dc',
  brightBlack: '#6d6879',
  brightRed: '#ff8a80',
  brightGreen: '#a6e08f',
  brightYellow: '#f2d28c',
  brightBlue: '#9bb9ff',
  brightMagenta: '#d9b8ff',
  brightCyan: '#8ee0e0',
  brightWhite: '#ffffff',
};

const light: ITheme = {
  background: '#fdfcfa',
  foreground: '#23202a',
  cursor: '#e5532d',
  cursorAccent: '#fdfcfa',
  selectionBackground: '#6e4a9e33',
  black: '#23202a',
  red: '#c4321c',
  green: '#2f7d32',
  yellow: '#8a6100',
  blue: '#2f5fb8',
  magenta: '#7a3fa8',
  cyan: '#1b7a7f',
  white: '#8a8594',
  brightBlack: '#6d6879',
  brightRed: '#d9442b',
  brightGreen: '#3a8f3d',
  brightYellow: '#9c6f00',
  brightBlue: '#3b6fd1',
  brightMagenta: '#8e4fc0',
  brightCyan: '#22898e',
  brightWhite: '#23202a',
};

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

// The page's scheme: a `data-theme` on <html> wins over the system's, as in
// styles.css.
export function scheme(): Scheme {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return darkQuery.matches ? 'dark' : 'light';
}

export function terminalTheme(): ITheme {
  return scheme() === 'dark' ? dark : light;
}

// Calls `listener` whenever the scheme may have changed; returns the
// unsubscribe.
export function onSchemeChange(listener: () => void): () => void {
  darkQuery.addEventListener('change', listener);
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => {
    darkQuery.removeEventListener('change', listener);
    observer.disconnect();
  };
}
