import crypto from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';

process.env.NODE_ENV = 'production';
process.env.TWILIO_AUTOMATIONS_ENABLED = 'false';
for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']) delete process.env[key];

const databasePath = process.env.PUBLIC_TEST_DATABASE_PATH || './.data/cafeloop-public-test.sqlite';
const port = Number(process.env.PUBLIC_TEST_PORT || 3002);
const db = openDatabase(databasePath);
const now = new Date().toISOString();
const slug = 'cafeloop-qr-test';
const ownerEmail = 'tasting-owner@cafeloop.test';
const ownerPassword = crypto.randomBytes(24).toString('base64url');
const salt = crypto.randomBytes(16);
const passwordHash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync(ownerPassword, salt, 64).toString('hex')}`;

let cafe = db.prepare('SELECT * FROM cafes WHERE slug=?').get(slug);
if (!cafe) {
  const cafeId = crypto.randomUUID();
  db.prepare(`INSERT INTO cafes(id,slug,name,accent_colour,currency,timezone,created_at)
    VALUES(?,?,?,'#214638','INR','Asia/Kolkata',?)`).run(cafeId, slug, 'CafeLoop Tasting Test', now);
  cafe = db.prepare('SELECT * FROM cafes WHERE id=?').get(cafeId);
}

if (!db.prepare('SELECT 1 FROM menu_items WHERE cafe_id=? LIMIT 1').get(cafe.id)) {
  const insertItem = db.prepare(`INSERT INTO menu_items(id,cafe_id,name,category,price,earns_stamp,is_available,image_url,sort_order)
    VALUES(?,?,?,?,?,1,1,'',?)`);
  [
    ['Adrak Chai (Small)', 'Chai', 20],
    ['Adrak Chai (Medium)', 'Chai', 35],
    ['Cold Coffee', 'Coffee', 80],
    ['Plain Maggi', 'Maggi', 70],
  ].forEach(([name, category, price], index) => insertItem.run(crypto.randomUUID(), cafe.id, name, category, price, index));
}

const owner = db.prepare('SELECT id FROM owners WHERE email=?').get(ownerEmail);
if (owner) {
  db.prepare('DELETE FROM sessions WHERE owner_id=?').run(owner.id);
  db.prepare('UPDATE owners SET password_hash=? WHERE id=?').run(passwordHash, owner.id);
} else {
  db.prepare('INSERT INTO owners(id,cafe_id,email,password_hash,created_at) VALUES(?,?,?,?,?)')
    .run(crypto.randomUUID(), cafe.id, ownerEmail, passwordHash, now);
}

const app = createApp({ db, publicTest: true });
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Isolated public test app listening on http://127.0.0.1:${port}`);
  console.log(`Test owner: ${ownerEmail}`);
  console.log(`Test password: ${ownerPassword}`);
  console.log(`Test menu: /order?cafe=${slug}&table=1`);
});
const shutdown = () => server.close(async () => {
  await app.locals.close();
  process.exit(0);
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
