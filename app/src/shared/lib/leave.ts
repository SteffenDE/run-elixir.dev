// A page with frames of the usercontent domain (an exec frame, relays, the
// preview) drops them as it is left: in Firefox (Playwright's at least), a
// cross-origin isolated page does not finish leaving while a frame of
// another site is in it (docs/frames.md). Back from the back-forward
// cache without them, it loads again.
export function dropFramesOnLeave(): void {
  addEventListener('pagehide', () => {
    for (const frame of document.querySelectorAll('iframe')) frame.remove();
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
}
