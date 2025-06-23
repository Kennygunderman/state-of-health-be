import * as admin from 'firebase-admin';
import serviceAccount from '../../serviceAccountKey.json';

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
    databaseURL: "https://state-of-health-ea1ef.firebaseio.com"
});

export { admin };
export const db = admin.firestore();
