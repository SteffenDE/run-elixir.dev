// The project this tab runs (main.tsx): it keeps running while the tab
// shows another of the app's pages (the projects, settings, Tailscale), and
// stops only when the tab goes to another project, or the project is
// deleted. Unsaved edits are the user's to save or discard first
// (LeaveDialog).
import { create } from 'zustand';
import { leaveSession } from '@/live/lib/host';
import { releaseProject } from '@/shared/lib/lock';
import type { Project } from '@/shared/lib/projects';
import { leave, save } from './playground';
import { useStore } from './store';

export interface Active {
  // Its id, or 'iex' for a temporary IEx.
  key: string;
  project: Project | null;
  name: string;
  // Its page's path (/ID/, /iex).
  path: string;
}

export type LeaveChoice = 'save' | 'discard' | 'stay';

interface State {
  active: Active | null;
  // The page the tab shows (the floating way back hides on the project's).
  here: string;
  // Asking what becomes of these unsaved files (absolute paths).
  asking: { name: string; files: string[] } | null;
}

export const useActive = create<State>(() => ({ active: null, here: '/', asking: null }));

let answer: ((choice: LeaveChoice) => void) | null = null;

export function answerLeave(choice: LeaveChoice): void {
  const answered = answer;
  answer = null;
  useActive.setState({ asking: null });
  answered?.(choice);
}

// Whether the tab may go on to another project: yes when nothing is unsaved,
// else as the user says (the edits saved or discarded first, or staying).
export async function mayLeave(): Promise<boolean> {
  const { active } = useActive.getState();
  const unsaved = useStore.getState().tabs.filter((tab) => tab.draft !== tab.saved);
  if (!active || !unsaved.length) return true;
  answerLeave('stay');
  const choice = await new Promise<LeaveChoice>((resolve) => {
    answer = resolve;
    useActive.setState({ asking: { name: active.name, files: unsaved.map((tab) => tab.path) } });
  });
  if (choice === 'stay') return false;
  if (choice === 'discard') return true;
  try {
    for (const tab of unsaved) await save(tab.path, tab.draft);
    return true;
  } catch (error) {
    useStore.getState().setStatus(`Could not save: ${(error as Error).message}`);
    return false;
  }
}

// Stop the project this tab runs, as leaving it for another does.
export async function stopActive(): Promise<void> {
  if (!useActive.getState().active) return;
  useActive.setState({ active: null });
  leaveSession();
  await leave();
  releaseProject();
}
