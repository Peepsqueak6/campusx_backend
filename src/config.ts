const isProd = process.env.NODE_ENV === 'production';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/campusx?replicaSet=rs0',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  // Module A owns token issuance. The secret is shared so this service can verify its tokens.
  jwtSecret: isProd ? required('JWT_SECRET') : (process.env.JWT_SECRET ?? 'dev-secret-change-me'),
  media: {
    bucket: process.env.MEDIA_BUCKET ?? 'campusx-media',
    baseUrl: (process.env.MEDIA_BASE_URL ?? 'https://cdn.campusx.example').replace(/\/$/, ''),
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION ?? 'auto',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'dev',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'dev',
    presignTtlSec: 300,
  },
};
