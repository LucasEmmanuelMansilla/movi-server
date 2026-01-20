import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { createAdminClient } from '../lib/supabase';
import { logger } from '../utils/logger';

/**
 * Middleware que verifica que el usuario autenticado tenga rol de administrador
 */
export const adminMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user;
    if (!user?.sub) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'No autorizado' 
      });
    }

    const admin = createAdminClient();
    const { data: profile, error } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.sub)
      .maybeSingle();

    if (error) {
      logger.error('Error verificando rol de admin', error as Error);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
        error: 'Error verificando permisos' 
      });
    }

    if (!profile || profile.role !== 'admin') {
      return res.status(StatusCodes.FORBIDDEN).json({ 
        error: 'Acceso denegado. Se requiere rol de administrador.' 
      });
    }

    next();
  } catch (error) {
    logger.error('Error en middleware de admin', error as Error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Error verificando permisos' 
    });
  }
};
