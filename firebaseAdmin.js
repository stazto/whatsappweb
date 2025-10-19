// firebaseAdmin.js — Admin SDK (v12+) com ADC no GCE + shim de FieldValue
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

// Usa o que estiver setado no ambiente ou deixa o Admin descobrir sozinho via ADC
const PROJECT_ID =
  process.env.PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  undefined;

// Inicializa uma única vez
if (getApps().length === 0) {
  try {
    // Preferível: ADC explícito (funciona na VM sem GOOGLE_APPLICATION_CREDENTIALS)
    initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });
    console.log('[firebaseAdmin] inicializado com applicationDefault()');
  } catch (e) {
    // Fallback: sem passar credential (Admin usa ADC implícito onde suportado)
    initializeApp({ projectId: PROJECT_ID });
    console.log('[firebaseAdmin] inicializado (ADC implícito / fallback)');
  }
}

// Firestore (compatível com seu server.js)
export const db = getFirestore();

// Shim mínimo pra manter server.js funcionando: admin.firestore.FieldValue.serverTimestamp()
export const admin = {
  firestore: { FieldValue, Timestamp },
};
