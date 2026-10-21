import { expect, test } from './fixtures';
import {
  APP,
  newProject,
  newShell,
  NO_FRAME_IN_FIREFOX,
  preview,
  reloadPreview,
  run,
  serverRunning,
  syncLV,
} from './helpers';

// phx.gen.auth end to end: the generator (which loads the app's Mailer,
// whose Swoosh on_load used to stop it), pbkdf2 from Hex (bcrypt is a NIF),
// the migration, and a registration in the preview.
test('phx.gen.auth generates, migrates and registers a user @slow', async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'firefox', NO_FRAME_IN_FIREFOX);
  test.setTimeout(1_800_000);
  await newProject(page, 'phoenix');
  await serverRunning(page);
  const shell = await newShell(page);
  await run(page, `cd ${APP}`, shell);
  const generated = await run(
    page,
    'mix phx.gen.auth Accounts User users --hashing-lib pbkdf2 --live',
    shell,
  );
  expect(generated).toContain('creating lib/playground/accounts/user.ex');
  expect(generated).not.toMatch(/\*\* \(|notsup/);
  const fetched = await run(page, 'mix deps.get', shell);
  expect(fetched).toMatch(/pbkdf2_elixir/);
  const compiled = await run(page, 'mix compile', shell);
  expect(compiled).toMatch(/Generated playground app/);
  const migrated = await run(page, 'mix ecto.migrate', shell);
  expect(migrated).toMatch(/create table users|users_tokens/);

  // New dependencies: the server starts again with them.
  await page.getByRole('button', { name: /Restart server/ }).click();
  await page.waitForFunction(
    () => (window.playground.output.match(/Running PlaygroundWeb.Endpoint/g) ?? []).length >= 2,
    null,
    { timeout: 900_000 },
  );
  await page.locator('.preview-bar input').fill('/users/register');
  await page.locator('.preview-bar input').press('Enter');
  const frame = preview(page);
  await expect(frame.locator('#registration_form')).toBeVisible({ timeout: 300_000 });
  await syncLV(frame);
  const events: string[] = [];
  page.on('response', (response) => {
    if (/longpoll|users/.test(response.url()))
      events.push(
        `${response.request().method()} ${new URL(response.url()).pathname}${new URL(response.url()).search.slice(0, 40)} -> ${response.status()}`,
      );
  });
  page.on('framenavigated', (navigated) => events.push(`navigated ${navigated.url()}`));
  page.on('console', (message) =>
    events.push(`console ${message.type()}: ${message.text().slice(0, 200)}`),
  );
  await frame.locator('#registration_form input[type=email]').fill('ada@example.com');
  await syncLV(frame);
  await frame.locator('#registration_form button').click();
  await syncLV(frame);
  // LiveView ran over the bridge's WebSocket, not long polling.
  expect(await page.evaluate(() => /Transport: :websocket/.test(window.playground.output))).toBe(
    true,
  );
  await expect(frame.getByText(/ada@example.com/).first())
    .toBeVisible({ timeout: 120_000 })
    .catch(async (error) => {
      console.log('EVENTS>>>\n' + events.join('\n'));
      throw error;
    });
  const rows = await page.evaluate(() =>
    window.playground
      .database()
      .then((db: { query(sql: string): Promise<{ rows: { email: string }[] }> }) =>
        db.query('select email from users'),
      )
      .then((result: { rows: { email: string }[] }) => result.rows),
  );
  expect(rows).toEqual([{ email: 'ada@example.com' }]);
  await reloadPreview(page);
});
