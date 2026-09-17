// Local development start — loads .env before starting the relay
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const [key, ...rest] = line.split('=');
    if (key && !process.env[key]) {
      process.env[key] = rest.join('=').trim().replace(/^["']|["']$/g, '');
    }
  });
  console.log('Loaded .env for local testing');
}

try {
  const indexFile = require('./index.js');
  indexFile.start(process.env);
} catch (e) {
  console.error('FATAL ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
}
