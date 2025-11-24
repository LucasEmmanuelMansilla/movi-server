import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { StatusCodes } from 'http-status-codes';

import { authRouter } from './routes/auth';
import { shipmentRouter } from './routes/shipments';
import { pushRouter } from './routes/push';
import { profileRouter } from './routes/profile';
import { authMiddleware } from './middleware/auth';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);

// Middleware
app.use(express.json());
app.use(cors({ origin: true }));
app.use(helmet());
app.use(morgan('dev'));

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(StatusCodes.OK).json({ status: 'ok', service: 'movi-server' });
});

// Routes
app.use('/auth', authRouter);
app.use('/shipments', authMiddleware, shipmentRouter);
app.use('/push', authMiddleware, pushRouter);
app.use('/profile', authMiddleware, profileRouter);

// Error handling middleware
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err);
  res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(StatusCodes.NOT_FOUND).json({ error: 'Not Found' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${port}`);
});
