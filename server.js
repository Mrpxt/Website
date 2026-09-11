// push-server / server.js
// Backend that stores web-push subscriptions + reminder times, and sends
// real push notifications even when the app is closed on the user's phone.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Bangkok';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:you@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env — see .env.example');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ---------- tiny JSON "database" ----------
function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify({ subscriptions: {}, reminders: {}, sent: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Save a browser's push subscription for a given app username
app.post('/api/subscribe', (req, res) => {
  const { username, subscription } = req.body;
  if (!username || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'username and subscription are required' });
  }
  const db = loadDb();
  if (!db.subscriptions[username]) db.subscriptions[username] = [];
  const exists = db.subscriptions[username].some(s => s.endpoint === subscription.endpoint);
  if (!exists) db.subscriptions[username].push(subscription);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { username, endpoint } = req.body;
  const db = loadDb();
  if (db.subscriptions[username]) {
    db.subscriptions[username] = db.subscriptions[username].filter(s => s.endpoint !== endpoint);
  }
  saveDb(db);
  res.json({ ok: true });
});

// Client calls this every time tasks change, sending only tasks that have
// a reminder time set. This is the full source of truth for that user.
app.post('/api/sync-reminders', (req, res) => {
  const { username, reminders } = req.body;
  if (!username || !Array.isArray(reminders)) {
    return res.status(400).json({ error: 'username and reminders[] are required' });
  }
  const db = loadDb();
  db.reminders[username] = reminders; // [{id, title, date, time, categoryName, done}]
  saveDb(db);
  res.json({ ok: true, count: reminders.length });
});

function nowHM_and_date() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = {};
  fmt.formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`
  };
}

// The actual "check what's due and push it" routine.
// Call this from an external cron (e.g. cron-job.org) hitting /api/tick every minute,
// AND it also runs on an internal timer as a backup while the server is awake.
async function tick() {
  const db = loadDb();
  const { date: today, hm: nowHM } = nowHM_and_date();
  let sentCount = 0;

  for (const username of Object.keys(db.reminders)) {
    const items = db.reminders[username] || [];
    const subs = db.subscriptions[username] || [];
    if (subs.length === 0) continue;

    for (const item of items) {
      if (item.done) continue;
      if (item.date !== today || item.time !== nowHM) continue;
      const sentKey = `${username}:${item.id}:${item.date}:${item.time}`;
      if (db.sent[sentKey]) continue;

      const payload = JSON.stringify({
        title: 'ถึงเวลาทำแล้ว: ' + item.title,
        body: item.categoryName ? `หมวดหมู่: ${item.categoryName}` : 'แตะเพื่อเปิดรายการของวันนี้'
      });

      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub, payload);
          sentCount++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            db.subscriptions[username] = db.subscriptions[username].filter(s => s.endpoint !== sub.endpoint);
          } else {
            console.error('push error', username, err.statusCode || err.message);
          }
        }
      }
      db.sent[sentKey] = true;
    }
  }

  saveDb(db);
  return sentCount;
}

app.all('/api/tick', async (req, res) => {
  try {
    const sentCount = await tick();
    res.json({ ok: true, sent: sentCount, at: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`push-server listening on port ${PORT}`);
});

// Backup internal timer — only fires reliably while the process is awake.
// Free hosts that sleep on inactivity still need the external cron-job.org
// ping described in README.md to wake this up and trigger /api/tick.
setInterval(() => { tick().catch(console.error); }, 60 * 1000);
