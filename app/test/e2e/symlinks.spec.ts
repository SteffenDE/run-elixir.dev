import { expect, test } from './fixtures';
import { APP, exists, newProject, newShell, output, prompted, run, serverRunning } from './helpers';

test('symbolic links name files and directories, and are kept', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(
    page,
    `elixir -e 'File.mkdir_p!("tree"); File.write!("tree/a.txt", "through"); ` +
      `:ok = File.ln_s("tree", "dir_link"); :ok = File.ln_s("tree/a.txt", "file_link")'`,
  );
  const seen = await run(
    page,
    `elixir -e 'IO.inspect({File.read!("dir_link/a.txt"), File.read!("file_link"), ` +
      `File.ls!("dir_link"), File.read_link("dir_link"), File.lstat!("dir_link").type, ` +
      `File.stat!("dir_link").type, File.dir?("dir_link")}); ` +
      `File.write!("dir_link/b.txt", "written"); IO.inspect(File.read!("tree/b.txt"))'`,
  );
  expect(seen).toContain(
    '{"through", "through", ["a.txt"], {:ok, "tree"}, :symlink, :directory, true}',
  );
  expect(seen).toContain('"written"');
  // Removing a link leaves what it names.
  await run(page, 'rm file_link');
  expect(await exists(page, '/work/file_link')).toBe(false);
  expect(await exists(page, '/work/tree/a.txt')).toBe(true);
  // The link sorts before what it names, as a build's priv link does, and a
  // file written through it is kept where it is.
  await page.evaluate(() => window.playground.files.flush());
  await page.reload();
  await prompted(page, 1);
  expect(
    await run(
      page,
      `elixir -e 'IO.inspect({File.read_link("dir_link"), File.read!("dir_link/a.txt"), File.read!("tree/b.txt")})'`,
    ),
  ).toContain('{{:ok, "tree"}, "through", "written"}');
});

test("a Phoenix project's build links its priv, and Phoenix does not warn", async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  // Phoenix's code reloader and LiveView's colocated assets both link.
  expect(await output(page)).not.toContain('unable to create symlinks');
  expect(await output(page)).not.toContain('Failed to symlink');
  const shell = await newShell(page);
  await run(page, `cd ${APP}`, shell);
  expect(
    await run(
      page,
      `elixir -e 'IO.inspect(File.read_link("_build/dev/lib/playground/priv"))'`,
      shell,
    ),
  ).toMatch(/\{:ok, "[./]*priv"\}/);
});
