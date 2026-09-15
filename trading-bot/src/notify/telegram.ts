import { createLogger } from '../logger.js';

const log = createLogger('telegram');

export class Notifier {
  constructor(private token?: string, private chatId?: string) {}

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      if (!res.ok) log.warn(`telegram send failed: ${res.status} ${await res.text()}`);
    } catch (e) {
      log.warn('telegram send error:', (e as Error).message);
    }
  }
}
