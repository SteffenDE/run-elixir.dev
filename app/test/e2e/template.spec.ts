import { expect, test } from './fixtures';
import { newProject, serverRunning } from './helpers';

// Rewrite the stored project's template, as if an older site had made it.
const madeFrom = (page: import('@playwright/test').Page, id: string, template: object) =>
  page.evaluate(
    ([projectId, made]) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('playground');
        opening.onsuccess = () => {
          const store = opening.result.transaction('projects', 'readwrite').objectStore('projects');
          const read = store.get(projectId as string);
          read.onsuccess = () => {
            store.put({ ...read.result, template: made });
            store.transaction.oncomplete = () => resolve();
          };
        };
        opening.onerror = () => reject(opening.error);
      }),
    [id, template] as const,
  );

test('a project made from an older template says so, until dismissed', async ({ page }) => {
  const id = await newProject(page, 'phoenix');
  await serverRunning(page);
  await expect(page.locator('.template-notice')).toHaveCount(0);
  await madeFrom(page, id, { id: 'older', label: 'phx.new 1.8.0' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const notice = page.locator('.template-notice');
  await expect(notice).toContainText('phx.new 1.8.0');
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await serverRunning(page);
  await expect(page.locator('.template-notice')).toHaveCount(0);
});

test('a link from another template says so before it is opened', async ({ page }) => {
  await page.goto('/');
  const link = await page.evaluate(async () => {
    const shared = {
      v: 1,
      kind: 'phoenix',
      name: 'old one',
      site: '',
      removed: [],
      template: { id: 'older', label: 'phx.new 1.8.0' },
      files: { 'playground/NOTES.md': 'hi\n' },
    };
    const out = new Blob([JSON.stringify(shared)])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(out).arrayBuffer());
    const data = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `/import#${data}`;
  });
  await page.goto(link);
  await expect(page.getByText(/This project used Phoenix template phx\.new 1\.8\.0/)).toBeVisible();
});
