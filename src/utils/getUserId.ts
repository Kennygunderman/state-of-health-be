import { Request } from 'express';

export function getUserId(req: Request): string {
  const user = (req as any).user;
  if (user && (user.uid || user.user_id)) {
    return user.uid || user.user_id;
  }
  throw new Error('User ID not found in request');
} 