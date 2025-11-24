import 'dotenv/config'


import { z } from 'zod'

// Definimos el esquema de las variables
const envSchema = z.object({
  PORT: z.string().default("4000"),
  JWT_SECRET: z.string().min(10, "JWT_SECRET debe tener al menos 10 caracteres"),

  SUPABASE_URL: z.string().url("SUPABASE_URL debe ser una URL válida"),
  SUPABASE_ANON_KEY: z.string().min(1, "Falta SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "Falta SUPABASE_SERVICE_ROLE_KEY"),
})

// Parseamos process.env y validamos
export const env = envSchema.parse(process.env)
