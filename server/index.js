import 'dotenv/config';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { openPostgresDatabase } from './postgres.js';
import { startAutomationScheduler } from './automations.js';

async function start() {
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set in production; SQLite is for local development only.');
  }
  const db = process.env.DATABASE_URL
    ? await openPostgresDatabase(process.env.DATABASE_URL)
    : openDatabase();
  const app = createApp({ db });
  const port = Number(process.env.PORT || 3001);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`CafeLoop API listening on http://localhost:${port} (${db.kind || 'sqlite'})`);
    startAutomationScheduler(app.locals.db);
  });
  const shutdown = () => server.close(async () => {
    await app.locals.close();
    process.exit(0);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('CafeLoop could not start:', error);
  process.exitCode = 1;
});
