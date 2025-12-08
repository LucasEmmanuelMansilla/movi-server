import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { StatusCodes } from 'http-status-codes';
import jwt from 'jsonwebtoken'

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

const JWKS = createRemoteJWKSet(
  new URL('https://syjlkrocwuhmkenfyqkr.supabase.co/auth/v1/jwts')
);

const SUPABASE_SECRET = process.env.SUPABASE_JWT_SECRET || '';

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'Missing or invalid token format. Expected: Bearer <token>' 
      });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No token provided' });
    }

    const tokenParts = token.split('.');
    if (tokenParts.length !== 3) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'Invalid token format',
        details: 'JWT must have 3 parts separated by dots'
      });
    }

    let header;
    try {
      const headerBase64 = tokenParts[0].replace(/-/g, '+').replace(/_/g, '/');
      const headerJson = Buffer.from(headerBase64, 'base64').toString();
      header = JSON.parse(headerJson);
    } catch (error) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'Invalid token format',
        details: 'Failed to decode JWT header'
      });
    }

    if (!header.alg) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'Invalid token format',
        details: 'JWT header missing algorithm'
      });
    }

    let payload: any;

    try {
      if (header.alg === 'HS256') {
        if (!SUPABASE_SECRET) {
          return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
            error: 'Server configuration error' 
          });
        }
        const secret = SUPABASE_SECRET.replace(/^['"]|['"]$/g, '');
        payload = jwt.verify(token, secret, {
          algorithms: ['HS256'],
          audience: 'authenticated',
          issuer: 'https://syjlkrocwuhmkenfyqkr.supabase.co/auth/v1'
        });
      } else if (header.alg === 'RS256') {
        const result = await jwtVerify(token, JWKS);
        payload = result.payload;
      } else {
        return res.status(StatusCodes.UNAUTHORIZED).json({ 
          error: 'Unsupported token algorithm',
          details: `Algorithm '${header.alg}' is not supported`
        });
      }

      req.user = payload;
      next();
    } catch (verifyError: any) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'Invalid or expired token',
        details: verifyError.message
      });
    }
  } catch (error: any) {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Authentication failed',
      details: error.message 
    });
  }
};
