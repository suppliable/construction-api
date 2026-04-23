'use strict';

const { z } = require('zod');
const dotenv = require('dotenv');
const path = require('path');

// Load base .env (gitignored, developer file)
dotenv.config();
// Load .env.local if present — higher priority, overrides .env (gitignored)
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  ZOHO_CLIENT_ID: z.string().min(1, 'ZOHO_CLIENT_ID is required'),
  ZOHO_CLIENT_SECRET: z.string().min(1, 'ZOHO_CLIENT_SECRET is required'),
  ZOHO_REFRESH_TOKEN: z.string().min(1, 'ZOHO_REFRESH_TOKEN is required'),
  ZOHO_API_DOMAIN: z.string().url('ZOHO_API_DOMAIN must be a valid URL'),
  ZOHO_ORG_ID: z.string().min(1, 'ZOHO_ORG_ID is required'),

  FIREBASE_SERVICE_ACCOUNT: z.string().min(1, 'FIREBASE_SERVICE_ACCOUNT is required'),

  ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD must be at least 8 characters'),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 characters'),
  JWT_SECRET: z.string().min(6, 'JWT_SECRET must be at least 6 characters'),

  // Optional
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  WAREHOUSE_LAT: z.coerce.number().optional(),
  WAREHOUSE_LNG: z.coerce.number().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  const errors = result.error.issues
    .map(issue => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Intentional console.error — logger is not yet initialised at this point
  console.error(`[Config] Environment validation failed:\n${errors}`);
  process.exit(1);
}

module.exports = result.data;
