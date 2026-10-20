// Who answers the docked preview (Preview.tsx): its relay for a port, made
// ready (PreviewFrame's prepare), and a port it went to by itself
// (onPort). A project's page (playground.ts) or a live session's guest
// (live/lib/guest.ts) says.
export interface PreviewHost {
  ready(port: number): Promise<void>;
  shows(port: number): void;
}

let current: PreviewHost = { ready: () => Promise.resolve(), shows: () => {} };

export function setPreviewHost(host: PreviewHost): void {
  current = host;
}

export const previewReady = (port: number) => current.ready(port);
export const previewShows = (port: number) => current.shows(port);
