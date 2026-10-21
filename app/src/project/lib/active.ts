// The project this tab runs (main.tsx): it keeps running while the tab
// shows another of the app's pages (the projects, settings, Tailscale), and
// stops only when the tab goes to another project, or the project is
// deleted.
import { create } from 'zustand';
import { leaveSession } from '@/live/lib/host';
import { releaseProject } from '@/shared/lib/lock';
import type { Project } from '@/shared/lib/projects';
import { leave } from './playground';

export interface Active {
  // Its id, or 'iex' for a temporary IEx.
  key: string;
  project: Project | null;
  name: string;
  // Its page's path (/ID/, /iex).
  path: string;
}

interface State {
  active: Active | null;
  // The page the tab shows (the floating way back hides on the project's).
  here: string;
}

export const useActive = create<State>(() => ({ active: null, here: '/' }));

// Stop the project this tab runs, as leaving it for another does.
export async function stopActive(): Promise<void> {
  if (!useActive.getState().active) return;
  useActive.setState({ active: null });
  leaveSession();
  await leave();
  releaseProject();
}
