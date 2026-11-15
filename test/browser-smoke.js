import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';

const chromePath = process.env.CHROME_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((candidate) => fs.existsSync(candidate));

test('mobile browser completes cafe setup, menu setup, QR order and stamp display at 375px', async (t) => {
  assert.ok(chromePath, 'Install Chrome or Edge, or set CHROME_PATH before running the browser smoke test.');
  const app = createApp({ databasePath: ':memory:' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  fs.mkdirSync('test-results', { recursive: true });
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    app.locals.close();
  });

  await page.goto(`${base}/owner/setup`);
  assert.equal(await page.getByLabel('Currency').inputValue(), 'INR', 'New cafe setup defaults to Indian Rupees.');
  await page.getByLabel('Cafe name').fill('Playwright Cafe');
  await page.getByLabel('Owner email').fill('owner@playwright-cafe.example');
  await page.getByLabel('Password').fill('playwright-test-password');
  await page.getByRole('button', { name: 'Create my workspace' }).click();
  await page.getByText('The counter is quiet.').waitFor();
  assert.equal(await page.locator('body').evaluate((node) => node.scrollWidth), 375, 'Owner dashboard fits a 375px viewport.');

  await page.goto(`${base}/owner/settings`);
  await page.getByLabel('Item name').fill('House latte');
  await page.getByLabel('Category').fill('Coffee');
  await page.getByLabel('Price').fill('4.25');
  await page.getByRole('button', { name: 'Add to menu' }).click();
  await page.getByText('House latte', { exact: true }).first().waitFor();

  await page.goto(`${base}/order?cafe=playwright-cafe&table=2`);
  await page.getByRole('button', { name: 'Add House latte to order' }).click();
  await page.getByLabel('Your name').fill('Rae Guest');
  await page.getByLabel('WhatsApp number').fill('+14155550123');
  await page.getByLabel(/Send me cafe offers/).check();
  await page.screenshot({ path: 'test-results/cafeloop-mobile-menu.png', fullPage: true });
  await page.getByRole('button', { name: /Place order/ }).click();
  await page.getByText('Your order is with the team.').waitFor();
  assert.equal(await page.locator('body').evaluate((node) => node.scrollWidth), 375, 'Customer order fits a 375px viewport.');
  await page.screenshot({ path: 'test-results/cafeloop-mobile-order.png', fullPage: true });
  const orderId=new URL(page.url()).searchParams.get('order');
  assert.ok(orderId,"The new order is linked to the customer's card.");

  await page.goto(`${base}/owner/dashboard`);
  await page.getByRole('button', { name: /Start preparing/ }).click();
  await page.getByRole('button', { name: /Mark completed/ }).click();
  await page.getByText('One stamp added to Rae Guest\'s card.').waitFor();

  await page.goto(`${base}/card?cafe=playwright-cafe&order=${encodeURIComponent(orderId)}`);
  await page.getByText('Your order is ready.').waitFor();
  await page.getByText('1 of 5 stamps').waitFor();
  assert.equal(await page.locator('body').evaluate((node) => node.scrollWidth), 375, 'Customer stamp card fits a 375px viewport.');
  await page.screenshot({ path: 'test-results/cafeloop-mobile-card.png', fullPage: true });

  await page.goto(`${base}/owner/qr`);
  await page.locator('.qr-table-card img').first().waitFor();
  assert.equal(await page.locator('.qr-table-card').count(), 8);
  assert.match(await page.locator('.qr-table-card img').first().getAttribute('alt'), /table 1/i);

  await page.screenshot({ path: 'test-results/cafeloop-mobile-qr.png', fullPage: true });
  assert.deepEqual(pageErrors, [], 'The tested browser flows produced no uncaught JavaScript errors.');
});
