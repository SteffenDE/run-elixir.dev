import { RiCloseLine, RiInformationLine } from '@remixicon/react';
import { useEffect, useState } from 'react';
import { templateSeen, type Project } from '@/shared/lib/projects';
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
  const same = made.label === current.label;
  return (
    <div className="template-notice" role="status">
      <RiInformationLine size={16} />
      <p>
        This project was made from {same ? 'an earlier build of' : 'an earlier'} Phoenix template (
        {made.label}); its changes now sit over the current one ({current.label}). If something
        stops working, compare its config and <code>mix.lock</code> with a new Phoenix project.
      </p>
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
