import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { openDatabase } from './db.js';
import { deliver as deliverOffer } from './automations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isoNow = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const phonePattern = /^\+[1-9]\d{7,14}$/;
const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const timezoneSchema = z.string().min(3).max(80).refine((value) => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }, 'Enter a valid timezone such as Europe/London.');
const senderSchema = z.string().trim().max(40).default('');

const setupSchema = z.object({
  cafeName: z.string().trim().min(2).max(90),
  ownerEmail: emailSchema,
  password: z.string().min(10).max(128),
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  timezone: timezoneSchema.default('Asia/Kolkata'),
});
const orderSchema = z.object({
  table: z.coerce.number().int().min(1).max(999),
  customer_token: z.string().min(24).max(128).optional(),
  customer: z.object({
    name: z.string().trim().min(1).max(80),
    phone: z.string().transform((value) => value.replace(/[\s().-]/g, '')).refine((value) => phonePattern.test(value), 'Use an international number such as +14155550123.'),
    marketing_consent: z.boolean().default(false),
    birthday_day: z.coerce.number().int().min(1).max(31).optional().nullable(),
    birthday_month: z.coerce.number().int().min(1).max(12).optional().nullable(),
  }).optional(),
  items: z.array(z.object({ menu_item_id: z.string().min(1), quantity: z.coerce.number().int().min(1).max(20), note: z.string().max(180).default('') })).min(1).max(50),
  note: z.string().max(400).default(''),
});

async function inTransaction(db, callback) {
  if (db.kind === 'postgres') return db.transaction(callback);
  await db.exec('BEGIN IMMEDIATE');
  try { const result = await callback(db); await db.exec('COMMIT'); return result; }
  catch (error) { await db.exec('ROLLBACK'); throw error; }
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [algorithm, saltHex, keyHex] = (stored || '').split('$');
  if (algorithm !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `cafeloop_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'cafeloop_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const piece of raw.split(';')) {
    const [key, ...value] = piece.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}
function slugify(name) {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return slug || `cafe-${crypto.randomBytes(3).toString('hex')}`;
}
async function mintUniqueCode(db, cafeId, prefix) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    const code = `${prefix}-${suffix}`;
    if (!(await (db.prepare('SELECT 1 FROM rewards WHERE cafe_id = ? AND code = ?').get(cafeId, code)))) return code;
  }
  throw new Error('Could not create a unique reward code. Please try again.');
}
async function cafeBySlug(db, slug) {
  return (await (db.prepare('SELECT * FROM cafes WHERE slug = ?').get(slug)));
}
function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const error = new Error(result.error.issues.map((issue) => issue.message).join(' '));
    error.status = 400;
    throw error;
  }
  return result.data;
}
function localDateKey(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function localTimeParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { hour: Number(values.hour), minute: Number(values.minute) };
}
function zonedMidnight(dateKey, timezone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
    const actual = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
    guess += target - actual;
  }
  return new Date(guess).toISOString();
}
function calendarRange(now, timezone) {
  const dateKey = localDateKey(now, timezone);
  const [year, month, day] = dateKey.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  const monday = new Date(Date.UTC(year, month - 1, day - mondayOffset));
  const weekKey = `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2,'0')}-${String(monday.getUTCDate()).padStart(2,'0')}`;
  const monthKey = `${year}-${String(month).padStart(2,'0')}-01`;
  const nextMonthDate = new Date(Date.UTC(year, month, 1));
  const nextMonthKey = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2,'0')}-01`;
  return {
    today: zonedMidnight(dateKey, timezone),
    tomorrow: zonedMidnight(new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0,10), timezone),
    week: zonedMidnight(weekKey, timezone),
    month: zonedMidnight(monthKey, timezone),
    nextMonth: zonedMidnight(nextMonthKey, timezone),
  };
}
function renderTemplate(template, values) {
  return template.replace(/\{([a-z_]+)\}/gi, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
function publicCafe(cafe) {
  return {
    id: cafe.id, slug: cafe.slug, name: cafe.name, logo_url: cafe.logo_url,
    accent_colour: cafe.accent_colour, currency: cafe.currency, stamp_target: cafe.stamp_target,
    google_review_link: cafe.google_review_link, timezone: cafe.timezone,
  };
}
function ownerCafe(cafe) {
  const { comeback_template_sid, birthday_template_sid, review_template_sid, ...fields } = cafe;
  return { ...fields, twilio_templates: { comeback: comeback_template_sid, birthday: birthday_template_sid, review: review_template_sid } };
}
async function customerTokenFromRequest(db, cafeId, token) {
  if (!token) return null;
  return (await (db.prepare('SELECT * FROM customers WHERE cafe_id = ? AND token_hash = ?').get(cafeId, hash(token))));
}

export function createApp(options = {}) {
  const db = options.db || openDatabase(options.databasePath);
  const app = express();
  const listeners = new Map();
  app.locals.db = db;
  app.locals.broadcast = (cafeId, event, payload = {}) => {
    for (const res of listeners.get(cafeId) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  app.disable('x-powered-by');
  if (options.publicTest) app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  if (options.publicTest) app.use((req, res, next) => {
    if (req.path === '/owner/setup') return res.redirect(302, '/owner/login');
    if (req.method === 'POST' && req.path === '/api/auth/setup') {
      return res.status(403).json({ error: 'Signup is disabled for this temporary test.' });
    }
    next();
  });
  app.use((req, res, next) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin) {
      const origin = new URL(req.headers.origin).origin;
      const requestOrigin = `${req.protocol}://${req.get('host')}`;
      const developmentOrigins = process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173'];
      const allowedOrigins = new Set([requestOrigin, process.env.APP_PUBLIC_URL && new URL(process.env.APP_PUBLIC_URL).origin, ...developmentOrigins].filter(Boolean));
      if (!allowedOrigins.has(origin)) return res.status(403).json({ error: 'This request origin is not allowed.' });
    }
    next();
  });

  async function requireOwner(req, res, next) {
    const rawToken = readCookie(req, 'cafeloop_session');
    if (!rawToken) return res.status(401).json({ error: 'Sign in to continue.' });
    const session = (await (db.prepare(`SELECT s.cafe_id, s.owner_id, o.email, o.role, c.*
      FROM sessions s JOIN owners o ON o.cafe_id=s.cafe_id AND o.id=s.owner_id
      JOIN cafes c ON c.id=s.cafe_id
      WHERE s.token_hash=? AND s.expires_at > ?`).get(hash(rawToken), isoNow())));
    if (!session) { clearSessionCookie(res); return res.status(401).json({ error: 'Your session has expired. Sign in again.' }); }
    req.owner = { id: session.owner_id, cafe_id: session.cafe_id, email: session.email, role: session.role };
    req.cafe = session;
    next();
  }
  const owner = (handler) => async (req, res, next) => { (await (requireOwner(req, res, (error) => error ? next(error) : Promise.resolve(handler(req, res, next)).catch(next)))); };
  async function issueSession(res, cafeId, ownerId) {
    const raw = crypto.randomBytes(32).toString('base64url');
    (await (db.prepare('INSERT INTO sessions(token_hash,cafe_id,owner_id,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(hash(raw), cafeId, ownerId, new Date(Date.now() + 30 * 86400000).toISOString(), isoNow())));
    setSessionCookie(res, raw);
  }
  async function createManualComeback(customer, cafe, idempotencyKey) {
    const now = isoNow(); const expires = new Date(Date.now()+7*86400000).toISOString(); const rewardId=uid(); const rewardCode=(await (mintUniqueCode(db,cafe.id,'COME')));
    const message = renderTemplate(cafe.comeback_template, { name: customer.name, cafe: cafe.name, favourite_item: customer.favourite_item || 'favourite coffee', code: rewardCode, expiry: new Date(expires).toLocaleDateString('en-US',{ timeZone: cafe.timezone }) });
    (await (inTransaction(db,async (tx)=>{
      await tx.prepare("INSERT INTO rewards(id,cafe_id,customer_id,code,type,status,expires_at,created_at) VALUES(?,?,?,?,'comeback','available',?,?)").run(rewardId,cafe.id,customer.id,rewardCode,expires,now);
      await tx.prepare("INSERT INTO offers(id,cafe_id,customer_id,reward_id,type,message,idempotency_key,sent_at,expires_at,delivery_status) VALUES(?,?,?,?,'comeback',?,?,?,?, 'queued')").run(uid(),cafe.id,customer.id,rewardId,message,idempotencyKey,now,expires);
    })));
    const offer={...(await (db.prepare('SELECT * FROM offers WHERE cafe_id=? AND idempotency_key=?').get(cafe.id,idempotencyKey))),reward_code:rewardCode};
    return {offer,code:rewardCode,message};
  }

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: 'connected' }));
  app.post('/api/auth/setup', async (req, res, next) => {
    try {
      const input = parseBody(setupSchema, req.body);
      let slug = slugify(input.cafeName);
      if ((await (db.prepare('SELECT 1 FROM cafes WHERE slug = ?').get(slug)))) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
      const cafeId = uid(); const ownerId = uid(); const now = isoNow();
      const defaultChannel = ['USD','CAD'].includes(input.currency) ? 'sms' : 'whatsapp';
      (await (inTransaction(db, async (tx) => {
        await tx.prepare('INSERT INTO cafes(id,slug,name,currency,timezone,messaging_channel,created_at) VALUES(?,?,?,?,?,?,?)').run(cafeId, slug, input.cafeName, input.currency, input.timezone, defaultChannel, now);
        await tx.prepare('INSERT INTO owners(id,cafe_id,email,password_hash,created_at) VALUES(?,?,?,?,?)').run(ownerId, cafeId, input.ownerEmail, passwordHash(input.password), now);
      })));
      (await (issueSession(res, cafeId, ownerId)));
      res.status(201).json({ owner: { id: ownerId, email: input.ownerEmail, role: 'owner' }, cafe: ownerCafe((await (db.prepare('SELECT * FROM cafes WHERE id = ?').get(cafeId)))) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed: owners.email') || (error.code === '23505' && error.constraint === 'owners_email_key')) error.message = 'An owner account already uses that email.';
      next(error);
    }
  });
  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const email = emailSchema.parse(req.body?.email);
      const password = z.string().min(1).max(128).parse(req.body?.password);
      const account = (await (db.prepare('SELECT * FROM owners WHERE email = ?').get(email)));
      if (!account || !verifyPassword(password, account.password_hash)) return res.status(401).json({ error: 'Email or password did not match.' });
      (await (issueSession(res, account.cafe_id, account.id)));
      return res.json({ owner: { id: account.id, email: account.email, role: account.role }, cafe: ownerCafe((await (db.prepare('SELECT * FROM cafes WHERE id = ?').get(account.cafe_id)))) });
    } catch (error) { next(error); }
  });
  app.post('/api/auth/logout', async (req, res) => {
    const token = readCookie(req, 'cafeloop_session');
    if (token) (await (db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token))));
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  app.get('/api/auth/me', async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    const rawToken=readCookie(req,'cafeloop_session');
    if(!rawToken)return res.json({owner:null,cafe:null});
    const session=(await (db.prepare(`SELECT s.cafe_id,s.owner_id,o.email,o.role,c.* FROM sessions s
      JOIN owners o ON o.cafe_id=s.cafe_id AND o.id=s.owner_id JOIN cafes c ON c.id=s.cafe_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(hash(rawToken),isoNow())));
    if(!session){clearSessionCookie(res);return res.json({owner:null,cafe:null});}
    res.json({owner:{id:session.owner_id,cafe_id:session.cafe_id,email:session.email,role:session.role},cafe:ownerCafe(session)});
  });
  app.get('/api/owner/integrations', owner((req,res)=>res.json({
    twilio_configured:Boolean(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&(req.cafe.messaging_from||process.env.TWILIO_FROM)),
    twilio_automations_enabled:process.env.TWILIO_AUTOMATIONS_ENABLED==='true',
    whatsapp_templates_ready:req.cafe.messaging_channel!=='whatsapp'||Boolean(req.cafe.comeback_template_sid&&req.cafe.birthday_template_sid&&req.cafe.review_template_sid),
  })));

  app.get('/api/public/:slug/menu', async (req, res) => {
    const cafe = (await (cafeBySlug(db, req.params.slug)));
    if (!cafe) return res.status(404).json({ error: 'Cafe not found.' });
    const items = (await (db.prepare('SELECT id,name,category,price,earns_stamp,is_available,image_url,sort_order FROM menu_items WHERE cafe_id=? AND is_available=1 ORDER BY sort_order,category,name').all(cafe.id)));
    res.json({ cafe: publicCafe(cafe), items });
  });
  app.get('/api/public/:slug/card', async (req, res) => {
    const cafe = (await (cafeBySlug(db, req.params.slug)));
    if (!cafe) return res.status(404).json({ error: 'Cafe not found.' });
    res.setHeader('Cache-Control','no-store');
    const customer = (await (customerTokenFromRequest(db, cafe.id, String(req.get('X-Cafe-Token') || ''))));
    if (!customer) return res.status(401).json({ error: 'Your customer card could not be found on this device.' });
    const stamps = (await (db.prepare(`SELECT COUNT(*) AS count FROM stamps s LEFT JOIN rewards r ON r.cafe_id=s.cafe_id AND r.id=s.reward_id
      WHERE s.cafe_id=? AND s.customer_id=? AND (s.reward_id IS NULL OR r.status IN ('available','expired'))`).get(cafe.id, customer.id))).count;
    const rewards = (await (db.prepare(`SELECT id,code,type,status,expires_at,created_at FROM rewards WHERE cafe_id=? AND customer_id=? AND status='available' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC`).all(cafe.id, customer.id, isoNow())));
    res.json({ cafe: publicCafe(cafe), customer: { name: customer.name, visit_count: customer.visit_count, favourite_item: customer.favourite_item, marketing_consent: Boolean(customer.marketing_consent) }, stamps, target: cafe.stamp_target, rewards });
  });
  app.post('/api/public/:slug/order', async (req, res, next) => {
    try {
      const cafe = (await (cafeBySlug(db, req.params.slug)));
      if (!cafe) return res.status(404).json({ error: 'Cafe not found.' });
      const input = parseBody(orderSchema, req.body);
      const now = isoNow();
      const itemRows = (await (db.prepare(`SELECT id,name,category,price,earns_stamp FROM menu_items WHERE cafe_id=? AND is_available=1`).all(cafe.id)));
      const itemMap = new Map(itemRows.map((item) => [item.id, item]));
      const snapshot = input.items.map((line) => {
        const item = itemMap.get(line.menu_item_id);
        if (!item) { const error = new Error('One of those menu items is no longer available. Refresh the menu and try again.'); error.status = 400; throw error; }
        return { menu_item_id: item.id, name: item.name, category: item.category, price: Number(item.price), quantity: line.quantity, note: line.note, earns_stamp: Boolean(item.earns_stamp) };
      });
      const amount = Math.round(snapshot.reduce((total, item) => total + item.price * item.quantity, 0) * 100) / 100;
      let customer; let customerToken = input.customer_token || '';
      if (customerToken) {
        customer = (await (customerTokenFromRequest(db, cafe.id, customerToken)));
        if (!customer) return res.status(401).json({ error: 'This customer card is no longer available. Please enter your details again.' });
        if (input.customer?.marketing_consent !== undefined && Boolean(input.customer.marketing_consent) !== Boolean(customer.marketing_consent)) {
          if(input.customer.marketing_consent)(await (db.prepare('UPDATE customers SET marketing_consent=1, consent_at=?, opted_out_at=NULL WHERE cafe_id=? AND id=?').run(now,cafe.id,customer.id)));
          else (await (db.prepare('UPDATE customers SET marketing_consent=0, opted_out_at=? WHERE cafe_id=? AND id=?').run(now,cafe.id,customer.id)));
        }
        if (input.customer?.birthday_day && input.customer?.birthday_month && customer.visit_count >= 1) {
          (await (db.prepare('UPDATE customers SET birthday_day=?,birthday_month=? WHERE cafe_id=? AND id=?').run(input.customer.birthday_day, input.customer.birthday_month, cafe.id, customer.id)));
        }
      } else {
        if (!input.customer) return res.status(400).json({ error: 'Add your name and international phone number to place your first order.' });
        const existing = (await (db.prepare('SELECT id FROM customers WHERE cafe_id=? AND whatsapp_number=?').get(cafe.id, input.customer.phone)));
        if (existing) return res.status(409).json({ error: 'This number already has a card. Open the original device to continue, or ask the cafe to help you recover it.' });
        customer = { id: uid(), cafe_id: cafe.id, name: input.customer.name, whatsapp_number: input.customer.phone, visit_count: 0, marketing_consent: Number(input.customer.marketing_consent) };
        customerToken = crypto.randomBytes(32).toString('base64url');
        (await (db.prepare(`INSERT INTO customers(id,cafe_id,name,whatsapp_number,birthday_day,birthday_month,marketing_consent,consent_at,token_hash,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(customer.id, cafe.id, input.customer.name, input.customer.phone,
          input.customer.birthday_day ?? null, input.customer.birthday_month ?? null, Number(input.customer.marketing_consent), input.customer.marketing_consent ? now : null, hash(customerToken), now)));
      }
      const orderId = uid();
      (await (db.prepare(`INSERT INTO orders(id,cafe_id,customer_id,table_number,items,amount,status,note,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'new',?,?,?)`).run(orderId, cafe.id, customer.id, input.table, JSON.stringify(snapshot), amount, input.note, now, now)));
      const comeback = (await (db.prepare(`SELECT o.id FROM offers o WHERE o.cafe_id=? AND o.customer_id=? AND o.type='comeback'
        AND o.delivery_status IN ('opened','sent') AND o.returned_at IS NULL AND o.expires_at > ? ORDER BY o.sent_at DESC LIMIT 1`).get(cafe.id, customer.id, now)));
      if (comeback) (await (db.prepare('UPDATE offers SET returned_at=? WHERE cafe_id=? AND id=?').run(now, cafe.id, comeback.id)));
      app.locals.broadcast(cafe.id, 'orders', { orderId, status: 'new' });
      res.status(201).json({ order_id: orderId, amount, currency: cafe.currency, customer_token: customerToken, customer_name: customer.name, message: 'Order sent to the cafe.' });
    } catch (error) { next(error); }
  });
  app.get('/api/public/:slug/orders/:orderId', async (req,res) => {
    const cafe=(await (cafeBySlug(db,req.params.slug)));
    if(!cafe)return res.status(404).json({error:'Cafe not found.'});
    res.setHeader('Cache-Control','no-store');
    const customer=(await (customerTokenFromRequest(db,cafe.id,String(req.get('X-Cafe-Token')||''))));
    if(!customer)return res.status(401).json({error:'Open this order on the device with your cafe card.'});
    const order=(await (db.prepare('SELECT id,table_number,items,amount,status,created_at,updated_at,completed_at FROM orders WHERE cafe_id=? AND customer_id=? AND id=?').get(cafe.id,customer.id,req.params.orderId)));
    if(!order)return res.status(404).json({error:'Order not found.'});
    res.json({...order,items:JSON.parse(order.items),currency:cafe.currency});
  });
  app.post('/api/public/:slug/reviews/click', async (req, res) => {
    const cafe = (await (cafeBySlug(db, req.params.slug)));
    if (!cafe) return res.status(404).json({ error: 'Cafe not found.' });
    const customer = (await (customerTokenFromRequest(db, cafe.id, String(req.body?.token || ''))));
    if (!customer) return res.status(401).json({ error: 'Sign in to your customer card on this device first.' });
    if (!cafe.google_review_link) return res.status(409).json({ error: 'This cafe has not added its Google review link yet.' });
    const review = (await (db.prepare('SELECT id FROM reviews WHERE cafe_id=? AND customer_id=? ORDER BY scheduled_at DESC LIMIT 1').get(cafe.id, customer.id)));
    const now = isoNow();
    if (review) (await (db.prepare("UPDATE reviews SET clicked_at=?,status='clicked' WHERE cafe_id=? AND id=?").run(now, cafe.id, review.id)));
    else (await (db.prepare("INSERT INTO reviews(id,cafe_id,customer_id,channel,scheduled_at,requested_at,clicked_at,status) VALUES(?,?,?,'google',?,?,?,'clicked')").run(uid(), cafe.id, customer.id, now, now, now)));
    res.json({ url: cafe.google_review_link });
  });

  app.get('/api/owner/dashboard', owner(async (req, res) => {
    const now = new Date(); const range = calendarRange(now, req.cafe.timezone);
    const summary = (await (db.prepare(`SELECT
      SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) AS orders,
      SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) AS revenue,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM orders WHERE cafe_id=? AND created_at>=? AND created_at<?`).get(req.owner.cafe_id, range.today, range.tomorrow)));
    const active = (await (db.prepare(`SELECT COUNT(DISTINCT customer_id) AS total FROM orders WHERE cafe_id=? AND status='completed' AND created_at>=? AND created_at<?`).get(req.owner.cafe_id, range.month, range.nextMonth))).total;
    const repeat = (await (db.prepare(`SELECT COUNT(*) AS total FROM (SELECT customer_id FROM orders WHERE cafe_id=? AND status='completed' AND created_at>=? AND created_at<? GROUP BY customer_id HAVING COUNT(*)>=2) AS repeat_customers`).get(req.owner.cafe_id, range.month, range.nextMonth))).total;
    const orderRows = (await (db.prepare(`SELECT o.*,c.name AS customer_name FROM orders o JOIN customers c ON c.cafe_id=o.cafe_id AND c.id=o.customer_id
      WHERE o.cafe_id=? AND o.created_at>=? AND o.created_at<? AND o.status!='cancelled' ORDER BY o.created_at DESC LIMIT 60`).all(req.owner.cafe_id, range.today, range.tomorrow)));
    const topCounts = new Map();
    const weekRows = (await (db.prepare("SELECT items FROM orders WHERE cafe_id=? AND status='completed' AND created_at>=? AND created_at<?").all(req.owner.cafe_id, range.week, range.tomorrow)));
    for (const row of weekRows) for (const item of JSON.parse(row.items)) topCounts.set(item.name, (topCounts.get(item.name) || 0) + item.quantity);
    const topItems = [...topCounts].map(([name, count]) => ({ name, count })).sort((a,b) => b.count-a.count).slice(0,5);
    const month = range.month; const nextMonth = range.nextMonth;
    const stats = {
      rewards_redeemed: (await (db.prepare("SELECT COUNT(*) AS total FROM rewards WHERE cafe_id=? AND status='redeemed' AND redeemed_at>=? AND redeemed_at<?").get(req.owner.cafe_id, month, nextMonth))).total,
      review_clicks: (await (db.prepare("SELECT COUNT(*) AS total FROM reviews WHERE cafe_id=? AND clicked_at>=? AND clicked_at<?").get(req.owner.cafe_id, month, nextMonth))).total,
      winbacks: (await (db.prepare("SELECT COUNT(*) AS total FROM offers WHERE cafe_id=? AND type='comeback' AND returned_at>=? AND returned_at<?").get(req.owner.cafe_id, month, nextMonth))).total,
      customers: (await (db.prepare('SELECT COUNT(*) AS total FROM customers WHERE cafe_id=?').get(req.owner.cafe_id))).total,
    };
    const queued = (await (db.prepare(`SELECT o.id,o.customer_id,o.type,o.message,o.sent_at,o.expires_at,o.delivery_status,o.delivery_error,
      c.name AS customer_name,c.whatsapp_number,c.favourite_item,r.code
      FROM offers o JOIN customers c ON c.cafe_id=o.cafe_id AND c.id=o.customer_id
      LEFT JOIN rewards r ON r.cafe_id=o.cafe_id AND r.id=o.reward_id
      WHERE o.cafe_id=? AND o.delivery_status IN ('queued','failed') ORDER BY o.sent_at LIMIT 8`).all(req.owner.cafe_id)));
    res.json({
      date: localDateKey(now, req.cafe.timezone),
      summary: { orders: summary.orders || 0, revenue: summary.revenue || 0, average_order: summary.completed ? summary.revenue / summary.completed : 0, repeat_percent: active ? Math.round((repeat / active) * 100) : 0, active_customers: active, ...stats },
      orders: orderRows.map((row) => ({ ...row, items: JSON.parse(row.items) })), top_items: topItems, outbox: queued,
    });
  }));

  app.get('/api/owner/orders/events', owner((req, res) => {
    const cafeId = req.owner.cafe_id;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.(); res.write('event: connected\ndata: {}\n\n');
    if (!listeners.has(cafeId)) listeners.set(cafeId, new Set());
    listeners.get(cafeId).add(res);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25000);
    req.on('close', () => { clearInterval(heartbeat); listeners.get(cafeId)?.delete(res); });
  }));
  app.patch('/api/owner/orders/:id/status', owner(async (req, res, next) => {
    try {
      const status = z.enum(['preparing','completed','cancelled']).parse(req.body?.status);
      const cafeId = req.owner.cafe_id; const now = isoNow();
      const result = (await (inTransaction(db, async (tx) => {
        const order = await tx.prepare('SELECT * FROM orders WHERE cafe_id=? AND id=?').get(cafeId, req.params.id);
        if (!order) { const error = new Error('Order not found.'); error.status = 404; throw error; }
        if (order.status === 'completed' || order.status === 'cancelled') {
          if (order.status !== status) { const error = new Error('A completed or cancelled order cannot be changed.'); error.status = 409; throw error; }
          return { order, stamps: 0, reward: null };
        }
        await tx.prepare('UPDATE orders SET status=?,updated_at=?,completed_at=? WHERE cafe_id=? AND id=?').run(status, now, status === 'completed' ? now : null, cafeId, order.id);
        if (status !== 'completed') return { order: { ...order, status }, stamps: 0, reward: null };
        const items = JSON.parse(order.items);
        const customer = await tx.prepare('SELECT * FROM customers WHERE cafe_id=? AND id=?').get(cafeId, order.customer_id);
        const visitCount = customer.visit_count + 1;
        const favoriteCounts=new Map();
        const completedOrders=await tx.prepare("SELECT items FROM orders WHERE cafe_id=? AND customer_id=? AND status='completed' ORDER BY completed_at,created_at").all(cafeId,customer.id);
        completedOrders.forEach((row,orderIndex)=>{for(const item of JSON.parse(row.items)){const current=favoriteCounts.get(item.name)||{count:0,last:0};favoriteCounts.set(item.name,{count:current.count+item.quantity,last:orderIndex});}});
        const favoriteItem=[...favoriteCounts.entries()].sort((a,b)=>b[1].count-a[1].count||b[1].last-a[1].last)[0]?.[0]||customer.favourite_item;
        await tx.prepare('UPDATE customers SET visit_count=?,last_visit_at=?,favourite_item=? WHERE cafe_id=? AND id=?').run(visitCount, now, favoriteItem, cafeId, customer.id);
        let stampAwarded = 0; let reward = null;
        if (items.some((item) => item.earns_stamp)) {
          const stampInsert = await tx.prepare('INSERT INTO stamps(id,cafe_id,customer_id,order_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').run(uid(), cafeId, customer.id, order.id, now);
          stampAwarded = stampInsert.changes ? 1 : 0;
          const unassigned = await tx.prepare('SELECT id FROM stamps WHERE cafe_id=? AND customer_id=? AND reward_id IS NULL ORDER BY created_at,id').all(cafeId, customer.id);
          if (unassigned.length >= req.cafe.stamp_target) {
            const rewardId = uid();
            const code = await mintUniqueCode(tx, cafeId, 'FREE');
            await tx.prepare(`INSERT INTO rewards(id,cafe_id,customer_id,code,type,status,stamp_target,created_at)
              VALUES(?,?,?,?,'coffee','available',?,?)`).run(rewardId, cafeId, customer.id, code, req.cafe.stamp_target, now);
            for (const stamp of unassigned.slice(0, req.cafe.stamp_target)) await tx.prepare('UPDATE stamps SET reward_id=? WHERE cafe_id=? AND id=?').run(rewardId, cafeId, stamp.id);
            reward = { id: rewardId, code, type: 'coffee', status: 'available' };
          }
        }
        if (visitCount === 2 && customer.marketing_consent && !(await tx.prepare('SELECT 1 FROM reviews WHERE cafe_id=? AND customer_id=?').get(cafeId, customer.id))) {
          const scheduled = new Date(Date.now() + 2 * 3600000).toISOString();
          await tx.prepare("INSERT INTO reviews(id,cafe_id,customer_id,channel,scheduled_at,status) VALUES(?,?,?,'google',?,'queued')").run(uid(), cafeId, customer.id, scheduled);
        }
        return { order: { ...order, status }, stamps: stampAwarded, reward };
      })));
      app.locals.broadcast(cafeId, 'orders', { orderId: req.params.id, status, stamps: result.stamps, reward: result.reward });
      res.json({ ok: true, ...result });
    } catch (error) { next(error); }
  }));
  app.get('/api/owner/customers', owner(async (req, res) => {
    const rows = (await (db.prepare(`SELECT c.*,COUNT(DISTINCT o.id) AS orders_count,
      (SELECT COUNT(*) FROM stamps s WHERE s.cafe_id=c.cafe_id AND s.customer_id=c.id AND s.reward_id IS NULL) AS stamp_progress,
      (SELECT COUNT(*) FROM rewards r WHERE r.cafe_id=c.cafe_id AND r.customer_id=c.id AND r.status='available') AS available_rewards
      FROM customers c LEFT JOIN orders o ON o.cafe_id=c.cafe_id AND o.customer_id=c.id
      WHERE c.cafe_id=? GROUP BY c.cafe_id,c.id ORDER BY c.last_visit_at DESC,c.created_at DESC`).all(req.owner.cafe_id)));
    res.json({ customers: rows });
  }));
  app.delete('/api/owner/customers/:id', owner(async (req, res) => {
    const result = (await (db.prepare('DELETE FROM customers WHERE cafe_id=? AND id=?').run(req.owner.cafe_id, req.params.id)));
    if (!result.changes) return res.status(404).json({ error: 'Customer not found.' });
    res.json({ ok: true });
  }));
  app.get('/api/owner/comeback', owner(async (req, res) => {
    const requested = Number(req.query.days || req.cafe.comeback_days);
    const days = [21,30,60].includes(requested) ? requested : req.cafe.comeback_days;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const customers = (await (db.prepare(`SELECT c.id,c.name,c.whatsapp_number,c.favourite_item,c.last_visit_at,c.visit_count,c.marketing_consent
      FROM customers c WHERE c.cafe_id=? AND c.marketing_consent=1 AND c.last_visit_at < ?
      AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.cafe_id=c.cafe_id AND o.customer_id=c.id AND o.type='comeback' AND o.sent_at>=? AND o.delivery_status IN ('queued','opened','sent'))
      ORDER BY c.last_visit_at ASC`).all(req.owner.cafe_id, cutoff, new Date(Date.now() - 14 * 86400000).toISOString()))).map((customer) => ({
        ...customer,
        days_away: Math.floor((Date.now() - new Date(customer.last_visit_at).getTime()) / 86400000),
      }));
    res.json({ days, customers });
  }));
  app.post('/api/owner/comeback/:customerId/send', owner(async (req, res, next) => {
    try {
      const cafe = req.cafe; const customer = (await (db.prepare('SELECT * FROM customers WHERE cafe_id=? AND id=?').get(req.owner.cafe_id, req.params.customerId)));
      if (!customer) return res.status(404).json({ error: 'Customer not found.' });
      if (!customer.marketing_consent) return res.status(409).json({ error: 'This customer has not agreed to offers.' });
      const recent = (await (db.prepare("SELECT 1 FROM offers WHERE cafe_id=? AND customer_id=? AND type='comeback' AND sent_at>=? AND delivery_status IN ('queued','opened','sent')").get(cafe.id, customer.id, new Date(Date.now()-14*86400000).toISOString())));
      if (recent) return res.status(409).json({ error: 'This customer received an offer within the last 14 days.' });
      const key=`manual-comeback:${customer.id}:${isoNow()}`;const prepared=(await (createManualComeback(customer,cafe,key)));
      let deliveryStatus='queued';let deliveryError='';
      try{deliveryStatus=await deliverOffer(db,cafe,prepared.offer,customer,'comeback');}catch(error){deliveryStatus='failed';deliveryError=error.message.slice(0,500);}
      (await (db.prepare('UPDATE offers SET delivery_status=?,delivery_error=? WHERE cafe_id=? AND id=?').run(deliveryStatus,deliveryError,cafe.id,prepared.offer.id)));
      res.status(201).json({ offer:{...prepared.offer,delivery_status:deliveryStatus}, customer: { id: customer.id, name: customer.name, phone: customer.whatsapp_number }, code:prepared.code, message:prepared.message, channel:cafe.messaging_channel });
    } catch(error) { next(error); }
  }));
  app.post('/api/owner/comeback/send-all', owner(async (req,res,next) => {
    try {
      const cafe=req.cafe;const requested=Number(req.body?.days||cafe.comeback_days);const days=[21,30,60].includes(requested)?requested:cafe.comeback_days;
      const cutoff=new Date(Date.now()-days*86400000).toISOString();const cooldown=new Date(Date.now()-14*86400000).toISOString();const now=isoNow();
      const customers=(await (db.prepare(`SELECT c.* FROM customers c WHERE c.cafe_id=? AND c.marketing_consent=1 AND c.last_visit_at<?
        AND NOT EXISTS(SELECT 1 FROM offers o WHERE o.cafe_id=c.cafe_id AND o.customer_id=c.id AND o.type='comeback' AND o.sent_at>=? AND o.delivery_status IN ('queued','opened','sent')) ORDER BY c.last_visit_at ASC`).all(cafe.id,cutoff,cooldown)));
      const results=[];
      for(const customer of customers){
        const prepared=(await (createManualComeback(customer,cafe,`manual-comeback:${customer.id}:${now}`)));let deliveryStatus='queued';let deliveryError='';
        try{deliveryStatus=await deliverOffer(db,cafe,prepared.offer,customer,'comeback');}catch(error){deliveryStatus='failed';deliveryError=error.message.slice(0,500);}
        (await (db.prepare('UPDATE offers SET delivery_status=?,delivery_error=? WHERE cafe_id=? AND id=?').run(deliveryStatus,deliveryError,cafe.id,prepared.offer.id)));
        results.push({id:prepared.offer.id,customer_id:customer.id,customer_name:customer.name,customer_phone:customer.whatsapp_number,code:prepared.code,message:prepared.message,delivery_status:deliveryStatus,delivery_error:deliveryError});
      }
      res.status(201).json({days,prepared:results.length,sent:results.filter((item)=>item.delivery_status==='sent').length,queued:results.filter((item)=>item.delivery_status==='queued').length,failed:results.filter((item)=>item.delivery_status==='failed').length,offers:results});
    }catch(error){next(error);}
  }));
  app.post('/api/owner/offers/:id/open', owner(async (req,res) => {
    const offer = (await (db.prepare(`SELECT o.*,c.whatsapp_number,c.name AS customer_name FROM offers o JOIN customers c ON c.cafe_id=o.cafe_id AND c.id=o.customer_id WHERE o.cafe_id=? AND o.id=?`).get(req.owner.cafe_id,req.params.id)));
    if (!offer) return res.status(404).json({error:'Offer not found.'});
    if (!['queued','failed'].includes(offer.delivery_status)) return res.status(409).json({error:'This message has already been opened or sent.'});
    const channel = req.cafe.messaging_channel === 'sms' ? 'sms' : 'whatsapp';
    const destination = channel === 'whatsapp' ? `https://wa.me/${offer.whatsapp_number.replace('+','')}?text=${encodeURIComponent(offer.message)}` : `sms:${offer.whatsapp_number}?body=${encodeURIComponent(offer.message)}`;
    (await (db.prepare("UPDATE offers SET delivery_status='opened',delivery_error='' WHERE cafe_id=? AND id=?").run(req.owner.cafe_id,offer.id)));
    if(offer.type==='review')(await (db.prepare("UPDATE reviews SET requested_at=?,status='sent' WHERE cafe_id=? AND customer_id=? AND status='queued'").run(isoNow(),req.owner.cafe_id,offer.customer_id)));
    res.json({url:destination,delivery_status:'opened'});
  }));
  app.post('/api/owner/rewards/:id/redeem', owner(async (req,res) => {
    const reward = (await (db.prepare("SELECT * FROM rewards WHERE cafe_id=? AND id=? AND status='available'").get(req.owner.cafe_id,req.params.id)));
    if (!reward) return res.status(404).json({error:'This reward is not available to redeem.'});
    if (reward.expires_at && reward.expires_at <= isoNow()) {
      (await (db.prepare("UPDATE rewards SET status='expired' WHERE cafe_id=? AND id=?").run(req.owner.cafe_id,reward.id)));
      return res.status(409).json({error:'This reward has expired.'});
    }
    (await (db.prepare("UPDATE rewards SET status='redeemed',redeemed_at=? WHERE cafe_id=? AND id=?").run(isoNow(),req.owner.cafe_id,reward.id)));
    res.json({ok:true,redeemed_at:isoNow()});
  }));
  app.get('/api/owner/rewards', owner(async (req,res) => {
    const rewards = (await (db.prepare(`SELECT r.*,c.name AS customer_name FROM rewards r JOIN customers c ON c.cafe_id=r.cafe_id AND c.id=r.customer_id
      WHERE r.cafe_id=? ORDER BY r.created_at DESC LIMIT 200`).all(req.owner.cafe_id)));
    res.json({rewards});
  }));
  app.get('/api/owner/reviews', owner(async (req,res) => {
    const reviews = (await (db.prepare(`SELECT r.*,c.name AS customer_name,c.whatsapp_number FROM reviews r JOIN customers c ON c.cafe_id=r.cafe_id AND c.id=r.customer_id
      WHERE r.cafe_id=? ORDER BY r.scheduled_at DESC LIMIT 100`).all(req.owner.cafe_id)));
    res.json({reviews});
  }));
  app.get('/api/owner/menu', owner(async (req,res) => res.json({items:(await (db.prepare('SELECT * FROM menu_items WHERE cafe_id=? ORDER BY sort_order,category,name').all(req.owner.cafe_id)))})));
  const menuSchema = z.object({ name:z.string().trim().min(1).max(90), category:z.string().trim().min(1).max(50), price:z.coerce.number().min(0).max(99999), earns_stamp:z.boolean().default(true), is_available:z.boolean().default(true), image_url:z.string().trim().max(500).default('') });
  app.post('/api/owner/menu', owner(async (req,res,next) => {
    try {
      const item=parseBody(menuSchema,req.body);const id=uid();
      const sort=((await (db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM menu_items WHERE cafe_id=?').get(req.owner.cafe_id))).n);
      (await (db.prepare('INSERT INTO menu_items(id,cafe_id,name,category,price,earns_stamp,is_available,image_url,sort_order) VALUES(?,?,?,?,?,?,?,?,?)').run(id,req.owner.cafe_id,item.name,item.category,item.price,Number(item.earns_stamp),Number(item.is_available),item.image_url,sort)));
      app.locals.broadcast(req.owner.cafe_id,'menu',{itemId:id});res.status(201).json({item:{id,...item,sort_order:sort}});
    } catch(error){next(error);}
  }));
  app.patch('/api/owner/menu/:id', owner(async (req,res,next) => {
    try {
      const item=parseBody(menuSchema,req.body);const result=(await (db.prepare('UPDATE menu_items SET name=?,category=?,price=?,earns_stamp=?,is_available=?,image_url=? WHERE cafe_id=? AND id=?').run(item.name,item.category,item.price,Number(item.earns_stamp),Number(item.is_available),item.image_url,req.owner.cafe_id,req.params.id)));
      if(!result.changes)return res.status(404).json({error:'Menu item not found.'});app.locals.broadcast(req.owner.cafe_id,'menu',{itemId:req.params.id});res.json({ok:true});
    }catch(error){next(error);}
  }));
  app.delete('/api/owner/menu/:id', owner(async (req,res) => {
    const used=(await (db.kind === 'postgres'
      ? db.prepare("SELECT COUNT(*) AS count FROM orders o WHERE o.cafe_id=? AND o.status!='cancelled' AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.items::jsonb) AS line WHERE line->>'menu_item_id'=?)").get(req.owner.cafe_id,req.params.id)
      : db.prepare("SELECT COUNT(*) AS count FROM orders WHERE cafe_id=? AND status!='cancelled' AND EXISTS(SELECT 1 FROM json_each(orders.items) WHERE json_extract(json_each.value,'$.menu_item_id')=?)").get(req.owner.cafe_id,req.params.id))).count;
    if(used){const result=(await (db.prepare('UPDATE menu_items SET is_available=0 WHERE cafe_id=? AND id=?').run(req.owner.cafe_id,req.params.id)));if(!result.changes)return res.status(404).json({error:'Menu item not found.'});return res.json({ok:true,archived:true});}
    const result=(await (db.prepare('DELETE FROM menu_items WHERE cafe_id=? AND id=?').run(req.owner.cafe_id,req.params.id)));if(!result.changes)return res.status(404).json({error:'Menu item not found.'});res.json({ok:true,archived:false});
  }));
  const settingsSchema = z.object({
    name:z.string().trim().min(2).max(90), logo_url:z.string().trim().max(500).default(''), accent_colour:z.string().regex(/^#[0-9a-fA-F]{6}$/), currency:z.string().regex(/^[A-Z]{3}$/), timezone:timezoneSchema, google_review_link:z.string().trim().max(500).refine((v)=>!v||/^https:\/\//i.test(v),'Review link must use HTTPS.'), stamp_target:z.coerce.number().int().min(3).max(20), comeback_days:z.coerce.number().int().min(7).max(180), messaging_channel:z.enum(['whatsapp','sms']), messaging_from:senderSchema, dlt_pe_id:z.string().trim().max(64).regex(/^(\d*)$/,'DLT PE ID should contain digits only.').default(''), comeback_dlt_template_id:z.string().trim().max(64).regex(/^(\d*)$/,'DLT template ID should contain digits only.').default(''), birthday_dlt_template_id:z.string().trim().max(64).regex(/^(\d*)$/,'DLT template ID should contain digits only.').default(''), review_dlt_template_id:z.string().trim().max(64).regex(/^(\d*)$/,'DLT template ID should contain digits only.').default(''), comeback_template:z.string().max(1200), birthday_template:z.string().max(1200), review_template:z.string().max(1200), comeback_template_sid:z.string().trim().max(64).default(''), birthday_template_sid:z.string().trim().max(64).default(''), review_template_sid:z.string().trim().max(64).default(''), public_url:z.string().trim().max(500).refine((v)=>!v||/^https?:\/\//i.test(v),'Public URL must start with http:// or https://'),
  }).superRefine((settings, context) => {
    const sender = settings.messaging_from;
    if (!sender) return;
    const phone = /^\+[1-9]\d{7,14}$/i.test(sender);
    const whatsapp = /^whatsapp:\+[1-9]\d{7,14}$/i.test(sender);
    const smsAlphanumeric = /^[A-Za-z0-9][A-Za-z0-9 .+&_-]{0,10}$/.test(sender);
    const valid = settings.messaging_channel === 'whatsapp'
      ? phone || whatsapp
      : phone || smsAlphanumeric;
    if (!valid) context.addIssue({ code: 'custom', path: ['messaging_from'], message: settings.messaging_channel === 'whatsapp'
      ? 'For WhatsApp, enter an E.164 number, optionally prefixed with whatsapp:.'
      : 'For SMS, enter an E.164 number or a supported alphanumeric Sender ID.' });
  });
  app.patch('/api/owner/settings', owner(async (req,res,next) => {
    try {
      const fields=parseBody(settingsSchema,req.body);
      const updates={...fields,comeback_template_sid:fields.comeback_template_sid,birthday_template_sid:fields.birthday_template_sid,review_template_sid:fields.review_template_sid};
      const columns={name:'name',logo_url:'logo_url',accent_colour:'accent_colour',currency:'currency',timezone:'timezone',google_review_link:'google_review_link',stamp_target:'stamp_target',comeback_days:'comeback_days',messaging_channel:'messaging_channel',messaging_from:'messaging_from',dlt_pe_id:'dlt_pe_id',comeback_dlt_template_id:'comeback_dlt_template_id',birthday_dlt_template_id:'birthday_dlt_template_id',review_dlt_template_id:'review_dlt_template_id',comeback_template:'comeback_template',birthday_template:'birthday_template',review_template:'review_template',comeback_template_sid:'comeback_template_sid',birthday_template_sid:'birthday_template_sid',review_template_sid:'review_template_sid',public_url:'public_url'};
      const entries=Object.entries(columns);(await (db.prepare(`UPDATE cafes SET ${entries.map(([,column])=>`${column}=?`).join(',')} WHERE id=?`).run(...entries.map(([key])=>updates[key]),req.owner.cafe_id)));
      res.json({cafe:ownerCafe((await (db.prepare('SELECT * FROM cafes WHERE id=?').get(req.owner.cafe_id))))});
    }catch(error){next(error);}
  }));
  app.get('/api/owner/export/customers.csv', owner(async (req,res) => {
    const rows=(await (db.prepare('SELECT name,whatsapp_number,birthday_day,birthday_month,visit_count,last_visit_at,favourite_item,marketing_consent,consent_at,created_at FROM customers WHERE cafe_id=? ORDER BY name').all(req.owner.cafe_id)));
    const escape=(value)=>{let text=String(value??'');if(/^[\t\r\n ]*[=+\-@]/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;};
    res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="cafeloop-customers.csv"');
    res.send(['name,phone,birthday_day,birthday_month,visits,last_visit,favourite_item,marketing_consent,consent_at,created_at',...rows.map(row=>Object.values(row).map(escape).join(','))].join('\r\n'));
  }));

  app.post('/api/webhooks/twilio/inbound', express.urlencoded({ extended: false }), async (req,res,next) => {
    try {
      const authToken=process.env.TWILIO_AUTH_TOKEN;
      if(!authToken)return res.status(503).type('text/plain').send('Twilio inbound is not configured.');
      const signature=String(req.headers['x-twilio-signature']||'');
      const url=`${process.env.APP_PUBLIC_URL || `${req.protocol}://${req.get('host')}`}${req.originalUrl}`;
      const material=url+Object.keys(req.body).sort().map((key)=>key+String(req.body[key])).join('');
      const expected=crypto.createHmac('sha1',authToken).update(material).digest('base64');
      if(!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return res.status(403).type('text/plain').send('Invalid Twilio signature.');
      const text=String(req.body?.Body||'').trim().toUpperCase();
      if(['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'].includes(text)){
        const phone=String(req.body?.From||'').replace(/^whatsapp:/i,'').replace(/[^+\d]/g,'');
        if(phonePattern.test(phone))(await (db.prepare('UPDATE customers SET marketing_consent=0,opted_out_at=? WHERE whatsapp_number=?').run(isoNow(),phone)));
      }
      res.type('text/xml').send('<Response></Response>');
    }catch(error){next(error);}
  });

  const dist=path.resolve(here,'../dist');
  if(options.serveStatic !== false && fs.existsSync(dist)){
    app.use(express.static(dist));
    app.get('*path',(req,res,next)=>req.path.startsWith('/api/')?next():res.sendFile(path.join(dist,'index.html')));
  }
  app.use((error,_req,res,_next)=>{
    const status=error.status||((error instanceof z.ZodError)?400:500);
    if(status>=500)console.error(error);
    res.status(status).json({error:status>=500?'Something went wrong. Please try again.':error.message||'Invalid request.'});
  });
  app.locals.close=()=>db.close();
  return app;
}
