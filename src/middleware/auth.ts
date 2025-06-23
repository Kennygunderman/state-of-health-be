import { Request, Response, NextFunction } from 'express';
import { admin } from '../utils/firebase';

export async function authenticateFirebaseToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    (req as any).user = decodedToken;
    next();
  } catch (error) {
    console.log(error, 'Error verifying Firebase ID token');
    return res.status(401).json({ error: 'Invalid token' });
  }
}
