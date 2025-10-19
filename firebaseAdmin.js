// firebaseAdmin.js — inicialização robusta do Admin SDK (ADC da VM)
import * as admin from 'firebase-admin';

const PROJECT_ID =
  process.env.PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  undefined;

try {
  // Em ambientes onde admin.apps pode não existir por algum motivo, checamos defensivamente
  const hasAppsArray = !!(admin && admin.apps && Array.isArray(admin.apps));
  if (!hasAppsArray || admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: PROJECT_ID,
    });
  }
  console.log('[firebaseAdmin] inicializado (projectId=' + (PROJECT_ID || 'auto') + ')');
} catch (e) {
  console.error('[firebaseAdmin] Falha ao inicializar firebase-admin:', e?.message || e);
  throw e;
}

export const db = admin.firestore();
export { admin };
