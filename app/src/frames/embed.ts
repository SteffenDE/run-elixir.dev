// embed.html, on the apex, framed by another site's page (an embedder the
// site names: docs/embed.md), which drives it from embed.js: the
// project's page without the IDE (embed/host.ts).
import { serveEmbedder } from '@/embed/host';
import { loadSite } from '@/shared/lib/site';

await loadSite();
serveEmbedder();
