import { RiCloseLine, RiErrorWarningLine, RiLoader4Line } from '@remixicon/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '@/project/lib/store';

const PENDING = {
  queued: 'Waiting for a build machine.',
  running: 'Building it in a virtual machine; this usually takes under a minute.',
  setting_up:
    'No recipe builds this package yet, so an agent is working one out in a virtual machine. ' +
    'This can take several minutes; the recipe is kept, so later versions build directly.',
} as const;

// A package's NIF library the playground's backend builds while make (in
// mix compile) waits for it, or why it could not: in a modal dialog, which
// can be hidden while the build goes on. Ctrl-C in the terminal stops
// waiting.
export function NifBuildDialog() {
  const build = useStore((state) => state.nifBuild);
  const dismiss = useStore((state) => state.dismissNifBuild);
  const dialog = useRef<HTMLDialogElement>(null);
  const shown = build !== null;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !shown) return;
    element.showModal();
    return () => element.close();
  }, [shown]);
  const seconds = useSeconds(build?.since ?? null, build !== null && build.status in PENDING);
  if (!build) return null;

  const what = `${build.name} ${build.version}`;
  const pending = build.status in PENDING;
  return (
    <dialog
      ref={dialog}
      className="start-error nif-build"
      aria-labelledby="nif-build-title"
      onClose={dismiss}
    >
      <h2
        id="nif-build-title"
        className={`start-error-title${pending ? ' nif-build-pending' : ''}`}
      >
        {pending ? <RiLoader4Line size={18} className="spin" /> : <RiErrorWarningLine size={18} />}
        {pending
          ? `Building ${what}'s native code`
          : build.status === 'unsupported'
            ? `${what} can't be built for the playground`
            : `${what}'s native code could not be built`}
      </h2>
      {pending ? (
        <>
          <p>
            Its NIF library has to be compiled to WebAssembly, which the playground's server does
            once for everyone. {PENDING[build.status as keyof typeof PENDING]}
          </p>
          <p className="nif-build-meta">
            {formatSeconds(seconds)} · the terminal waits for it; Ctrl-C there stops waiting.
          </p>
        </>
      ) : (
        <pre className="start-error-message">{build.error ?? build.status}</pre>
      )}
      <div className="start-error-actions">
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          <RiCloseLine size={16} />
          {pending ? 'Hide' : 'Close'}
        </button>
      </div>
    </dialog>
  );
}

// Seconds since `since`, ticking while `running`.
function useSeconds(since: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

function formatSeconds(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
