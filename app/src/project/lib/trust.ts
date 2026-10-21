// A project from a share link or a live session's fork, at its first
// start: whether it takes the user's settings (settings.ts), asked before
// anything runs (TrustDialog); the answer is kept on the project.
import { create } from 'zustand';

export interface TrustQuestion {
  // The project's name, and what would apply: the environment's names (not
  // their values), /shared, the setup script.
  name: string;
  env: string[];
  shared: boolean;
  setup: string;
}

export const useTrust = create<{ asking: TrustQuestion | null }>(() => ({ asking: null }));

let waiting: ((allowed: boolean) => void) | null = null;

export function askTrust(question: TrustQuestion, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cancel = () => answerTrust(false);
    waiting = (allowed) => {
      signal.removeEventListener('abort', cancel);
      resolve(allowed);
    };
    signal.addEventListener('abort', cancel, { once: true });
    useTrust.setState({ asking: question });
  });
}

export function answerTrust(allowed: boolean): void {
  const answer = waiting;
  waiting = null;
  useTrust.setState({ asking: null });
  answer?.(allowed);
}
