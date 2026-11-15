import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { deliver as deliverTwilio, processAutomations } from '../server/automations.js';
import { money } from '../src/lib.js';

async function context(t) {
  const app = createApp({ databasePath: ':memory:' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
  });
  return { app, base };
}

async function request(ctx, route, { method='GET', body, cookie, headers:extraHeaders } = {}) {
  const headers = { ...(extraHeaders||{}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${ctx.base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function setupCafe(ctx, name='Test cafe', email=`owner-${Date.now()}@example.test`) {
  const result = await request(ctx, '/api/auth/setup', { method: 'POST', body: { cafeName: name, ownerEmail: email, password: 'cafe-loop-test-password', currency: 'USD', timezone: 'UTC' } });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  const cafe = result.data.cafe;
  const cookie = result.cookie;
  const settings = await request(ctx, '/api/owner/settings', { method: 'PATCH', cookie, body: {
    name: cafe.name, logo_url: '', accent_colour: '#2146b8', currency: 'USD', timezone: 'UTC',
    google_review_link: 'https://g.page/r/example-review', stamp_target: 5, comeback_days: 21,
    messaging_channel: 'whatsapp', comeback_template: cafe.comeback_template,
    birthday_template: cafe.birthday_template, review_template: cafe.review_template,
    comeback_template_sid: '', birthday_template_sid: '', review_template_sid: '', public_url: '',
    dlt_pe_id: '', comeback_dlt_template_id: '', birthday_dlt_template_id: '', review_dlt_template_id: '',
  } });
  assert.equal(settings.response.status, 200, JSON.stringify(settings.data));
  return { cafe, cookie };
}

test('Indian cafe defaults and rupee formatting use INR', async (t) => {
  const ctx = await context(t);
  const result = await request(ctx, '/api/auth/setup', { method: 'POST', body: {
    cafeName: 'The Leela', ownerEmail: 'owner@leela.example', password: 'cafe-loop-test-password',
  } });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.cafe.currency, 'INR');
  assert.equal(result.data.cafe.timezone, 'Asia/Kolkata');
  assert.equal(money(20, 'INR'), '₹20');
  assert.equal(money(20.5, 'INR'), '₹20.5');
});

test('development Vite setup origin is accepted while unrelated origins are rejected', async (t) => {
  const ctx = await context(t);
  const local = await request(ctx, '/api/auth/setup', { method: 'POST', headers: { Origin: 'http://localhost:5173' }, body: {} });
  assert.equal(local.response.status, process.env.NODE_ENV === 'production' ? 403 : 400);
  if (process.env.NODE_ENV !== 'production') assert.notEqual(local.data.error, 'This request origin is not allowed.');

  const external = await request(ctx, '/api/auth/setup', { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: {} });
  assert.equal(external.response.status, 403);
  assert.equal(external.data.error, 'This request origin is not allowed.');
});

test('owner setup, QR order, completion stamps, reward, review tap, and customer deletion', async (t) => {
  const ctx = await context(t);
  const { cafe, cookie } = await setupCafe(ctx);

  const empty = await request(ctx, '/api/owner/customers', { cookie });
  assert.equal(empty.data.customers.length, 0, 'A new cafe has no invented customer records.');
  const menuAdd = await request(ctx, '/api/owner/menu', { method: 'POST', cookie, body: { name: 'House latte', category: 'Coffee', price: 4.25, earns_stamp: true, is_available: true, image_url: '' } });
  assert.equal(menuAdd.response.status, 201, JSON.stringify(menuAdd.data));
  const menuItem = menuAdd.data.item;
  const publicMenu = await request(ctx, `/api/public/${cafe.slug}/menu`);
  assert.equal(publicMenu.data.items.length, 1);
  assert.equal(publicMenu.data.items[0].name, 'House latte');

  const rejected = await request(ctx, `/api/public/${cafe.slug}/order`, { method: 'POST', body: { table: 3, customer: { name: 'Rae Guest', phone: '+14155550123', marketing_consent: false }, items: [{ menu_item_id: 'not-a-menu-item', quantity: 1, note: '' }] } });
  assert.equal(rejected.response.status, 400);
  assert.equal((await request(ctx, '/api/owner/customers', { cookie })).data.customers.length, 0, 'Invalid menu lines do not create orphan customer records.');

  const placeOrder = async (token) => request(ctx, `/api/public/${cafe.slug}/order`, {
    method: 'POST', body: {
      table: 3, ...(token ? { customer_token: token } : { customer: { name: 'Rae Guest', phone: '+14155550123', marketing_consent: true } }),
      items: [{ menu_item_id: menuItem.id, quantity: 1, note: 'Oat milk' }], note: '',
    },
  });
  const first = await placeOrder();
  assert.equal(first.response.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.amount, 4.25);
  assert.ok(first.data.customer_token);
  const token = first.data.customer_token;
  const visibleOrder = await request(ctx, `/api/public/${cafe.slug}/orders/${first.data.order_id}`,{headers:{'X-Cafe-Token':token}});
  assert.equal(visibleOrder.data.status, 'new');
  assert.equal((await request(ctx, `/api/public/${cafe.slug}/orders/${first.data.order_id}`,{headers:{'X-Cafe-Token':'somebody-elses-token-value-long-enough'}})).response.status, 401);

  for (let visit = 0; visit < 5; visit += 1) {
    const order = visit === 0 ? first : await placeOrder(token);
    assert.equal(order.response.status, 201, JSON.stringify(order.data));
    const status = await request(ctx, `/api/owner/orders/${order.data.order_id}/status`, { method: 'PATCH', cookie, body: { status: 'completed' } });
    assert.equal(status.response.status, 200, JSON.stringify(status.data));
    assert.equal(status.data.stamps, 1);
    if (visit < 4) assert.equal(status.data.reward, null);
    else assert.equal(status.data.reward.type, 'coffee');
  }

  const card = await request(ctx, `/api/public/${cafe.slug}/card`,{headers:{'X-Cafe-Token':token}});
  assert.equal(card.data.customer.visit_count, 5);
  assert.equal(card.data.stamps, 5, 'The pending reward keeps the completed cycle visible until redeemed.');
  assert.equal(card.data.rewards.length, 1);
  const reviews = await request(ctx, '/api/owner/reviews', { cookie });
  assert.equal(reviews.data.reviews.length, 1, 'A consenting guest gets one review request after their second visit.');
  assert.equal(reviews.data.reviews[0].status, 'queued');
  const previousEnv={sid:process.env.TWILIO_ACCOUNT_SID,token:process.env.TWILIO_AUTH_TOKEN,from:process.env.TWILIO_FROM};
  delete process.env.TWILIO_ACCOUNT_SID;delete process.env.TWILIO_AUTH_TOKEN;delete process.env.TWILIO_FROM;
  try{await processAutomations(ctx.app.locals.db,new Date(Date.now()+3*3600000));}finally{
    for(const [key,value] of Object.entries({TWILIO_ACCOUNT_SID:previousEnv.sid,TWILIO_AUTH_TOKEN:previousEnv.token,TWILIO_FROM:previousEnv.from}))if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  const reviewOffer=ctx.app.locals.db.prepare("SELECT id FROM offers WHERE cafe_id=? AND type='review'").get(cafe.id);
  assert.ok(reviewOffer,'The delayed second-visit automation creates one queued review request.');
  const openedReview=await request(ctx,`/api/owner/offers/${reviewOffer.id}/open`,{method:'POST',cookie});
  assert.equal(openedReview.data.delivery_status,'opened');
  assert.match(openedReview.data.url,/wa\.me/);

  const reviewClick = await request(ctx, `/api/public/${cafe.slug}/reviews/click`, { method: 'POST', body: { token } });
  assert.equal(reviewClick.response.status, 200);
  assert.equal(reviewClick.data.url, 'https://g.page/r/example-review');
  const updatedReviews = await request(ctx, '/api/owner/reviews', { cookie });
  assert.ok(updatedReviews.data.reviews[0].clicked_at);

  const rewardId = card.data.rewards[0].id;
  const redeem = await request(ctx, `/api/owner/rewards/${rewardId}/redeem`, { method: 'POST', cookie, body: {} });
  assert.equal(redeem.response.status, 200);
  const resetCard = await request(ctx, `/api/public/${cafe.slug}/card`,{headers:{'X-Cafe-Token':token}});
  assert.equal(resetCard.data.stamps, 0, 'Redeeming the reward starts the next stamp cycle.');
  assert.equal(resetCard.data.rewards.length, 0);

  const dashboard = await request(ctx, '/api/owner/dashboard', { cookie });
  assert.equal(dashboard.data.summary.orders, 5);
  assert.equal(dashboard.data.summary.revenue, 21.25);
  assert.equal(dashboard.data.summary.repeat_percent,100);
  assert.equal(dashboard.data.top_items[0].name, 'House latte');
  const customerId=ctx.app.locals.db.prepare('SELECT id FROM customers WHERE cafe_id=? AND whatsapp_number=?').get(cafe.id,'+14155550123').id;
  const completedOrder=await request(ctx,`/api/public/${cafe.slug}/orders/${first.data.order_id}`,{headers:{'X-Cafe-Token':token}});
  assert.equal(completedOrder.data.status,'completed');
  const duplicateCompletion=await request(ctx,`/api/owner/orders/${first.data.order_id}/status`,{method:'PATCH',cookie,body:{status:'completed'}});
  assert.equal(duplicateCompletion.data.stamps,0,'Completing an order twice cannot add a second stamp.');
  assert.equal(ctx.app.locals.db.prepare('SELECT visit_count FROM customers WHERE cafe_id=? AND id=?').get(cafe.id,customerId).visit_count,5);

  const deletion = await request(ctx, `/api/owner/customers/${customerId}`, { method: 'DELETE', cookie });
  assert.equal(deletion.response.status, 200);
  assert.equal((await request(ctx, '/api/owner/customers', { cookie })).data.customers.length, 0);
  assert.equal(ctx.app.locals.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE cafe_id=?').get(cafe.id).n, 0, 'Customer removal cascades to their orders and loyalty history.');
});

test('owner sessions and cafe records remain isolated across tenants', async (t) => {
  const ctx = await context(t);
  const firstEmail=`first-${Date.now()}@example.test`;
  const secondEmail=`second-${Date.now()}@example.test`;
  const first = await setupCafe(ctx, 'First cafe', firstEmail);
  const second = await setupCafe(ctx, 'Second cafe', secondEmail);
  await request(ctx,'/api/auth/logout',{method:'POST',cookie:first.cookie});
  assert.equal((await request(ctx,'/api/auth/me')).data.owner,null);
  const firstLogin=await request(ctx,'/api/auth/login',{method:'POST',body:{email:firstEmail,password:'cafe-loop-test-password'}});
  assert.equal(firstLogin.response.status,200);
  assert.equal(firstLogin.data.cafe.id,first.cafe.id);
  const firstItem = await request(ctx, '/api/owner/menu', { method: 'POST', cookie: firstLogin.cookie, body: { name: 'First-only drink', category: 'Coffee', price: 3, earns_stamp: true, is_available: true, image_url: '' } });
  const secondItem = await request(ctx, '/api/owner/menu', { method: 'POST', cookie: second.cookie, body: { name: 'Second-only drink', category: 'Tea', price: 2, earns_stamp: false, is_available: true, image_url: '' } });
  assert.equal(firstItem.response.status, 201);
  assert.equal(secondItem.response.status, 201);
  const visibleFromFirst = await request(ctx, '/api/owner/menu', { cookie: firstLogin.cookie });
  assert.deepEqual(visibleFromFirst.data.items.map((item) => item.name), ['First-only drink']);
  const crossEdit = await request(ctx, `/api/owner/menu/${secondItem.data.item.id}`, { method: 'PATCH', cookie: firstLogin.cookie, body: secondItem.data.item });
  assert.equal(crossEdit.response.status, 404);
  const publicFirst = await request(ctx, `/api/public/${first.cafe.slug}/menu`);
  assert.deepEqual(publicFirst.data.items.map((item) => item.name), ['First-only drink']);
});

test('come-back bulk queue, return attribution, 14-day cooling, and STOP opt-out', async (t) => {
  const ctx = await context(t);
  const { cafe, cookie } = await setupCafe(ctx, 'Regulars cafe', `regulars-${Date.now()}@example.test`);
  const item=(await request(ctx,'/api/owner/menu',{method:'POST',cookie,body:{name:'Cortado',category:'Coffee',price:3.5,earns_stamp:true,is_available:true,image_url:''}})).data.item;
  const first=await request(ctx,`/api/public/${cafe.slug}/order`,{method:'POST',body:{table:4,customer:{name:'Priya Guest',phone:'+14155550126',marketing_consent:true},items:[{menu_item_id:item.id,quantity:1,note:''}]}});
  assert.equal(first.response.status,201);
  const customerId=ctx.app.locals.db.prepare('SELECT id FROM customers WHERE cafe_id=?').get(cafe.id).id;
  ctx.app.locals.db.prepare("UPDATE customers SET last_visit_at='2026-08-01T00:00:00.000Z',visit_count=3,favourite_item='Cortado' WHERE cafe_id=? AND id=?").run(cafe.id,customerId);
  const previous={sid:process.env.TWILIO_ACCOUNT_SID,token:process.env.TWILIO_AUTH_TOKEN,from:process.env.TWILIO_FROM};
  delete process.env.TWILIO_ACCOUNT_SID;delete process.env.TWILIO_AUTH_TOKEN;delete process.env.TWILIO_FROM;
  let batch;
  try{batch=await request(ctx,'/api/owner/comeback/send-all',{method:'POST',cookie,body:{days:21}});}finally{
    for(const [key,value] of Object.entries({TWILIO_ACCOUNT_SID:previous.sid,TWILIO_AUTH_TOKEN:previous.token,TWILIO_FROM:previous.from}))if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  assert.equal(batch.response.status,201,JSON.stringify(batch.data));
  assert.equal(batch.data.prepared,1);
  assert.equal(batch.data.queued,1,'Without provider credentials, the offer is queued for manual delivery.');
  assert.match(batch.data.offers[0].message,/Cortado/);
  const opened=await request(ctx,`/api/owner/offers/${batch.data.offers[0].id}/open`,{method:'POST',cookie});
  assert.match(opened.data.url,/wa\.me\/14155550126/);
  const cooldown=await request(ctx,`/api/owner/comeback?days=21`,{cookie});
  assert.equal(cooldown.data.customers.length,0,'Opening an offer starts the 14-day cooldown.');
  const returned=await request(ctx,`/api/public/${cafe.slug}/order`,{method:'POST',body:{table:4,customer_token:first.data.customer_token,items:[{menu_item_id:item.id,quantity:1,note:''}]}});
  assert.equal(returned.response.status,201);
  assert.ok(ctx.app.locals.db.prepare('SELECT returned_at FROM offers WHERE cafe_id=? AND id=?').get(cafe.id,batch.data.offers[0].id).returned_at,'A valid comeback order is attributed to the offer.');
  assert.equal((await request(ctx,'/api/owner/dashboard',{cookie})).data.summary.winbacks,1);

  const secret='test-twilio-webhook-secret';const previousToken=process.env.TWILIO_AUTH_TOKEN;const previousUrl=process.env.APP_PUBLIC_URL;
  process.env.TWILIO_AUTH_TOKEN=secret;process.env.APP_PUBLIC_URL=ctx.base;
  try{
    const route='/api/webhooks/twilio/inbound';const values={Body:'STOP',From:'+14155550126',To:'whatsapp:+14155238886'};
    const payload=Object.entries(values).map(([key,value])=>`${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    const material=`${ctx.base}${route}`+Object.keys(values).sort().map((key)=>key+values[key]).join('');
    const signature=await import('node:crypto').then(({default:crypto})=>crypto.createHmac('sha1',secret).update(material).digest('base64'));
    const response=await fetch(`${ctx.base}${route}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature},body:payload});
    assert.equal(response.status,200);
  }finally{
    if(previousToken===undefined)delete process.env.TWILIO_AUTH_TOKEN;else process.env.TWILIO_AUTH_TOKEN=previousToken;
    if(previousUrl===undefined)delete process.env.APP_PUBLIC_URL;else process.env.APP_PUBLIC_URL=previousUrl;
  }
  const optedOut=ctx.app.locals.db.prepare('SELECT marketing_consent,opted_out_at FROM customers WHERE cafe_id=? AND id=?').get(cafe.id,customerId);
  assert.equal(optedOut.marketing_consent,0);
  assert.ok(optedOut.opted_out_at);
  const blocked=await request(ctx,`/api/owner/comeback/${customerId}/send`,{method:'POST',cookie});
  assert.equal(blocked.response.status,409,'An opted-out customer cannot be messaged manually.');
});

test('daily birthday and come-back automation is consent-based and idempotent', async (t) => {
  const ctx = await context(t);
  const { cafe, cookie } = await setupCafe(ctx, 'Automation cafe', `auto-${Date.now()}@example.test`);
  const item = (await request(ctx, '/api/owner/menu', { method: 'POST', cookie, body: { name: 'Daily cup', category: 'Coffee', price: 3, earns_stamp: true, is_available: true, image_url: '' } })).data.item;
  const order = await request(ctx, `/api/public/${cafe.slug}/order`, { method: 'POST', body: { table: 1, customer: { name: 'Consent Guest', phone: '+14155550125', marketing_consent: true }, items: [{ menu_item_id: item.id, quantity: 1, note: '' }] } });
  assert.equal(order.response.status, 201);
  const customerId = ctx.app.locals.db.prepare('SELECT id FROM customers WHERE cafe_id=?').get(cafe.id).id;
  ctx.app.locals.db.prepare("UPDATE customers SET birthday_day=13,birthday_month=11,last_visit_at='2026-10-01T00:00:00.000Z' WHERE cafe_id=? AND id=?").run(cafe.id,customerId);
  const previous = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, from: process.env.TWILIO_FROM };
  delete process.env.TWILIO_ACCOUNT_SID;delete process.env.TWILIO_AUTH_TOKEN;delete process.env.TWILIO_FROM;
  try {
    await processAutomations(ctx.app.locals.db,new Date('2026-11-13T10:01:00.000Z'));
    let offers=ctx.app.locals.db.prepare('SELECT type,delivery_status,idempotency_key FROM offers WHERE cafe_id=? ORDER BY type').all(cafe.id);
    assert.deepEqual(offers.map((offer)=>offer.type),['birthday','comeback']);
    assert.ok(offers.every((offer)=>offer.delivery_status==='queued'));
    await processAutomations(ctx.app.locals.db,new Date('2026-11-13T11:30:00.000Z'));
    offers=ctx.app.locals.db.prepare('SELECT type FROM offers WHERE cafe_id=?').all(cafe.id);
    assert.equal(offers.length,2,'Daily jobs do not queue duplicate messages when retried.');
  } finally {
    for(const [key,value] of Object.entries({TWILIO_ACCOUNT_SID:previous.sid,TWILIO_AUTH_TOKEN:previous.token,TWILIO_FROM:previous.from})) if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});

test('Twilio WhatsApp payload uses the cafe sender and scheduled delivery stays paused until enabled', async () => {
  const previous={sid:process.env.TWILIO_ACCOUNT_SID,token:process.env.TWILIO_AUTH_TOKEN,from:process.env.TWILIO_FROM,automations:process.env.TWILIO_AUTOMATIONS_ENABLED,fetch:globalThis.fetch};
  process.env.TWILIO_ACCOUNT_SID='AC_TEST_ACCOUNT';process.env.TWILIO_AUTH_TOKEN='test-auth-token';delete process.env.TWILIO_FROM;
  process.env.TWILIO_AUTOMATIONS_ENABLED='false';
  const cafe={id:'cafe-test',name:'Harbour Cafe',timezone:'UTC',messaging_channel:'whatsapp',messaging_from:'whatsapp:+14155550000',birthday_template_sid:'HX_BIRTHDAY',comeback_template_sid:'HX_COMEBACK',review_template_sid:'HX_REVIEW',google_review_link:'https://g.page/r/test'};
  const customer={id:'customer-test',name:'Sam Guest',whatsapp_number:'+14155550127',favourite_item:'Flat white'};
  const offer={id:'offer-test',message:'Happy birthday, Sam!',reward_code:'BDAY-A1B2',expires_at:'2026-11-20T00:00:00.000Z'};
  let sentRequest;
  globalThis.fetch=async(url,init)=>{sentRequest={url:String(url),init};return new Response('{"sid":"SM_TEST"}',{status:201,headers:{'Content-Type':'application/json'}});};
  try{
    const queued=await deliverTwilio(null,cafe,offer,customer,'birthday',{automated:true});
    assert.equal(queued,'queued');
    assert.equal(sentRequest,undefined,'Scheduled delivery sends nothing before activation.');
    process.env.TWILIO_AUTOMATIONS_ENABLED='true';
    const result=await deliverTwilio(null,cafe,offer,customer,'birthday',{automated:true});
    assert.equal(result,'sent');
    assert.match(sentRequest.url,/Accounts\/AC_TEST_ACCOUNT\/Messages\.json$/);
    const body=new URLSearchParams(sentRequest.init.body);
    assert.equal(body.get('From'),'whatsapp:+14155550000');
    assert.equal(body.get('To'),'whatsapp:+14155550127');
    assert.equal(body.get('ContentSid'),'HX_BIRTHDAY');
    assert.deepEqual(JSON.parse(body.get('ContentVariables')),{1:'Sam Guest',2:'Flat white',3:'Harbour Cafe',4:'BDAY-A1B2',5:'Nov 20'});
  }finally{
    for(const [key,value]of Object.entries({TWILIO_ACCOUNT_SID:previous.sid,TWILIO_AUTH_TOKEN:previous.token,TWILIO_FROM:previous.from,TWILIO_AUTOMATIONS_ENABLED:previous.automations}))if(value===undefined)delete process.env[key];else process.env[key]=value;
    globalThis.fetch=previous.fetch;
  }
});

test('India SMS requires DLT IDs and includes the registered PE and message template IDs', async () => {
  const previous={sid:process.env.TWILIO_ACCOUNT_SID,token:process.env.TWILIO_AUTH_TOKEN,from:process.env.TWILIO_FROM,fetch:globalThis.fetch};
  process.env.TWILIO_ACCOUNT_SID='AC_TEST_ACCOUNT';process.env.TWILIO_AUTH_TOKEN='test-auth-token';delete process.env.TWILIO_FROM;
  const cafe={id:'cafe-test',name:'Harbour Cafe',timezone:'Asia/Kolkata',messaging_channel:'sms',messaging_from:'HARBOUR',dlt_pe_id:'12345678901234567890',comeback_dlt_template_id:'23456789012345678901'};
  const customer={id:'customer-test',name:'Sam Guest',whatsapp_number:'+919876543210',favourite_item:'Flat white'};
  const offer={id:'offer-test',message:'Hello Sam, visit Harbour Cafe again.',reward_code:'COME-A1B2',expires_at:'2026-11-20T00:00:00.000Z'};
  let sentRequest;
  globalThis.fetch=async(url,init)=>{sentRequest={url:String(url),init};return new Response('{"sid":"SM_TEST"}',{status:201,headers:{'Content-Type':'application/json'}});};
  try{
    const missing=await deliverTwilio(null,{...cafe,dlt_pe_id:''},offer,customer,'comeback');
    assert.equal(missing,'queued');
    assert.equal(sentRequest,undefined,'An Indian SMS is not sent without DLT registration IDs.');
    const result=await deliverTwilio(null,cafe,offer,customer,'comeback');
    assert.equal(result,'sent');
    const body=new URLSearchParams(sentRequest.init.body);
    assert.equal(body.get('From'),'HARBOUR');
    assert.equal(body.get('To'),'+919876543210');
    assert.equal(body.get('DltPEId'),'12345678901234567890');
    assert.equal(body.get('DltTemplateId'),'23456789012345678901');
    assert.equal(body.get('Body'),offer.message);
  }finally{
    for(const [key,value]of Object.entries({TWILIO_ACCOUNT_SID:previous.sid,TWILIO_AUTH_TOKEN:previous.token,TWILIO_FROM:previous.from}))if(value===undefined)delete process.env[key];else process.env[key]=value;
    globalThis.fetch=previous.fetch;
  }
});
