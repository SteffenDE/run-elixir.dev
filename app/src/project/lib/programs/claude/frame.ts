// The IDE's side of the claude frame (claude.USERCONTENT/claude.html,
// frames/claude.ts): framed once, when a project first runs `claude`, and
// kept; each run gets a port to its worker (worker.ts). The apex holds
// none of Claude Code, and runs none of it.
import { transfer, type Transfer } from '@/shared/lib/rpc';
import { claudeOrigin } from '@/shared/lib/site';
import { unseen } from '@/shared/lib/execFrame';
import { BUILD } from '@/shared/lib/build';

let loading: Promise<{ element: HTMLIFrameElement; origin: string }> | null = null;

function frame(): Promise<{ element: HTMLIFrameElement; origin: string }> {
  loading ??= new Promise<{ element: HTMLIFrameElement; origin: string }>((resolve, reject) => {
    const origin = claudeOrigin();
    if (!origin) {
      reject(new Error('this site names no usercontent domain (docs/frames.md)'));
      return;
    }
    // Unseen, as the exec frame (a hidden frame's workers are slowed in WebKit).
    const element = unseen(document.createElement('iframe'));
    element.src = `${origin}${BUILD}claude.html`;
    const timer = setTimeout(() => {
      removeEventListener('message', loaded);
      element.remove();
      reject(new Error(`${origin}: the claude frame did not start`));
    }, 30000);
    const loaded = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== element.contentWindow) return;
      if (event.data?.kind !== 'playground-claude-loaded') return;
      removeEventListener('message', loaded);
      clearTimeout(timer);
      resolve({ element, origin });
    };
    addEventListener('message', loaded);
    document.body.append(element);
  }).catch((error: Error) => {
    loading = null;
    throw error;
  });
  return loading;
}

// A port to the claude frame's worker, for the exec frame's `claude`.
export async function claudePort(): Promise<Transfer<MessagePort>> {
  const { element, origin } = await frame();
  const channel = new MessageChannel();
  element.contentWindow!.postMessage({ kind: 'playground-claude' }, origin, [channel.port2]);
  return transfer(channel.port1, [channel.port1]);
}
