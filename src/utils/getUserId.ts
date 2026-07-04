import { Request } from 'express';

export function getUserId(req: Request): string {
  const user = (req as any).user;
  if (user && (user.uid || user.user_id)) {
    return user.uid || user.user_id;
  }
  throw new Error('User ID not found in request');
}

// Email claim from the verified Firebase token — safe to use for the
// unlimited-AI whitelist because it never comes from the request body.
export function getUserEmail(req: Request): string | undefined {
  const email = (req as any).user?.email;
  return typeof email === 'string' && email ? email : undefined;
} 