import 'dotenv/config'

import { z } from 'zod'

// Definimos el esquema de las variables
const envSchema = z.object({
  PORT: z.string().default("4000"),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().min(10, "JWT_SECRET debe tener al menos 10 caracteres").optional(),

  SUPABASE_URL: z.string().url("SUPABASE_URL debe ser una URL válida"),
  SUPABASE_ANON_KEY: z.string().min(1, "Falta SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "Falta SUPABASE_SERVICE_ROLE_KEY"),
  SUPABASE_JWT_SECRET: z.string().min(1, "Falta SUPABASE_JWT_SECRET").optional(),

  // Mercado Pago
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(), // Access token del marketplace
  MERCADOPAGO_PUBLIC_KEY: z.string().optional(),
  COMMISSION_PERCENTAGE: z.string().default('10'), // Porcentaje de comisión (por defecto 10%)
  // OAuth de Mercado Pago
  MP_CLIENT_ID: z.string().optional(), // Client ID de la aplicación OAuth
  MP_CLIENT_SECRET: z.string().optional(), // Client Secret de la aplicación OAuth
  MP_REDIRECT_URI: z.string().url("MP_REDIRECT_URI debe ser una URL válida").optional(), // URI de redirección para OAuth
  
  // URL del servidor (para back_urls y webhooks)
  API_URL: z.string().url("API_URL debe ser una URL válida").optional(),
  
  // Opcionales
  EXPO_ACCESS_TOKEN: z.string().optional(),
  FCM_SERVER_KEY: z.string().optional(), // Server Key de Firebase Cloud Messaging (Legacy - deprecated)
  FCM_PROJECT_ID: z.string().optional(), // Project ID de Firebase (para API v1)
  FCM_SERVICE_ACCOUNT_KEY: z.string().optional(), // Service Account JSON key (para API v1)
  ALLOWED_ORIGINS: z.string().optional(),
})

// Parseamos process.env y validamos
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
