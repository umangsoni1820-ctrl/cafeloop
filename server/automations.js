import crypto from 'node:crypto';

const nowIso = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const code = () => crypto.randomBytes(2).toString('hex').toUpperCase();
const isConfigured = (cafe) => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (cafe.messaging_from || process.env.TWILIO_FROM));

function dateKey(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function clock(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(fields.hour) * 60 + Number(fields.minute);
}
function interpolate(template, values) {
  return template.replace(/\{([a-z_]+)\}/gi, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
function formatDate(value, timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(new Date(value));
}
async function withTransaction(db, callback) {
  if (db.kind === 'postgres') return db.transaction(callback);
  await db.exec('BEGIN IMMEDIATE');
  try { const value = await callback(db); await db.exec('COMMIT'); return value; }
  catch (error) { await db.exec('ROLLBACK'); throw error; }
}

export async function deliver(db, cafe, offer, customer, type, { automated = false } = {}) {
  if (automated && process.env.TWILIO_AUTOMATIONS_ENABLED !== 'true') return 'queued';
  const settingsKey = `${type}_template_sid`;
  const contentSid = cafe[settingsKey];
  if (!isConfigured(cafe) || (cafe.messaging_channel === 'whatsapp' && !contentSid)) return 'queued';
  const account = process.env.TWILIO_ACCOUNT_SID;
  const sender = cafe.messaging_from || process.env.TWILIO_FROM;
  const from = cafe.messaging_channel === 'whatsapp' && !sender.toLowerCase().startsWith('whatsapp:')
    ? `whatsapp:${sender}` : sender;
  const to = cafe.messaging_channel === 'whatsapp' && !customer.whatsapp_number.toLowerCase().startsWith('whatsapp:')
    ? `whatsapp:${customer.whatsapp_number}` : customer.whatsapp_number;
  const form = new URLSearchParams({ To: to, From: from });
  if (cafe.messaging_channel === 'whatsapp') {
    const variables = type === 'comeback'
      ? { 1: customer.name, 2: cafe.name, 3: customer.favourite_item || 'favourite coffee', 4: offer.reward_code || '', 5: formatDate(offer.expires_at, cafe.timezone) }
      : type === 'birthday'
        ? { 1: customer.name, 2: customer.favourite_item || 'coffee', 3: cafe.name, 4: offer.reward_code || '', 5: formatDate(offer.expires_at, cafe.timezone) }
        : { 1: cafe.name, 2: customer.name, 3: cafe.google_review_link };
    form.set('ContentSid', contentSid);
    form.set('ContentVariables', JSON.stringify(variables));
  } else {
    form.set('Body', offer.message);
    if (/^\+91\d{10}$/.test(customer.whatsapp_number)) {
      const entityId = cafe.dlt_pe_id;
      const templateId = cafe[`${type}_dlt_template_id`];
      if (!entityId || !templateId) return 'queued';
      form.set('DltPEId', entityId);
      form.set('DltTemplateId', templateId);
    }
  }
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${account}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Twilio returned ${response.status}: ${details.slice(0, 400)}`);
  }
  return 'sent';
}

async function createTriggeredOffer(db, cafe, customer, type, day) {
  const key = `${type}:${customer.id}:${day}`;
  if ((await (db.prepare('SELECT 1 FROM offers WHERE cafe_id=? AND idempotency_key=?').get(cafe.id, key)))) return;
  const now = nowIso();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  const prefix = type === 'birthday' ? 'BDAY' : 'COME';
  const rewardId = id();
  const rewardCode = `${prefix}-${code()}`;
  const message = type === 'birthday'
    ? interpolate(cafe.birthday_template, { name: customer.name, favourite_item: customer.favourite_item || 'coffee', cafe: cafe.name, code: rewardCode, expiry: formatDate(expires, cafe.timezone) })
    : interpolate(cafe.comeback_template, { name: customer.name, cafe: cafe.name, favourite_item: customer.favourite_item || 'favourite coffee', code: rewardCode, expiry: formatDate(expires, cafe.timezone) });
  const offerId = id();
  (await (withTransaction(db, async (tx) => {
    await tx.prepare("INSERT INTO rewards(id,cafe_id,customer_id,code,type,status,expires_at,created_at) VALUES(?,?,?,?,?,'available',?,?)")
      .run(rewardId, cafe.id, customer.id, rewardCode, type, expires, now);
    await tx.prepare("INSERT INTO offers(id,cafe_id,customer_id,reward_id,type,message,idempotency_key,sent_at,expires_at,delivery_status) VALUES(?,?,?,?,?,?,?,?,?,'queued')")
      .run(offerId, cafe.id, customer.id, rewardId, type, message, key, now, expires);
  })));
  const offer = { ...(await (db.prepare('SELECT * FROM offers WHERE cafe_id=? AND id=?').get(cafe.id, offerId))), reward_code: rewardCode };
  try {
    const status = await deliver(db, cafe, offer, customer, type, { automated: true });
    (await (db.prepare('UPDATE offers SET delivery_status=?,delivery_error=? WHERE cafe_id=? AND id=?').run(status, '', cafe.id, offer.id)));
  } catch (error) {
    (await (db.prepare("UPDATE offers SET delivery_status='failed',delivery_error=? WHERE cafe_id=? AND id=?").run(error.message.slice(0,500), cafe.id, offer.id)));
  }
}

async function processReviews(db, now) {
  const due = (await (db.prepare(`SELECT r.*,c.name,c.whatsapp_number,c.favourite_item,c.marketing_consent,f.name AS cafe_name,
      f.messaging_channel,f.review_template,f.review_template_sid,f.timezone,f.google_review_link,
      f.dlt_pe_id,f.review_dlt_template_id
    FROM reviews r JOIN customers c ON c.cafe_id=r.cafe_id AND c.id=r.customer_id
    JOIN cafes f ON f.id=r.cafe_id WHERE r.status='queued' AND r.scheduled_at<=?`).all(now.toISOString())));
  for (const review of due) {
    if (!review.marketing_consent) {
      (await (db.prepare("UPDATE reviews SET status='skipped' WHERE cafe_id=? AND id=?").run(review.cafe_id,review.id)));
      continue;
    }
    if(!review.google_review_link)continue;
    const cafe = { id: review.cafe_id, name: review.cafe_name, timezone: review.timezone, messaging_channel: review.messaging_channel, review_template: review.review_template, review_template_sid: review.review_template_sid, google_review_link: review.google_review_link, dlt_pe_id: review.dlt_pe_id, review_dlt_template_id: review.review_dlt_template_id };
    const customer = { id: review.customer_id, name: review.name, whatsapp_number: review.whatsapp_number, favourite_item: review.favourite_item };
    const key = `review:${review.customer_id}`;
    let offer = (await (db.prepare('SELECT * FROM offers WHERE cafe_id=? AND idempotency_key=?').get(cafe.id,key)));
    if (!offer) {
      const message=interpolate(cafe.review_template,{cafe:cafe.name,name:customer.name,review_link:cafe.google_review_link});
      const offerId=id();
      (await (db.prepare("INSERT INTO offers(id,cafe_id,customer_id,type,message,idempotency_key,sent_at,delivery_status) VALUES(?,?,?,'review',?,?,?,'queued')").run(offerId,cafe.id,customer.id,message,key,now.toISOString())));
      offer={...(await (db.prepare('SELECT * FROM offers WHERE cafe_id=? AND id=?').get(cafe.id,offerId))),message};
    }
    try {
      const status=await deliver(db,cafe,offer,customer,'review',{automated:true});
      (await (db.prepare('UPDATE offers SET delivery_status=?,delivery_error=? WHERE cafe_id=? AND id=?').run(status,'',cafe.id,offer.id)));
      if(status==='sent')(await (db.prepare("UPDATE reviews SET requested_at=?,status='sent' WHERE cafe_id=? AND id=?").run(now.toISOString(),cafe.id,review.id)));
    }catch(error){
      (await (db.prepare("UPDATE offers SET delivery_status='failed',delivery_error=? WHERE cafe_id=? AND id=?").run(error.message.slice(0,500),cafe.id,offer.id)));
      (await (db.prepare("UPDATE reviews SET status='failed' WHERE cafe_id=? AND id=?").run(cafe.id,review.id)));
    }
  }
}

export async function processAutomations(db, now = new Date()) {
  (await (db.prepare("UPDATE rewards SET status='expired' WHERE status='available' AND expires_at IS NOT NULL AND expires_at<=?").run(now.toISOString())));
  const cafes = (await (db.prepare('SELECT * FROM cafes').all()));
  for (const cafe of cafes) {
    const day = dateKey(now,cafe.timezone);
    const minute = clock(now,cafe.timezone);
    if (minute >= 540) {
      const birthday = (await (db.prepare('SELECT * FROM customers WHERE cafe_id=? AND marketing_consent=1 AND birthday_month=? AND birthday_day=?').all(cafe.id,Number(day.slice(5,7)),Number(day.slice(8,10)))));
      for (const customer of birthday) await createTriggeredOffer(db,cafe,customer,'birthday',day);
    }
    if (minute >= 600) {
      const cutoff = new Date(now.getTime()-cafe.comeback_days*86400000).toISOString();
      const cooldown = new Date(now.getTime()-14*86400000).toISOString();
      const inactive = (await (db.prepare(`SELECT c.* FROM customers c WHERE c.cafe_id=? AND c.marketing_consent=1 AND c.last_visit_at IS NOT NULL AND c.last_visit_at<=?
        AND NOT EXISTS(SELECT 1 FROM offers o WHERE o.cafe_id=c.cafe_id AND o.customer_id=c.id AND o.type='comeback' AND o.sent_at>=? AND o.delivery_status IN ('queued','opened','sent'))`).all(cafe.id,cutoff,cooldown)));
      for (const customer of inactive) await createTriggeredOffer(db,cafe,customer,'comeback',day);
    }
  }
  await processReviews(db,now);
}

export function startAutomationScheduler(db, intervalMs = 60000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await processAutomations(db); }
    catch(error) { console.error('Automation run failed:',error); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick,intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
