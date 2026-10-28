import { RiErrorWarningLine, RiUploadCloud2Line } from '@remixicon/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useActive } from '@/project/lib/active';
import { git } from '@/project/lib/playground';
import { push, pushTarget, type Pushed, type Target } from '@/project/lib/push';
import { useStore } from '@/project/lib/store';
import { loadGitHub, type GitHubToken } from '@/shared/lib/github';
import { getProject, updateProject } from '@/shared/lib/projects';
import { apexUrl } from '@elixir-playground/runtime/lib/site';

// The Changes panel's Push: what changed committed (with a message), then
// the branch pushed to the GitHub repository its remote names, with the
// user's token (push.ts). This page's own dialog: no project's code can
// click it.
export function PushDialog({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [token, setToken] = useState<GitHubToken | null | undefined>(undefined);
  const [target, setTarget] = useState<Target | null>(null);
  // The repository it pushed to before, if not this one.
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [pushed, setPushed] = useState<Pushed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const project = useActive((state) => state.active?.project ?? null);
  const unsaved = useStore((state) => state.tabs.filter((tab) => tab.draft !== tab.saved).length);

  useLayoutEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    void loadGitHub().then(setToken);
    pushTarget(git).then(
      async (found) => {
        setTarget(found);
        const before = project && (await getProject(project.id))?.pushedTo;
        const here = `${found.owner}/${found.name}`;
        if (before && before !== here) setElsewhere(before);
      },
      (failure: Error) => setError(failure.message),
    );
  }, [project]);

  const repository = target && `${target.owner}/${target.name}`;
  const busy = progress !== null && !pushed && !error;
  const go = () => {
    if (!target || !token) return;
    setError(null);
    setProgress('Starting…');
    push(git, token, target.uncommitted ? message.trim() : null, setProgress).then(
      async (done) => {
        if (project) await updateProject(project.id, { pushedTo: repository! });
        setPushed(done);
      },
      (failure: Error) => {
        setProgress(null);
        setError(failure.message);
        // What is committed by now (the commit before a failed push).
        void pushTarget(git).then(setTarget, () => {});
      },
    );
  };

  return (
    <dialog
      ref={dialog}
      className="start-error push-dialog"
      aria-labelledby="push-title"
      onClose={onClose}
      onCancel={(event) => busy && event.preventDefault()}
    >
      <h2 id="push-title" className="start-error-title">
        <RiUploadCloud2Line size={18} />
        {repository ? `Push to ${repository}` : 'Push to GitHub'}
      </h2>
      {pushed ? (
        <>
          <p>
            {pushed.commits === 0
              ? `GitHub's ${target!.merge} is up to date.`
              : `Pushed ${pushed.commits} ${pushed.commits === 1 ? 'commit' : 'commits'} to ${target!.merge}.`}{' '}
            <a href={pushed.url} target="_blank" rel="noreferrer">
              View on GitHub
            </a>
          </p>
          {pushed.rewritten && (
            <p className="muted">
              GitHub created commits with the same files but different commit IDs. The local branch{' '}
              {target!.branch} now points to those commits.
            </p>
          )}
        </>
      ) : (
        <>
          {token === null && (
            <p>
              Pushing needs a GitHub token: <a href={apexUrl('/settings')}>add one in Settings</a>.
              The project keeps running meanwhile.
            </p>
          )}
          {target && (
            <p>
              <code>{target.branch}</code> goes to <strong>{repository}</strong>
              {target.merge !== target.branch && (
                <>
                  {' '}
                  as <code>{target.merge}</code>
                </>
              )}
              {target.ahead !== null &&
                ` (${target.ahead} ${target.ahead === 1 ? 'commit' : 'commits'} to push${target.uncommitted ? ', and a new one' : ''})`}
              .
            </p>
          )}
          {elsewhere && (
            <p className="folder-review-warning">
              <RiErrorWarningLine size={16} />
              <span>
                This project pushed to <strong>{elsewhere}</strong> before. Its remote now points to{' '}
                <strong>{repository}</strong>. Check the destination before pushing.
              </span>
            </p>
          )}
          {target && target.uncommitted > 0 && (
            <>
              <p className="muted">
                {target.uncommitted === 1
                  ? '1 changed file will be committed before pushing.'
                  : `${target.uncommitted} changed files will be committed before pushing.`}
                {unsaved > 0 &&
                  ` ${unsaved} open ${unsaved === 1 ? 'file has' : 'files have'} unsaved edits that will not be included.`}
              </p>
              <textarea
                className="settings-script"
                aria-label="Commit message"
                placeholder="What changed"
                rows={3}
                disabled={busy}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </>
          )}
        </>
      )}
      {progress && !pushed && !error && <p className="muted">{progress}</p>}
      {error && <p className="project-error">{error}</p>}
      <div className="start-error-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => dialog.current?.close()}
        >
          {pushed ? 'Close' : 'Cancel'}
        </button>
        {!pushed && (
          <button
            type="button"
            className="button primary"
            disabled={busy || !token || !target || (target.uncommitted > 0 && !message.trim())}
            onClick={go}
          >
            {busy ? 'Pushing…' : target?.uncommitted ? 'Commit and push' : 'Push'}
          </button>
        )}
      </div>
    </dialog>
  );
}
