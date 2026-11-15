import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(databasePath = process.env.DATABASE_PATH || './.data/cafeloop.sqlite') {
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cafes (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      logo_url TEXT NOT NULL DEFAULT '',
      accent_colour TEXT NOT NULL DEFAULT '#2146b8',
      currency TEXT NOT NULL DEFAULT 'INR',
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      google_review_link TEXT NOT NULL DEFAULT '',
      stamp_target INTEGER NOT NULL DEFAULT 5 CHECK (stamp_target BETWEEN 3 AND 20),
      comeback_days INTEGER NOT NULL DEFAULT 21 CHECK (comeback_days BETWEEN 7 AND 180),
      messaging_channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (messaging_channel IN ('whatsapp','sms')),
      messaging_from TEXT NOT NULL DEFAULT '',
      dlt_pe_id TEXT NOT NULL DEFAULT '',
      comeback_dlt_template_id TEXT NOT NULL DEFAULT '',
      birthday_dlt_template_id TEXT NOT NULL DEFAULT '',
      review_dlt_template_id TEXT NOT NULL DEFAULT '',
      comeback_template TEXT NOT NULL DEFAULT 'Hi {name}! We have missed you at {cafe}. Your usual {favourite_item} is waiting. Show code {code} for 20% off this week, until {expiry}. Reply STOP to opt out.',
      birthday_template TEXT NOT NULL DEFAULT 'Happy birthday, {name}! A free {favourite_item} is on us at {cafe} this week. Show code {code} at the counter. Reply STOP to opt out.',
      review_template TEXT NOT NULL DEFAULT 'Thanks for coming back to {cafe}, {name}! If you have 30 seconds, an honest Google review helps a small cafe like ours a lot: {review_link}',
      comeback_template_sid TEXT NOT NULL DEFAULT '',
      birthday_template_sid TEXT NOT NULL DEFAULT '',
      review_template_sid TEXT NOT NULL DEFAULT '',
      public_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owners (
      id TEXT NOT NULL,
      cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','manager')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (cafe_id, id),
      UNIQUE (cafe_id, id)
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT NOT NULL,
      cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      whatsapp_number TEXT NOT NULL,
      birthday_day INTEGER CHECK (birthday_day IS NULL OR birthday_day BETWEEN 1 AND 31),
      birthday_month INTEGER CHECK (birthday_month IS NULL OR birthday_month BETWEEN 1 AND 12),
      visit_count INTEGER NOT NULL DEFAULT 0 CHECK (visit_count >= 0),
      last_visit_at TEXT,
      favourite_item TEXT NOT NULL DEFAULT '',
      marketing_consent INTEGER NOT NULL DEFAULT 0 CHECK (marketing_consent IN (0,1)),
      consent_at TEXT,
      opted_out_at TEXT,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (cafe_id, id),
      UNIQUE (cafe_id, whatsapp_number),
      UNIQUE (cafe_id, token_hash)
    );
    CREATE INDEX IF NOT EXISTS customers_last_visit ON customers(cafe_id, last_visit_at);
    CREATE INDEX IF NOT EXISTS customers_birthday ON customers(cafe_id, birthday_month, birthday_day);
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT NOT NULL,
      cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL CHECK (price >= 0),
      earns_stamp INTEGER NOT NULL DEFAULT 1 CHECK (earns_stamp IN (0,1)),
      is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1)),
      image_url TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (cafe_id, id)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT NOT NULL,
      cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      table_number INTEGER NOT NULL CHECK (table_number BETWEEN 1 AND 999),
      items TEXT NOT NULL CHECK (json_valid(items)),
      amount REAL NOT NULL CHECK (amount >= 0),
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','preparing','completed','cancelled')),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (cafe_id, id),
      FOREIGN KEY (cafe_id, customer_id) REFERENCES customers(cafe_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS orders_created_at ON orders(cafe_id, created_at);
    CREATE INDEX IF NOT EXISTS orders_status ON orders(cafe_id, status, created_at);
    CREATE TABLE IF NOT EXISTS rewards (
      id TEXT NOT NULL,
      cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      code TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('coffee','birthday','comeback')),
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','redeemed','expired','cancelled')),
      expires_at TEXT,
      redeemed_at TEXT,
      stamp_target INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (cafe_id, id),
      UNIQUE (cafe_id, code),
      FOREIGN KEY (cafe_id, customer_id) REFERENCES customers(cafe_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS stamps (
      id TEXT NOT NULL,
      cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      reward_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (cafe_id, id),
      UNIQUE (cafe_id, order_id),
      FOREIGN KEY (cafe_id, customer_id) REFERENCES customers(cafe_id, id) ON DELETE CASCADE,
      FOREIGN KEY (cafe_id, order_id) REFERENCES orders(cafe_id, id) ON DELETE CASCADE,
      FOREIGN KEY (cafe_id, reward_id) REFERENCES rewards(cafe_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT NOT NULL,
      cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'google',
      scheduled_at TEXT NOT NULL,
      requested_at TEXT,
      clicked_at TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','clicked','skipped','failed')),
      PRIMARY KEY (cafe_id, id),
      UNIQUE (cafe_id, customer_id),
      FOREIGN KEY (cafe_id, customer_id) REFERENCES customers(cafe_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT NOT NULL,
      cafe_id TEXT NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      reward_id TEXT,
      type TEXT NOT NULL CHECK (type IN ('comeback','birthday','review')),
      message TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      expires_at TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued','opened','sent','failed','suppressed')),
      delivery_error TEXT NOT NULL DEFAULT '',
      returned_at TEXT,
      PRIMARY KEY (cafe_id, id),
      UNIQUE (cafe_id, idempotency_key),
      FOREIGN KEY (cafe_id, customer_id) REFERENCES customers(cafe_id, id) ON DELETE CASCADE,
      FOREIGN KEY (cafe_id, reward_id) REFERENCES rewards(cafe_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS offers_customer_type ON offers(cafe_id, customer_id, type, sent_at);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      cafe_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (cafe_id, owner_id) REFERENCES owners(cafe_id, id) ON DELETE CASCADE
    );
  `);
  const cafeColumns = db.prepare('PRAGMA table_info(cafes)').all();
  if (!cafeColumns.some((column) => column.name === 'messaging_from')) db.exec("ALTER TABLE cafes ADD COLUMN messaging_from TEXT NOT NULL DEFAULT ''");
  if (!cafeColumns.some((column) => column.name === 'dlt_pe_id')) db.exec("ALTER TABLE cafes ADD COLUMN dlt_pe_id TEXT NOT NULL DEFAULT ''");
  if (!cafeColumns.some((column) => column.name === 'comeback_dlt_template_id')) db.exec("ALTER TABLE cafes ADD COLUMN comeback_dlt_template_id TEXT NOT NULL DEFAULT ''");
  if (!cafeColumns.some((column) => column.name === 'birthday_dlt_template_id')) db.exec("ALTER TABLE cafes ADD COLUMN birthday_dlt_template_id TEXT NOT NULL DEFAULT ''");
  if (!cafeColumns.some((column) => column.name === 'review_dlt_template_id')) db.exec("ALTER TABLE cafes ADD COLUMN review_dlt_template_id TEXT NOT NULL DEFAULT ''");
  db.exec('PRAGMA user_version = 3');
  return db;
}
