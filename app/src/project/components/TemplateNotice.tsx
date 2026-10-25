import { RiCloseLine, RiInformationLine } from '@remixicon/react';
import { useEffect, useState } from 'react';
import type { Project } from '@/shared/lib/projects';
import { templateSeen } from '@/shared/lib/projects';
import { siteTemplate, type Template } from '@/shared/lib/templates';

// A project made from another version of its template: its changes now
// sit over the site's, which may not fit them. Dismissing it takes the
// site's as the project's; a project that noted none takes it silently.
export function TemplateNotice({ project }: { project: Project | null }) {
  const [current, setCurrent] = useState<Template | null>(null);
  const [made, setMade] = useState(project?.template ?? null);

  useEffect(() => {
    if (!project) return;
    void siteTemplate(project.kind).then((template) => {
      if (!template) return;
      if (!project.template) void templateSeen(project.id, template);
      setCurrent(template);
    });
  }, [project]);

  if (!project || !current || !made || made.id === current.id) return null;
  return (
    <div className="template-notice" role="status">
      <RiInformationLine size={16} />
      {made.label === current.label ? (
        <p>
          The project&apos;s changes were applied onto a new version of the template. See the
          Changes tab for details.
        </p>
      ) : (
        <p>
          This project used Phoenix template {made.label}. Its saved changes have been applied to
          the current template ({current.label}). If the project fails, compare its configuration
          and <code>mix.lock</code> with a new Phoenix project.
        </p>
      )}
      <button
        type="button"
        className="icon-button"
        title="Dismiss"
        onClick={() => {
          void templateSeen(project.id, current);
          setMade(current);
        }}
      >
        <RiCloseLine size={16} />
      </button>
    </div>
  );
}
