/** True when Clerk publishable key is configured. */
export function isClerkEnabled(): boolean {
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}
