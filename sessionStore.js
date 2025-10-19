import fs from 'fs';
import path from 'path';
import { db, admin } from './firebaseAdmin.js';

const useFS = (process.env.SESSION_STORE || '').toLowerCase() === 'filesystem';

const FS_DIR = path.join(process.cwd(), 'sessions');
if (useFS && !fs.existsSync(FS_DIR)) fs.mkdirSync(FS_DIR, { recursive: true });

export async function loadSession(tenantId) {
  if (useFS) {
    const p = path.join(FS_DIR, `${tenantId}.json`);
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
    }
    return null;
  }
  const ref = db.collection('wweb_sessions').doc(tenantId);
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}

export async function saveSession(tenantId, data) {
  if (useFS) {
    const p = path.join(FS_DIR, `${tenantId}.json`);
    fs.writeFileSync(p, JSON.stringify(data || {}, null, 2));
    return true;
  }
  const ref = db.collection('wweb_sessions').doc(tenantId);
  await ref.set(data || {}, { merge: true });
  return true;
}

export async function clearSession(tenantId) {
  if (useFS) {
    const p = path.join(FS_DIR, `${tenantId}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  }
  const ref = db.collection('wweb_sessions').doc(tenantId);
  await ref.delete();
  return true;
}
