// firebaseAdmin.js — inicialização do Admin SDK (ESM + v12) para GCE/VM
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

// PROJECT_ID vem do .env ou das variáveis padrão do GCP
const PROJECT_ID =
  process.env.PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  undefined;

// Inicializa só uma vez (idempotente)
if (getApps().length === 0) {
  try {
    initializeApp({
      credential: applicationDefault(), // usa a service account da VM (ADC)
      projectId: PROJECT_ID,
    });
    // eslint-disable-next-line no-console
    console.log(`[firebaseAdmin] inicializado (projectId=${PROJECT_ID || 'auto'})`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[firebaseAdmin] Falha ao inicializar:', e?.message || e);
    throw e;
  }
}

// Firestore pronto
const db = getFirestore();

// Compat: exporta 'admin.firestore.FieldValue' para o server.js atual
// (no v12 modular não existe 'admin' default; criamos um "adapter" mínimo)
const admin = {
  firestore: {
    FieldValue,
    Timestamp,
  },
};

export { db, admin };
