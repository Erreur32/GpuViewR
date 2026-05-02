import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3015', 10),
  jwtSecret: process.env.JWT_SECRET || '',
  publicUrl: process.env.PUBLIC_URL || '',
  tz: process.env.TZ || 'UTC',
  gpuTickMs: parseInt(process.env.GPU_TICK_MS || '1000', 10),
  retentionDays: parseInt(process.env.RETENTION_DAYS || '7', 10),
  dataDir: process.env.DATA_DIR || './data',
  nodeEnv: process.env.NODE_ENV || 'development',
};

if (!config.jwtSecret || config.jwtSecret.length < 16) {
  if (config.nodeEnv === 'production') {
    throw new Error(
      'JWT_SECRET is required in production. Generate one with: openssl rand -base64 32'
    );
  }
  console.warn('[config] JWT_SECRET is missing or too short — using a dev fallback. DO NOT use in production.');
  config.jwtSecret = 'dev-only-insecure-secret-change-me-please-________________';
}

/** Returns PUBLIC_URL if explicitly configured, otherwise an empty string. */
export function getPublicUrl(): string {
  return config.publicUrl || '';
}
