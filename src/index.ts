import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { StatusCodes } from 'http-status-codes';

import { authRouter } from './routes/auth';
import { shipmentRouter } from './routes/shipments';
import { pushRouter } from './routes/push';
import { chatRouter } from './routes/chat';
import { profileRouter } from './routes/profile';
import { paymentRouter } from './routes/payments';
import { driverTransfersRouter } from './routes/driver-transfers';
// import { mercadoPagoOAuthRouter } from './routes/mercadopago-oauth'; // Deshabilitado - Marketplace removido
import { withdrawalRequestsRouter } from './routes/withdrawal-requests';
import { authMiddleware } from './middleware/auth';
import { apiRateLimiter, authRateLimiter } from './middleware/rateLimiter';
import { logger } from './utils/logger';
import { env } from './env';
import { kycRouter } from './routes/kyc';

dotenv.config();

const app = express();
const port = Number(env.PORT);

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
app.use(cors({
  origin: (origin, callback) => {
    if (allowedOrigins.includes('*') || !origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

app.get('/health', (_req: Request, res: Response) => {
  res.status(StatusCodes.OK).json({ 
    status: 'ok', 
    service: 'movi-server',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Routes con rate limiting
app.use('/auth', authRateLimiter, authRouter);
app.use('/shipments', apiRateLimiter, authMiddleware, shipmentRouter);
app.use('/push', apiRateLimiter, authMiddleware, pushRouter);
app.use('/chat', apiRateLimiter, authMiddleware, chatRouter);
app.use('/profile', apiRateLimiter, authMiddleware, profileRouter);
app.use('/payments', apiRateLimiter, paymentRouter);
app.use('/driver-transfers', apiRateLimiter, authMiddleware, driverTransfersRouter);
app.use('/withdrawal-requests', apiRateLimiter, authMiddleware, withdrawalRequestsRouter);
// app.use('/mp', apiRateLimiter, mercadoPagoOAuthRouter); // Deshabilitado - Marketplace removido
app.use('/kyc', apiRateLimiter, kycRouter)

app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Error no manejado', err, {
    path: req.path,
    method: req.method,
    ip: req.ip,
  });

  if (err.name === 'ZodError') {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Datos inválidos',
      details: err.errors,
    });
  }

  if (err.message === 'Not allowed by CORS') {
    return res.status(StatusCodes.FORBIDDEN).json({
      error: 'Origen no permitido',
    });
  }

  // Error genérico
  res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
    error: 'Error interno del servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(StatusCodes.NOT_FOUND).json({ 
    error: 'Ruta no encontrada',
    path: _req.path,
  });
});

// Manejo de errores no capturados
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', reason as Error, { promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
  process.exit(1);
});

app.listen(port, '0.0.0.0', () => {
  logger.info(`Servidor iniciado en http://localhost:${port}`, {
    env: process.env.NODE_ENV,
    port,
  });
});
