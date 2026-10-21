import { expect, test } from 'vitest';
import { answerTrust, askTrust, useTrust } from '@/project/lib/trust';

const question = { name: 'from a link', env: ['TOKEN'], shared: true, setup: '' };

test('leaving cancels the trust question', async () => {
  const first = new AbortController();
  const pending = askTrust(question, first.signal);
  expect(useTrust.getState().asking).toEqual(question);
  first.abort();
  expect(await pending).toBe(false);
  expect(useTrust.getState().asking).toBeNull();

  const second = new AbortController();
  const next = askTrust({ ...question, name: 'another project' }, second.signal);
  expect(useTrust.getState().asking?.name).toBe('another project');
  answerTrust(true);
  expect(await next).toBe(true);
  second.abort();
  expect(useTrust.getState().asking).toBeNull();
});

test('an answered question’s signal cannot cancel the next question', async () => {
  const first = new AbortController();
  const answered = askTrust(question, first.signal);
  answerTrust(true);
  expect(await answered).toBe(true);

  const second = new AbortController();
  const pending = askTrust({ ...question, name: 'another project' }, second.signal);
  first.abort();
  expect(useTrust.getState().asking?.name).toBe('another project');
  answerTrust(false);
  expect(await pending).toBe(false);
});

test('a cancelled startup cannot open another trust question', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await askTrust(question, controller.signal)).toBe(false);
  expect(useTrust.getState().asking).toBeNull();
});
