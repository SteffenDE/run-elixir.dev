// The platform's modifier: ⌘ on Apple systems, Ctrl elsewhere.
export function isMacOS(): boolean {
  return /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform);
}

export function isModifierKeyPressed(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacOS() ? event.metaKey : event.ctrlKey;
}

export const modifierKey = (): string => (isMacOS() ? '⌘' : 'Ctrl');
