/**
 * Tests for configuration validation.
 */

describe('JWT_SECRET validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    // Replace process.env entirely to prevent dotenv from seeing real values
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('throws in production if JWT_SECRET is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    // Mock dotenv to not load .env
    jest.mock('dotenv', () => ({ config: jest.fn() }));
    expect(() => require('../../src/utils/config')).toThrow('JWT_SECRET must be set in production');
  });

  test('throws in production if JWT_SECRET is default value', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'CHANGE_ME_IN_PRODUCTION';
    jest.mock('dotenv', () => ({ config: jest.fn() }));
    expect(() => require('../../src/utils/config')).toThrow('JWT_SECRET must be set in production');
  });

  test('uses dev fallback in non-production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_SECRET;
    jest.mock('dotenv', () => ({ config: jest.fn() }));
    const { config } = require('../../src/utils/config');
    expect(config.auth.jwtSecret).toBe('dev-only-insecure-secret');
  });

  test('uses provided JWT_SECRET when set', () => {
    process.env.JWT_SECRET = 'my-super-secret-key';
    jest.mock('dotenv', () => ({ config: jest.fn() }));
    const { config } = require('../../src/utils/config');
    expect(config.auth.jwtSecret).toBe('my-super-secret-key');
  });
});

describe('Cookie secure flag', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('secure is true in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret';
    const { config } = require('../../src/utils/config');
    expect(config.auth.cookieSecure).toBe(true);
  });

  test('secure is false in development by default', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COOKIE_SECURE;
    const { config } = require('../../src/utils/config');
    expect(config.auth.cookieSecure).toBe(false);
  });
});
