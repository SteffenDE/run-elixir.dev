import { useEffect } from 'react';
import { apexUrl } from '@/shared/lib/site';
import { connectTailscale, describe, useTailscale } from '@/tailscale/client';

// Tailscale's mark: a grid of dots.
export function TailscaleIcon({ size = 16 }: { size?: number }) {
  const dots = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => [col, row]));
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {dots.map(([col, row]) => (
        <circle
          key={`${col}${row}`}
          cx={4 + col * 8}
          cy={4 + row * 8}
          r={2.6}
          fill="currentColor"
          opacity={row === 1 || (row === 2 && col === 1) ? 1 : 0.35}
        />
      ))}
    </svg>
  );
}

// The projects' list's Tailscale button: the node's state at a glance, and
// the Tailscale page.
export function TailscaleButton() {
  const status = useTailscale((state) => state.status);
  useEffect(() => void connectTailscale(), []);
  if (!status) return null;
  const { label, tone } = describe(status);
  return (
    <a
      className={`icon-button tailscale-button tailscale-${tone}`}
      href={apexUrl('/tailscale')}
      title={`Tailscale: ${label}`}
      aria-label={`Tailscale: ${label}`}
    >
      <TailscaleIcon />
      <span className="tailscale-dot" />
    </a>
  );
}
