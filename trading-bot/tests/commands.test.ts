import { describe, expect, it, vi } from 'vitest';
import { handleCommand, TelegramCommandLoop, type CommandHandlers } from '../src/notify/commands.js';

const h = (): CommandHandlers => ({
  status: vi.fn(() => 'status-ok'),
  positions: vi.fn(() => 'pos'),
  pause: vi.fn(() => 'paused'),
  resume: vi.fn(() => 'resumed'),
  scan: vi.fn(() => 'scanning'),
  close: vi.fn((t: string, p: number) => `closing ${t} ${p}`),
  stop: vi.fn(() => 'stopped'),
  start: vi.fn(() => 'started'),
});

describe('telegram commands', () => {
  it('routes commands and validates arguments', async () => {
    const hs = h();
    expect(await handleCommand('/status', hs)).toBe('status-ok');
    expect(await handleCommand('/close BONK 50', hs)).toBe('closing BONK 50');
    expect(await handleCommand('/close BONK', hs)).toBe('closing BONK 100');
    expect(await handleCommand('/close', hs)).toMatch(/Usage/);
    expect(await handleCommand('/close X 500', hs)).toMatch(/between/);
    expect(await handleCommand('/pause@mybot', hs)).toBe('paused');
    expect(await handleCommand('hello', hs)).toBeUndefined();
    expect(await handleCommand('/nope', hs)).toMatch(/Unknown/);
  });

  it('only accepts messages from the configured chat', async () => {
    const hs = h();
    const sent: string[] = [];
    let calls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('sendMessage')) {
        sent.push(JSON.parse(String(init?.body)).text);
        return new Response('{}');
      }
      calls++;
      const result = calls === 1 ? [{ update_id: 1, message: { text: '/status', chat: { id: 999 } } }, { update_id: 2, message: { text: '/status', chat: { id: 42 } } }] : [];
      if (calls > 1) await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ ok: true, result }));
    }) as unknown as typeof fetch;
    const loop = new TelegramCommandLoop('t', '42', hs, fetchImpl);
    loop.start();
    await new Promise((r) => setTimeout(r, 60));
    loop.stop();
    expect(hs.status).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['status-ok']);
  });
});
