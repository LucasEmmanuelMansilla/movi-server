import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { createAdminClient } from '../lib/supabase';
import { logger } from '../utils/logger';

/**
 * Middleware para requerir validación KYC aprobada
 * Solo aplica a usuarios con rol 'driver'
 * Los usuarios 'business' pueden pasar sin validación
 */
export const requireKYCValidation = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const user = req.user as { sub: string } | undefined;
  
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const admin = createAdminClient();
    
    const { data: profile, error } = await admin
      .from('profiles')
      .select('role, kyc_status')
      .eq('id', user.sub)
      .maybeSingle();

    if (error) {
      logger.error('Error verificando KYC en middleware', error as Error, {
        userId: user.sub,
      });
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to verify KYC status',
      });
      return;
    }

    if (!profile) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Profile not found' });
      return;
    }

    // Los usuarios business no requieren KYC
    if (profile.role !== 'driver') {
      return next();
    }

    // Si kyc_status es NULL, es un usuario existente (grandfather clause)
    // Permitir acceso para usuarios existentes
    if (profile.kyc_status === null) {
      return next();
    }

    // Para nuevos usuarios driver, requerir KYC aprobado
    if (profile.kyc_status !== 'approved') {
      res.status(StatusCodes.FORBIDDEN).json({
        error: 'KYC validation required',
        message: 'You must complete identity verification before using this feature',
        kyc_status: profile.kyc_status,
      });
      return;
    }

    // KYC aprobado, permitir acceso
    next();
  } catch (error: any) {
    logger.error('Error en middleware requireKYCValidation', error as Error, {
      userId: user.sub,
    });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to verify KYC',
    });
  }
};
