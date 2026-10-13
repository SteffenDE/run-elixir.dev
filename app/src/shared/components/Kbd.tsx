import { modifierKey } from '@/shared/lib/keys';

// A key, as on the keyboard; a shortcut is several.
export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>;
}

// The platform's modifier with `key` (⌘ S, Ctrl S).
export function Shortcut({ keyName }: { keyName: string }) {
  return (
    <span className="kbd-group">
      <Kbd>{modifierKey()}</Kbd>
      <Kbd>{keyName}</Kbd>
    </span>
  );
}
