import { createLogger, format, transports } from 'winston';
import Transport from 'winston-transport';

let currentLevel = process.env.LOG_LEVEL ?? 'info';

/**
 * Global Telegram hook for `logger.error(...)` calls.
 *
 * The hook is stored module-locally and invoked by {@link TelegramTransport} for
 * every error-level log line. Wiring it up decouples Telegram alerting from the
 * logging call sites: a single `setLoggerTelegramHook(...)` call in index.ts makes
 * every `logger.error(...)` in the codebase reach the operator.
 */
let telegramHook: ((msg: string) => void) | null = null;

export function setLoggerTelegramHook(fn: (msg: string) => void): void {
  telegramHook = fn;
}

interface TelegramLogInfo {
  level?: string;
  message?: unknown;
}

/**
 * Winston transport that forwards error-level logs to the globally registered
 * Telegram hook.
 *
 * Infinite-loop protection: any log line that mentions Telegram/Telegraf is
 * filtered out, because the delivery layer itself logs errors via `logger.error`
 * (e.g. "Failed to send Telegram message"). Without this filter a Telegram
 * outage would recursively re-send its own failure to Telegram forever.
 */
export class TelegramTransport extends Transport {
  override log(info: TelegramLogInfo, callback: () => void): void {
    setImmediate(() => this.emit('logged', info));
    callback();

    if (info.level !== 'error' || !telegramHook) return;

    const message = typeof info.message === 'string' ? info.message : String(info.message ?? '');
    const lower = message.toLowerCase();
    if (lower.includes('telegram') || lower.includes('telegraf')) return;

    try {
      telegramHook(message);
    } catch {
      // The hook must never break the logging pipeline.
    }
  }
}

function getLevel(): string {
  return process.env.LOG_LEVEL ?? currentLevel;
}

export const logger = createLogger({
  level: getLevel(),
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf((info) => {
      const stack = info.stack ? `\n${String(info.stack)}` : '';
      return `${String(info.timestamp)} [${String(info.level).toUpperCase()}] ${String(info.message)}${stack}`;
    }),
  ),
  transports: [new transports.Console(), new TelegramTransport()],
});

export function setLogLevel(level: string): void {
  currentLevel = level;
  logger.level = level;
}
