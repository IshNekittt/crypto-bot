import { createLogger, format, transports } from 'winston';

let currentLevel = process.env.LOG_LEVEL ?? 'info';

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
  transports: [new transports.Console()],
});

export function setLogLevel(level: string): void {
  currentLevel = level;
  logger.level = level;
}