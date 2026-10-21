import { RiArrowLeftLine, RiSettings3Line } from '@remixicon/react';
import { useEffect, useState } from 'react';
import { EnvEditor } from '@/shared/components/EnvEditor';
import { loadSettings, saveSettings, settingsChanged, type Settings } from '@/shared/lib/settings';

// /settings on the apex: the user's settings for every project of this
// browser (shared/lib/settings.ts). A project from a link or a fork takes
// them only once the user allows it.
export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<'saved' | 'unsaved' | null>(null);
  useEffect(() => {
    document.title = 'Settings · Elixir Playground';
    void loadSettings().then(setSettings);
  }, []);
  if (!settings) return null;
  const change = (changes: Partial<Settings>) => {
    setSettings({ ...settings, ...changes });
    setSaved('unsaved');
  };
  const save = async () => {
    await saveSettings(settings);
    settingsChanged();
    setSaved('saved');
  };
  return (
    <div className="home">
      <main className="home-main settings-page">
        <a className="tailscale-back" href="/">
          <RiArrowLeftLine size={14} /> Projects
        </a>
        <h1 className="home-title">
          <RiSettings3Line size={22} /> Settings
        </h1>
        <p className="muted home-lead">
          For every project in this browser. A project from someone else (a link, a live session's
          fork) asks before it takes them.
        </p>

        <h2>Environment</h2>
        <p className="muted">
          Every shell starts with these, and what it runs gets them: a token for a tool, say (
          <code>CLAUDE_CODE_OAUTH_TOKEN</code> from <code>claude setup-token</code>). Projects
          already open give them to their new shells.
        </p>
        <EnvEditor label="Environment" env={settings.env} onChange={(env) => change({ env })} />

        <h2>Shared folder</h2>
        <label className="live-check">
          <input
            type="checkbox"
            checked={settings.shared}
            onChange={(event) => change({ shared: event.target.checked })}
          />
          <span>
            <code>/shared</code>, the same folder in every project, kept in this browser
          </span>
        </label>
        <p className="muted">
          What one project changes there, the others open see at once. Link a tool's folder into it
          to share its settings (the setup script below can).
        </p>

        <h2>Setup script</h2>
        <p className="muted">
          Each new project runs it once, in its first shell, when it first starts.
        </p>
        <textarea
          className="settings-script"
          aria-label="Setup script"
          spellCheck={false}
          rows={5}
          placeholder={'mkdir -p /shared/claude\nln -s /shared/claude ~/.claude'}
          value={settings.setup}
          onChange={(event) => change({ setup: event.target.value })}
        />

        <div className="settings-save">
          <button type="button" className="button primary" onClick={() => void save()}>
            Save
          </button>
          {saved === 'saved' && <span className="muted">Saved.</span>}
          {saved === 'unsaved' && <span className="muted">Not saved yet.</span>}
        </div>
      </main>
    </div>
  );
}
