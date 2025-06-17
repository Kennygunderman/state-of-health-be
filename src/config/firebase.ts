import * as admin from 'firebase-admin';

// Initialize Firebase Admin
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccount) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set');
}

admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccount))
});

export const db = admin.firestore(); 