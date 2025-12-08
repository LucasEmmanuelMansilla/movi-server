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
