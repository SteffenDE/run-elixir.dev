import { expect, test } from './fixtures';
import { newProject, prompted, seesInPreview, writeText } from './helpers';

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
    card: new URL(
      document.querySelector<HTMLMetaElement>('meta[property="og:image"]')!.content,
      location.href,
    ).href,
  }));
  const manifest = await (await request.get(head.manifest)).json();
  expect(manifest).toMatchObject({ display: 'standalone', scope: '/' });
  // At the site's root, as named (a path that is no file gets the page).
  const images = [
    ...head.icons,
    head.card,
    ...manifest.icons.map((icon: { src: string }) => new URL(icon.src, head.manifest).href),
  ];
  expect(head.icons).toHaveLength(3);
  for (const url of images) {
    const response = await request.get(url);
    expect(response.ok(), url).toBe(true);
    expect(response.headers()['content-type'], url).toMatch(/^image\//);
  }
  // No rubber-banding under the terminal's swipes.
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY),
  ).toBe('none');
});

test('a home-screen app has a strip of the top bar’s colour along the top edge', async ({
  page,
}) => {
  // Playwright does not emulate display-mode: the standalone rules are made
  // to apply in any display.
  const standalone = () =>
    page.evaluate(() => {
      for (const sheet of document.styleSheets)
        for (const rule of sheet.cssRules)
          if (rule instanceof CSSMediaRule && rule.conditionText === '(display-mode: standalone)')
            rule.media.mediaText = 'all';
    });
  // What WebKit looks for (styles.css): a fixed box 4 to 6 px down, as wide
  // as the viewport, with a background.
  const edge = () =>
    page.evaluate(() => {
      const strip = document.querySelector('.top-edge')!;
      const box = strip.getBoundingClientRect();
      return {
        position: getComputedStyle(strip).position,
        top: box.top,
        wide: box.width === document.documentElement.clientWidth,
        height: box.height,
        colour: getComputedStyle(strip).backgroundColor,
      };
    });

  await page.goto('/');
  await expect(page.getByRole('link', { name: /Phoenix project/ })).toBeVisible();
  await standalone();
  expect(await edge()).toEqual({
    position: 'fixed',
    top: 0,
    wide: true,
    height: 6,
    colour: await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  });

  await newProject(page, 'empty');
  await prompted(page, 1);
  await standalone();
  const bar = page.locator('.top-bar');
  expect(await edge()).toMatchObject({
    top: 0,
    wide: true,
    height: 6,
    colour: await bar.evaluate((e) => getComputedStyle(e).backgroundColor),
  });
  // It covers the top bar's padding, not its buttons.
  const tops = await bar.evaluate((e) =>
    [...e.children]
      .map((child) => child.getBoundingClientRect())
      .filter((box) => box.width > 0)
      .map((box) => box.top),
  );
  expect(Math.min(...tops)).toBeGreaterThanOrEqual(6);
});

test('the installed app does not zoom; a tab does', async ({ page }) => {
  const viewport = () =>
    page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name=viewport]')!.content);
  await page.goto('/');
  // Not iOS: a tab keeps its viewport (Android's tabs would stop pinching).
  expect(await viewport()).not.toContain('maximum-scale');

  // Playwright does not emulate display-mode: the page is told it is installed.
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      query === '(display-mode: standalone)'
        ? ({ ...matchMedia('all'), matches: true, media: query } as MediaQueryList)
        : matchMedia(query);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await viewport()).toContain('maximum-scale=1, user-scalable=no');
});

test('a Phoenix project on a phone opens on its preview', async ({ page }) => {
  await newProject(page, 'phoenix');
  const bar = page.getByRole('navigation', { name: 'Panes' });
  await expect(bar.getByRole('button', { name: 'Preview' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await seesInPreview(page, 'Peace of mind', 180_000);
  expect(await overflows(page)).toBe(false);
  await page.screenshot({ path: '/repo/target/tests/phone-preview.png' });
});
