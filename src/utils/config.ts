import dotenv from 'dotenv';

dotenv.config();

export const config = {
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/clutch_viewership',
  },
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID || '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
  },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || '',
  },
  kick: {
    clientId: process.env.KICK_CLIENT_ID || '',
    clientSecret: process.env.KICK_CLIENT_SECRET || '',
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    wsPort: parseInt(process.env.WS_PORT || '3001', 10),
  },
  polling: {
    intervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10),
    discoveryIntervalMs: parseInt(process.env.DISCOVERY_INTERVAL_MS || '120000', 10),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
} as const;
