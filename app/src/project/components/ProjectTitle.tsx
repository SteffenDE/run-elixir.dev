import { useState } from 'react';
import type { Project } from '@/shared/lib/projects';
import { renameProject } from '@/shared/lib/projects';
import { KindChip } from '@/shared/components/KindChip';

// The project's name, renamed in place, and what kind it is. A temporary
// IEx has no name: it says it is ephemeral.
export function ProjectTitle({ project }: { project: Project | null }) {
  const [name, setName] = useState(project?.name ?? '');
  const [editing, setEditing] = useState(false);

  if (!project) {
    return (
      <div className="project-title">
        <KindChip kind="iex" />
        <span
          className="chip ephemeral"
          title="Temporary session. Closing the tab discards all files and changes."
        >
          ephemeral
        </span>
      </div>
    );
  }

  const commit = (text: string) => {
    setEditing(false);
    const next = text.trim();
    if (!next || next === name) return;
    setName(next);
    document.title = `${next} · Elixir Playground`;
    void renameProject(project.id, next);
  };

  return (
    <div className="project-title">
      {editing ? (
        <input
          className="project-name-input"
          defaultValue={name}
          aria-label="Project name"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the user asked to rename.
          autoFocus
          spellCheck={false}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(event.currentTarget.value);
            else if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="project-name"
          title="Rename"
          onClick={() => setEditing(true)}
        >
          {name}
        </button>
      )}
      <KindChip kind={project.kind} />
    </div>
  );
}
