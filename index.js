import 'dotenv/config';
import express from 'express';
import { createApp } from './server/app.js';
import { openPostgresDatabase } from './server/postgres.js';

let apiAppPromise;

async function initializeApiApp() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing.');
  const db = await openPostgresDatabase(process.env.DATABASE_URL);
  return createApp({ db, serveStatic: false });
}

const app = express();
app.use(async (req, res, next) => {
  try {
    apiAppPromise ??= initializeApiApp();
    const apiApp = await apiAppPromise;
    apiApp(req, res, next);
  } catch {
    apiAppPromise = undefined;
    res.status(503).json({ error: 'CafeLoop database is not configured or is temporarily unavailable.' });
  }
});

export default app;
