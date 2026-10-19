import { expect, test } from './fixtures';
import { newProject, preview, prompted, writeText } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

// Whether the page scrolls sideways (it should not).
const overflows = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

test('the home page fits a phone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Phoenix project/ })).toBeVisible();
  expect(await overflows(page)).toBe(false);
  await page.screenshot({ path: '/repo/target/tests/phone-home.png' });
});

test('a project on a phone shows one pane at a time', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  const bar = page.getByRole('navigation', { name: 'Panes' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Terminal' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.terminal-host:not([hidden])')).toBeVisible();
  expect(await overflows(page)).toBe(false);
  const header = await page.locator('.top-bar').evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
  expect(header).toBe(true);
  await page.screenshot({ path: '/repo/target/tests/phone-terminal.png' });

  await writeText(page, '/work/hello.ex', 'IO.puts("hello")\n');
  await bar.getByRole('button', { name: 'Files' }).click();
  await page.getByRole('treeitem', { name: 'hello.ex', exact: true }).click();
  // Opening a file shows the editor.
  await expect(bar.getByRole('button', { name: 'Editor' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tab', { hasText: 'hello.ex' })).toBeVisible();
  expect(await overflows(page)).toBe(false);
  await page.screenshot({ path: '/repo/target/tests/phone-editor.png' });
});

test('the page installs on a home screen', async ({ page, request }) => {
  await page.goto('/');
  const head = await page.evaluate(() => ({
    manifest: document.querySelector<HTMLLinkElement>('link[rel=manifest]')!.href,
    icons: [
      ...document.querySelectorAll<HTMLLinkElement>('link[rel=icon], link[rel=apple-touch-icon]'),
    ].map((l) => l.href),
  }));
  const manifest = await (await request.get(head.manifest)).json();
  expect(manifest).toMatchObject({ display: 'standalone', scope: '/' });
  // At the site's root, as named (a path that is no file gets the page).
  const images = [
    ...head.icons,
    ...manifest.icons.map((icon: { src: string }) => new URL(icon.src, head.manifest).href),
  ];
  expect(head.icons).toHaveLength(3);
  for (const url of images) {
    const response = await request.get(url);
    expect(response.ok(), url).toBe(true);
    expect(response.headers()['content-type'], url).toMatch(/^image\//);
  }
});

test('a Phoenix project on a phone opens on its preview', async ({ page }) => {
  await newProject(page, 'phoenix');
  const bar = page.getByRole('navigation', { name: 'Panes' });
  await expect(bar.getByRole('button', { name: 'Preview' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 180_000 });
  expect(await overflows(page)).toBe(false);
  await page.screenshot({ path: '/repo/target/tests/phone-preview.png' });
});
