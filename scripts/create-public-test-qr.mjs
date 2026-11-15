import fs from 'node:fs';
import QRCode from 'qrcode';

const base = process.env.PUBLIC_TEST_URL;
if (!base) throw new Error('Set PUBLIC_TEST_URL to the temporary public app URL first.');
const url = new URL('/order', base);
url.searchParams.set('cafe', 'cafeloop-qr-test');
url.searchParams.set('table', '1');
const output = './.data/cafeloop-qr-test-public.png';
fs.mkdirSync('./.data', { recursive: true });
await QRCode.toFile(output, url.toString(), {
  width: 900,
  margin: 2,
  errorCorrectionLevel: 'M',
  color: { dark: '#193333', light: '#ffffff' },
});
console.log(`Public test QR saved to ${output}`);
console.log(`URL: ${url.toString()}`);
