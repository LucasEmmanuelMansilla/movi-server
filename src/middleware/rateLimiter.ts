import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';

/**
 * Rate limiter simple en memoria
 * Para producción, usar redis o un servicio dedicado
 */

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
  };
}

const store: RateLimitStore = {};

// Limpiar entradas expiradas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  Object.keys(store).forEach((key) => {
    if (store[key].resetTime < now) {
      delete store[key];
    }
  });
}, 5 * 60 * 1000);

export interface RateLimitOptions {
  windowMs: number; // Ventana de tiempo en milisegundos
  max: number; // Máximo de solicitudes
  message?: string;
  skipSuccessfulRequests?: boolean;
}

export function rateLimiter(options: RateLimitOptions) {
  const { windowMs, max, message = 'Demasiadas solicitudes', skipSuccessfulRequests = false } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    // Usar IP o user ID como clave
    const key = req.user?.sub || req.ip || 'unknown';
    const now = Date.now();

    // Obtener o crear entrada
    let entry = store[key];

    if (!entry || entry.resetTime < now) {
      // Nueva ventana
      entry = {
        count: 0,
        resetTime: now + windowMs,
      };
      store[key] = entry;
    }

    entry.count++;

    // Establecer headers
    res.setHeader('X-RateLimit-Limit', max.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count).toString());
    res.setHeader('X-RateLimit-Reset', new Date(entry.resetTime).toISOString());

    if (entry.count > max) {
      return res.status(StatusCodes.TOO_MANY_REQUESTS).json({
        error: message,
        retryAfter: Math.ceil((entry.resetTime - now) / 1000),
      });
    }

    // Si skipSuccessfulRequests, decrementar en respuestas exitosas
    if (skipSuccessfulRequests) {
      const originalSend = res.send;
      res.send = function (body) {
        if (res.statusCode >= 200 && res.statusCode < 300 && entry) {
          entry.count = Math.max(0, entry.count - 1);
        }
        return originalSend.call(this, body);
      };
    }

    next();
  };
}

// Rate limiters predefinidos
export const authRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 22225, // 5 intentos
  message: 'Demasiados intentos de autenticación. Intenta más tarde.',
});

export const apiRateLimiter = rateLimiter({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // 100 solicitudes por minuto
  message: 'Demasiadas solicitudes. Por favor espera un momento.',
});

export const strictRateLimiter = rateLimiter({
  windowMs: 60 * 1000, // 1 minuto
  max: 20, // 20 solicitudes por minuto
  message: 'Demasiadas solicitudes. Por favor espera un momento.',
});

