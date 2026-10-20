// Runs before every test file. Tests use Redis database 15 so they never touch real data.
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/15';
process.env.JWT_SECRET ??= 'test-secret';
process.env.MEDIA_BASE_URL ??= 'https://cdn.test';
