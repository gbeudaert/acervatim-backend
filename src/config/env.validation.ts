import { z } from 'zod';

const base64Length = (decodedBytes: number) =>
  z.string().refine((s) => Buffer.from(s, 'base64').length === decodedBytes, {
    message: `must be base64 of exactly ${decodedBytes} bytes`,
  });

export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  DATABASE_URL: z.string().url(),
  SUB_HASH_PEPPER: z.string().min(32),
  ENCRYPTION_KEY: base64Length(32),
  INVITE_CODE_PEPPER: z.string().min(32),
  ADMIN_API_TOKEN: z.string().min(16),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  DISCOGS_CONSUMER_KEY: z.string().optional(),
  DISCOGS_CONSUMER_SECRET: z.string().optional(),
  DISCOGS_CALLBACK_URL: z
    .string()
    .url()
    .default('http://localhost:3000/v1/oauth/discogs/callback'),
  MAL_CLIENT_ID: z.string().optional(),
  MAL_CLIENT_SECRET: z.string().optional(),
  MAL_CALLBACK_URL: z
    .string()
    .url()
    .default('http://localhost:3000/v1/oauth/mal/callback'),
  TMDB_API_KEY: z.string().optional(),
  // Google Play Billing — optionnels en dev/test, requis en prod pour activer
  // verify + RTDN. Le JSON du service account est encodé base64 pour éviter les
  // newlines (private_key contient des \n littéraux).
  GOOGLE_PLAY_PACKAGE_NAME: z.string().min(1).optional(),
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z
    .string()
    .min(1)
    .optional()
    .refine(
      (s) => {
        if (!s) return true;
        try {
          const decoded = Buffer.from(s, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded);
          return (
            typeof parsed === 'object' &&
            typeof parsed.client_email === 'string' &&
            typeof parsed.private_key === 'string'
          );
        } catch {
          return false;
        }
      },
      { message: 'must be base64-encoded service account JSON' },
    ),
  GOOGLE_PUBSUB_SA_EMAIL: z.string().email().optional(),
  GOOGLE_PUBSUB_AUDIENCE: z.string().url().optional(),
  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-Backend/1.0 (+contact@acervatim.local)'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid env vars:\n${details}`);
  }
  return parsed.data;
}
