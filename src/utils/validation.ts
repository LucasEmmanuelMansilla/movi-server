import { z } from 'zod';
import { StatusCodes } from 'http-status-codes';
import { Request, Response, NextFunction } from 'express';

/**
 * Utilidades de validación y sanitización
 */

// Sanitizar strings removiendo caracteres peligrosos
export function sanitizeString(input: string): string {
  return input
    .trim()
    .replace(/[<>]/g, '') // Remover tags HTML
    .replace(/javascript:/gi, '') // Remover javascript:
    .replace(/on\w+=/gi, ''); // Remover event handlers
}

// Validar email
export const emailSchema = z.string().email('Email inválido').transform(sanitizeString);

// Validar teléfono
export const phoneSchema = z.string()
  .regex(/^[+]?[(]?[0-9]{1,4}[)]?[-\s.]?[(]?[0-9]{1,4}[)]?[-\s.]?[0-9]{1,9}$/, 'Teléfono inválido')
  .transform(sanitizeString);

// Validar dirección
export const addressSchema = z.string()
  .min(10, 'La dirección debe tener al menos 10 caracteres')
  .max(200, 'La dirección no puede exceder 200 caracteres')
  .transform(sanitizeString);

// Validar precio
export const priceSchema = z.number()
  .nonnegative('El precio debe ser positivo')
  .max(1000000, 'El precio no puede exceder 1,000,000');

// Validar título
export const titleSchema = z.string()
  .min(3, 'El título debe tener al menos 3 caracteres')
  .max(100, 'El título no puede exceder 100 caracteres')
  .transform(sanitizeString);

// Validar descripción
export const descriptionSchema = z.string()
  .max(500, 'La descripción no puede exceder 500 caracteres')
  .transform(sanitizeString)
  .optional();

// Validar nombre completo
export const fullNameSchema = z.string()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(120, 'El nombre no puede exceder 120 caracteres')
  .transform(sanitizeString);

// Validar URL de avatar (base64 o URL)
export const avatarUrlSchema = z.string()
  .max(500000, 'La imagen es demasiado grande')
  .optional();

// Validar número de licencia
export const licenseNumberSchema = z.string()
  .min(5, 'El número de licencia debe tener al menos 5 caracteres')
  .max(50, 'El número de licencia no puede exceder 50 caracteres')
  .transform(sanitizeString)
  .optional();

// Validar tipo de vehículo
export const vehicleTypeSchema = z.string()
  .max(50, 'El tipo de vehículo no puede exceder 50 caracteres')
  .transform(sanitizeString)
  .optional();

// Validar placa de vehículo
export const vehiclePlateSchema = z.string()
  .min(4, 'La placa debe tener al menos 4 caracteres')
  .max(20, 'La placa no puede exceder 20 caracteres')
  .transform(sanitizeString)
  .optional();

// Validar nombre de negocio
export const businessNameSchema = z.string()
  .min(2, 'El nombre del negocio debe tener al menos 2 caracteres')
  .max(100, 'El nombre del negocio no puede exceder 100 caracteres')
  .transform(sanitizeString)
  .optional();

/**
 * Middleware para validar el body de la request con Zod
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = schema.safeParse(req.body);
      
      if (!result.success) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Datos inválidos',
          details: result.error.flatten(),
        });
      }

      // Reemplazar el body con los datos validados y sanitizados
      req.body = result.data;
      next();
    } catch (error) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Error al validar los datos',
      });
    }
  };
}

/**
 * Middleware para validar query parameters
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = schema.safeParse(req.query);
      
      if (!result.success) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Parámetros de consulta inválidos',
          details: result.error.flatten(),
        });
      }

      req.query = result.data as any;
      next();
    } catch (error) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Error al validar los parámetros',
      });
    }
  };
}

/**
 * Middleware para validar params
 */
export function validateParams<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = schema.safeParse(req.params);
      
      if (!result.success) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Parámetros de ruta inválidos',
          details: result.error.flatten(),
        });
      }

      req.params = result.data as any;
      next();
    } catch (error) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Error al validar los parámetros',
      });
    }
  };
}

