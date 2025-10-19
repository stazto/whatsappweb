import * as admin from 'firebase-admin';

const PROJECT_ID = process.env.PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: PROJECT_ID,
  });
}

export const db = admin.firestore();
export { admin };
