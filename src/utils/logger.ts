/**
 * Logger estructurado para el servidor
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, any>;
  error?: Error;
}

class Logger {
  private formatLog(entry: LogEntry): string {
    const { timestamp, level, message, context, error } = entry;
    const parts = [
      `[${timestamp}]`,
      `[${level.toUpperCase()}]`,
      message,
    ];

    if (context && Object.keys(context).length > 0) {
      parts.push(JSON.stringify(context));
    }

    if (error) {
      parts.push(`\nError: ${error.message}`);
      if (error.stack) {
        parts.push(`\nStack: ${error.stack}`);
      }
    }

    return parts.join(' ');
  }

  private log(level: LogLevel, message: string, context?: Record<string, any>, error?: Error) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
      error,
    };

    const formatted = this.formatLog(entry);

    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'debug':
        if (process.env.NODE_ENV === 'development') {
          console.debug(formatted);
        }
        break;
      default:
        console.log(formatted);
    }
  }

  info(message: string, context?: Record<string, any>) {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, any>) {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error, context?: Record<string, any>) {
    this.log('error', message, context, error);
  }

  debug(message: string, context?: Record<string, any>) {
    this.log('debug', message, context);
  }
}

export const logger = new Logger();

