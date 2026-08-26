import { createLogger, format, transports } from 'winston';

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
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
