import { createLogger } from '../logger.js';

const log = createLogger('telegram');

export interface CommandHandlers {
  status(): Promise<string> | string;
  positions(): Promise<string> | string;
  pause(): Promise<string> | string;
  resume(): Promise<string> | string;
  scan(): Promise<string> | string;
  close(target: string, pct: number): Promise<string> | string;
  stop(): Promise<string> | string;
  start(): Promise<string> | string;
}

export const HELP_TEXT = [
  '/status - balance, PnL, regime, open count',
  '/positions - open positions with live gain',
  '/pause - stop opening new positions (exits still managed)',
  '/resume - allow entries again (also clears a daily-loss halt)',
  '/scan - run the scanner now',
  '/close SYMBOL [pct] - sell a position (default 100%)',
  '/stop - stop the trading loop',
  '/start - start the trading loop',
].join('\n');

/** Parse one Telegram message into a handler call. Pure, so it is unit-testable. */
export async function handleCommand(text: string, h: CommandHandlers): Promise<string | undefined> {
  const m = text.trim().match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/);
  if (!m) return undefined;
  const cmd = m[1].toLowerCase();
  const args = (m[2] ?? '').trim().split(/\s+/).filter(Boolean);
  switch (cmd) {
    case 'help':
      return HELP_TEXT;
    case 'status':
      return h.status();
    case 'positions':
      return h.positions();
    case 'pause':
      return h.pause();
    case 'resume':
      return h.resume();
    case 'scan':
      return h.scan();
    case 'stop':
      return h.stop();
    case 'start':
      return h.start();
    case 'close': {
      if (!args[0]) return 'Usage: /close SYMBOL [pct]';
      const pct = args[1] ? Number(args[1]) : 100;
      if (!(pct > 0 && pct <= 100)) return 'pct must be between 1 and 100';
      return h.close(args[0], pct);
    }
    default:
      return `Unknown command /${cmd}\n${HELP_TEXT}`;
  }
}

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id: number | string }; from?: { id: number } };
}

/**
 * Long-polls Telegram for commands from the configured chat only. Messages from any
 * other chat are ignored, so nobody else can drive the bot even if they find it.
 */
export class TelegramCommandLoop {
  private running = false;
  private offset = 0;

  constructor(
    private token: string,
    private chatId: string,
    private handlers: CommandHandlers,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
    log.info('telegram commands enabled (send /help to the bot)');
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      try {
        const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/getUpdates?timeout=25&offset=${this.offset}&allowed_updates=%5B%22message%22%5D`);
        const json = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
        for (const u of json.result ?? []) {
          this.offset = u.update_id + 1;
          const chat = String(u.message?.chat?.id ?? '');
          const text = u.message?.text;
          if (!text || chat !== this.chatId) continue;
          const reply = await handleCommand(text, this.handlers).catch((e) => `error: ${(e as Error).message}`);
          if (reply) await this.send(reply);
        }
      } catch (e) {
        log.debug('telegram poll error:', (e as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async send(text: string) {
    await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    }).catch(() => undefined);
  }
}
