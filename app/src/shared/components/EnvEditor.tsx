import { RiAddLine, RiCloseLine } from '@remixicon/react';
import { useState } from 'react';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Environment variables as rows of a name and a value (masked unless
// shown: tokens live here); `onChange` hears the rows with a valid name.
export function EnvEditor({
  env,
  onChange,
  label,
}: {
  env: Record<string, string>;
  onChange(env: Record<string, string>): void;
  label: string;
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(env));
  const [shown, setShown] = useState(false);
  const update = (next: [string, string][]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([name]) => NAME.test(name))));
  };
  return (
    <div className="env-editor" role="group" aria-label={label}>
      {rows.map(([name, value], index) => (
        <div className="env-row" key={index}>
          <input
            aria-label="Name"
            className={`env-name${name && !NAME.test(name) ? ' invalid' : ''}`}
            placeholder="NAME"
            spellCheck={false}
            value={name}
            onChange={(event) =>
              update(rows.map((row, i) => (i === index ? [event.target.value, row[1]] : row)))
            }
          />
          <input
            aria-label={`Value of ${name || 'this variable'}`}
            className="env-value"
            type={shown ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) =>
              update(rows.map((row, i) => (i === index ? [row[0], event.target.value] : row)))
            }
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${name || 'this variable'}`}
            onClick={() => update(rows.filter((_, i) => i !== index))}
          >
            <RiCloseLine size={14} />
          </button>
        </div>
      ))}
      <div className="env-actions">
        <button type="button" className="button" onClick={() => setRows([...rows, ['', '']])}>
          <RiAddLine size={14} /> Add a variable
        </button>
        {rows.length > 0 && (
          <label className="live-check">
            <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} />
            Show values
          </label>
        )}
      </div>
    </div>
  );
}
