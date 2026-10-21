// The user's settings (docs/projects.md#settings), kept on the apex: for
// every project of this browser, and a project's own (projects.ts's
// Project: its startup lines, its environment, what it was allowed).
//
// A project from a link or a live session's fork takes the user's (their
// environment, /shared, the setup script) only once the user allows it
// (`trust`); its own settings are the user's, made here, and always apply.
import { database, type Project } from './projects';

export interface Settings {
  // Environment for every shell and what it runs (CLAUDE_CODE_OAUTH_TOKEN,
  // say), under the playground's own (HOME, PATH, Hex's).
  env: Record<string, string>;
  // /shared: a folder every project shares, kept on the apex.
  shared: boolean;
  // Lines a new project runs once, at its first start, in its first shell
  // (to link ~/.claude into /shared, say).
  setup: string;
}

export const DEFAULT_SETTINGS: Settings = { env: {}, shared: true, setup: '' };
const KEY = 'user';

export async function loadSettings(): Promise<Settings> {
  const record = await database.settings.get(KEY).catch(() => undefined);
  return { ...DEFAULT_SETTINGS, ...(record?.value as Partial<Settings> | undefined) };
}

export async function saveSettings(changes: Partial<Settings>): Promise<Settings> {
  const settings = { ...(await loadSettings()), ...changes };
  await database.settings.put({ key: KEY, value: settings });
  return settings;
}

// Whether a project takes the user's settings: its own always; one from a
// link or a fork once allowed. A temporary IEx (no project) does.
export const trusted = (project: Project | null | undefined) =>
  !project?.origin || project.trust === true;

// What a project's shells start with: the user's settings as it takes
// them, and its own.
export interface Applied {
  env: Record<string, string>;
  shared: boolean;
  // The setup script, if this start is the project's first.
  setup: string | null;
  // What its first shell runs (null: its kind's).
  startup: string[] | null;
}

export function applied(settings: Settings, project: Project | null | undefined): Applied {
  const user = trusted(project);
  const lines = (text?: string) =>
    text
      ?.split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim()) ?? [];
  const startup = lines(project?.startup);
  return {
    env: { ...(user ? settings.env : {}), ...project?.env },
    shared: user && settings.shared,
    setup: user && project?.setUp === false && settings.setup.trim() ? settings.setup : null,
    startup: startup.length ? startup : null,
  };
}

// Saved: the projects open in this browser give their new shells the
// settings now (playground.ts hears it).
export const SETTINGS_CHANNEL = 'playground-settings';
export function settingsChanged(): void {
  const channel = new BroadcastChannel(SETTINGS_CHANNEL);
  channel.postMessage('changed');
  channel.close();
}
