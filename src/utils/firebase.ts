import * as admin from 'firebase-admin';

// Deployed environments provide FIREBASE_SERVICE_ACCOUNT (base64 of the JSON
// key) so builds work from a clean checkout; local dev falls back to the
// gitignored serviceAccountKey.json in the project root.
function loadServiceAccount(): admin.ServiceAccount {
    const encoded = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (encoded) {
        return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    }
    return require('../../serviceAccountKey.json');
}

admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount()),
    databaseURL: "https://state-of-health-ea1ef.firebaseio.com"
});

export { admin };
export const db = admin.firestore();
