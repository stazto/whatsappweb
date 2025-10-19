// firebaseAdmin.js
// Inicializa o Admin SDK usando ADC da VM (Service Account) e mantém API compatível com seu server.
// Robusto contra diferenças entre versões do firebase-admin (apps pode não existir).

import * as admin from 'firebase-admin';

const PROJECT_ID =
  process.env.PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT || undefined;

// Nem todas as versões expõem `admin.apps`. Protege contra undefined.
const hasAppsArray = !!(admin && admin.apps && Array.isArray(admin.apps));

try {
  if (!hasAppsArray || admin.apps.length === 0) {
    // initializeApp disponível em todas as versões estáveis
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      // projectId opcional, mas ajuda em ambientes sem metadata server
      ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
    });
  }
} catch (e) {
  // Loga e repropaga para falhar cedo com mensagem clara
  console.error('[firebaseAdmin] Falha ao inicializar firebase-admin:', e?.message || e);
  throw e;
}

// Garante Firestore; em versões novas é admin.firestore(), mantendo compat com seu server.js
export const db = admin.firestore();

// Exporta `admin` para você continuar usando `admin.firestore.FieldValue.serverTimestamp()`
export { admin };
