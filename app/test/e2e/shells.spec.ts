import { expect, test } from './fixtures';
import { newProject, newShell, preview, run, serverRunning } from './helpers';

test('a second shell generates a LiveView while the server runs @slow', async ({ page }) => {
  test.setTimeout(1_800_000);
  await newProject(page, 'phoenix');
  await serverRunning(page);
  const shell = await newShell(page);
  await run(page, 'mix phx.gen.live Blog Post posts title:string body:text', shell);
  const routes = [
    'live "/posts", PostLive.Index, :index',
    'live "/posts/new", PostLive.Form, :new',
    'live "/posts/:id", PostLive.Show, :show',
    'live "/posts/:id/edit", PostLive.Form, :edit',
  ].join('\\n    ');
  await run(
    page,
    `elixir -e 'p = "lib/playground_web/router.ex"; File.write!(p, String.replace(File.read!(p), ~s(get "/", PageController, :home), ~s(get "/", PageController, :home\\n    ${routes}), global: false))'`,
    shell,
  );
  await run(page, 'mix ecto.migrate', shell);
  await page.locator('.preview-bar input').fill('/posts/new');
  await page.locator('.preview-bar input').press('Enter');
  const frame = preview(page);
  await expect(frame.locator('#post-form')).toBeVisible({ timeout: 600_000 });
  await page.waitForTimeout(3000);
  await frame.locator('#post_title').fill('Hello from a second shell');
  await frame.locator('#post_body').fill('Generated while the server ran.');
  await frame.locator('#post-form button').last().click();
  await expect(frame.getByText('Hello from a second shell').first()).toBeVisible({
    timeout: 120_000,
  });
});
