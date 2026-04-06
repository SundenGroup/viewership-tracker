import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Don't run tests against the dashboard (separate project)
  testPathIgnorePatterns: ['/node_modules/', '/src/dashboard/'],
  // Increase timeout for DB tests
  testTimeout: 15_000,
};

export default config;
