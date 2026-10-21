import { expect, test } from './fixtures';
import { APEX, newProject, newShell, output, prompted, run, signIn, writeText } from './helpers';

// A scripted Messages API on the project's port 3456: a Bash tool call, a
// Write, a Grep, then a final text saying what Bash and Grep answered.
const MOCK = `// A scripted Messages API: Bash, Write, Grep, then what Bash and Grep said.
const http = require('http');
let n = 0;
const said = (body, id) => {
  const result = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.tool_use_id === id);
  return JSON.stringify(result?.content ?? null);
};
const blocks = (body) => {
  const results = JSON.stringify(body.messages).match(/tool_result/g)?.length ?? 0;
  if (!body.tools?.length) return { stop: 'end_turn', content: [{ type: 'text', text: 'title' }] };
  if (results === 0) return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo from-bash $((6*7)) > /work/bash.txt && cat /work/bash.txt && node -e "console.log(process.version)"', description: 'test' } }] };
  if (results === 1) return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: '/work/written.txt', content: 'written by the Write tool\\n' } }] };
  if (results === 2) return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Grep', input: { pattern: 'written by', path: '/work', output_mode: 'content' } }] };
  return { stop: 'end_turn', content: [{ type: 'text', text: 'BASH SAID: ' + said(body, 'toolu_1') + ' GREP SAID: ' + said(body, 'toolu_3') }] };
};
http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const body = JSON.parse(data || '{}');
    const { stop, content } = blocks(body);
    const message = { id: 'msg_' + ++n, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(message));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, d) => res.write(\`event: \${type}\\ndata: \${JSON.stringify({ type, ...d })}\\n\\n\`);
    ev('message_start', { message: { ...message, content: [], stop_reason: null } });
    content.forEach((b, index) => {
      if (b.type === 'text') {
        ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
      } else {
        ev('content_block_start', { index, content_block: { ...b, input: {} } });
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      ev('content_block_stop', { index });
    });
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
    ev('message_stop', {});
    res.end();
  });
}).listen(3456, () => console.log('mock listening'));
`;

// `claude`: Claude Code's JavaScript, read out of its npm package's Bun
// executable on the first run (some 125 MB from the registry) by the claude
// frame, kept there for every project, and run on the page's Node. A mock
// of Anthropic's API answers it here, so its tools run without a key.
test('claude runs Claude Code: its tools, against a mock API', async ({ page }) => {
  test.setTimeout(600_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  const first = await run(page, 'claude --version');
  expect(first).toContain('2.1.306 (Claude Code)');
  const again = await run(page, 'claude --version');
  expect(again).not.toContain('downloading');
  expect(again).toContain('2.1.306 (Claude Code)');

  // Another project: the claude frame's files, made once for every
  // project, so no download.
  const other = await page.context().newPage();
  await newProject(other, 'empty');
  await prompted(other, 1);
  const shared = await run(other, 'claude --version');
  expect(shared).not.toContain('downloading');
  expect(shared).toContain('2.1.306 (Claude Code)');
  await other.close();

  await writeText(page, '/work/mock.cjs', MOCK);
  const mock = await newShell(page);
  await page.evaluate(
    (id) => window.playground.sessions.get(id).node.input('node mock.cjs\n'),
    mock,
  );
  await expect.poll(() => output(page, mock), { timeout: 60_000 }).toContain('mock listening');
  const agent = await run(
    page,
    'ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=sk-ant-none claude -p "do it" --dangerously-skip-permissions; echo "status $?"; cat bash.txt written.txt',
  );
  // What the Bash and Grep tools said reached the model.
  expect(agent).toMatch(/BASH SAID: .*from-bash 42.*v24/);
  expect(agent).toMatch(/GREP SAID: .*written\.txt.*written by the Write tool/);
  expect(agent).toContain('status 0');
  expect(agent).toContain('from-bash 42');
  expect(agent).toContain('written by the Write tool');

  // Interactive: its terminal UI draws (Bun.ant.CellSegmenter's stand-in);
  // without the tailnet, its connectivity check then fails, as it should.
  const tui = await newShell(page);
  await page.evaluate(
    (id) =>
      window.playground.sessions
        .get(id)
        .node.input(
          'ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=sk-ant-none claude\n',
        ),
    tui,
  );
  await expect
    .poll(() => output(page, tui), { timeout: 120_000 })
    .toMatch(/Welcome to Claude Code|Error:/);
  expect(await output(page, tui)).not.toMatch(/Error:|could not start/);
});

// Interactive, through a tailnet's exit node (tests/headscale.sh): Claude
// Code's own TLS reaches Anthropic's endpoints that send no CORS headers,
// so its start's connectivity check passes and its onboarding asks.
test('claude starts interactively through the tailnet', async ({ page, context, browserName }) => {
  test.skip(!process.env.HEADSCALE_URL, 'needs HEADSCALE_URL and HEADSCALE_API_KEY');
  test.skip(browserName !== 'chromium', 'Chromium only');
  test.setTimeout(600_000);
  await signIn(page, context, APEX);
  const project = await context.newPage();
  await project.goto(`${APEX}/empty`);
  await project.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(project, 1);
  await project.evaluate(() =>
    window.playground.sessions.get(1).node.input('ANTHROPIC_API_KEY=sk-ant-none claude\n'),
  );
  const consent = project.getByRole('dialog', { name: /use your tailnet\?$/ });
  await expect(consent).toBeVisible({ timeout: 180_000 });
  await consent.getByRole('button', { name: 'Allow' }).click();
  await expect
    .poll(() => output(project), { timeout: 120_000 })
    .toMatch(/text style|Unable to connect|Error:/i);
  const screen = await output(project);
  expect(screen).not.toMatch(/Unable to connect|Error:/);
  expect(screen).toMatch(/text style/i);
});
