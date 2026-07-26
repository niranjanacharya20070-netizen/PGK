// send-reminders.js
// Run twice a day by GitHub Actions (free) instead of Firebase Cloud Functions (paid plan required).
// Sends: 9:30 PM reminder for tomorrow's programmes, 10:00 AM reminder for today's.
// Uses a Firebase service account key (free, no billing needed) to talk to Firestore + FCM directly.

const admin = require('firebase-admin');

// The service account JSON is provided via a GitHub Actions secret (see workflow file).
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const messaging = admin.messaging();

// ⚠️ Change this if your programmes are scheduled in a different timezone.
const TIMEZONE = 'Asia/Kolkata';

function todayStr(tz) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function formatTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return '';
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

async function getAllTokens() {
  const snap = await db.collection('deviceTokens').get();
  return snap.docs.map(d => d.id);
}

async function pruneInvalidTokens(tokens, responses) {
  const batch = db.batch();
  let removed = 0;
  responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        batch.delete(db.collection('deviceTokens').doc(tokens[i]));
        removed++;
      }
    }
  });
  if (removed) await batch.commit();
}

async function sendToAllDevices(tokens, title, body, tag) {
  if (tokens.length === 0) return;
  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { tag },
    webpush: { fcmOptions: { link: '/' } }
  });
  await pruneInvalidTokens(tokens, res.responses);
}

async function run() {
  const today = todayStr(TIMEZONE);
  const tomorrow = addDaysStr(today, 1);
  const tokens = await getAllTokens();

  // Tomorrow's reminder (only actually sends once per programme, guarded by notifiedTomorrowFor)
  const tomorrowSnap = await db.collection('programs').where('date', '==', tomorrow).get();
  for (const docSnap of tomorrowSnap.docs) {
    const p = docSnap.data();
    if (p.status === 'finished') continue;
    if (p.notifiedTomorrowFor === tomorrow) continue;
    const place = p.place || 'the programme';
    const when = p.time ? formatTime(p.time) : '';
    await sendToAllDevices(tokens, 'Programme tomorrow', `Tomorrow: ${place}${when ? ' at ' + when : ''}`, 'tom_' + docSnap.id + '_' + tomorrow);
    await docSnap.ref.set({ notifiedTomorrowFor: tomorrow }, { merge: true });
    console.log('Sent tomorrow-reminder for', docSnap.id);
  }

  // Today's reminder
  const todaySnap = await db.collection('programs').where('date', '==', today).get();
  for (const docSnap of todaySnap.docs) {
    const p = docSnap.data();
    if (p.status === 'finished') continue;
    if (p.notifiedTodayFor === today) continue;
    const place = p.place || 'the programme';
    const when = p.time ? formatTime(p.time) : '';
    await sendToAllDevices(tokens, 'Programme today', `Today: ${place}${when ? ' at ' + when : ''}`, 'today_' + docSnap.id + '_' + today);
    await docSnap.ref.set({ notifiedTodayFor: today }, { merge: true });
    console.log('Sent today-reminder for', docSnap.id);
  }

  console.log('Done.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
