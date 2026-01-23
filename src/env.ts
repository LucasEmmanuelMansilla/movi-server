import 'dotenv/config'

import { z } from 'zod'

const envSchema = z.object({
  PORT: z.string().default("4000"),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  SUPABASE_URL: z.string().url("SUPABASE_URL debe ser una URL válida"),
  SUPABASE_ANON_KEY: z.string().min(1, "Falta SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "Falta SUPABASE_SERVICE_ROLE_KEY"),
  SUPABASE_JWT_SECRET: z.string().min(1, "Falta SUPABASE_JWT_SECRET").optional(),

  MERCADOPAGO_ACCESS_TOKEN: z.string().min(1, "MERCADOPAGO_ACCESS_TOKEN es requerido"),
  COMMISSION_PERCENTAGE: z.string().default('10'),
  
  MP_APPLICATION_ID: z.string().optional(),
  MP_CLIENT_ID: z.string().optional(),
  MP_CLIENT_SECRET: z.string().optional(),
  MP_REDIRECT_URI: z.string().url("MP_REDIRECT_URI debe ser una URL válida"),
  
  MP_WEBHOOK_SECRET: z.string().optional(),
  
  API_URL: z.string().url("API_URL debe ser una URL válida"),
  
  EXPO_ACCESS_TOKEN: z.string().optional(),
  FCM_SERVER_KEY: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVICE_ACCOUNT_KEY: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
})

let env: z.infer<typeof envSchema>;
try {
  env = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('❌ Error en variables de entorno:');
    error.errors.forEach((err) => {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
  }
  throw error;
}

export { env };
