import { RiGitRepositoryLine } from '@remixicon/react';
import { useState } from 'react';
import { navigate } from '@/shared/lib/navigate';
import { parseRepository, repositoryPath } from '@/shared/lib/repository';

// A public repository's address, pasted: its page (RepositoryPage), which
// opens it as a new project.
export function RepositoryImport() {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="home-alert repository-import"
      onSubmit={(event) => {
        event.preventDefault();
        const repository = parseRepository(text);
        if (repository) navigate(repositoryPath(repository));
        else
          setError(
            'That is not the address of a repository on GitHub, GitLab or Codeberg (https://github.com/OWNER/REPO, or OWNER/REPO for GitHub).',
          );
      }}
    >
      <RiGitRepositoryLine size={16} />
      <div className="repository-import-body">
        <p>Or open a public repository from GitHub, GitLab or Codeberg:</p>
        <div className="repository-import-row">
          <input
            className="text-field"
            aria-label="Repository address"
            placeholder="https://github.com/OWNER/REPO"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
          />
          <button type="submit" className="button" disabled={!text.trim()}>
            Open
          </button>
        </div>
        {error && (
          <p className="project-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
