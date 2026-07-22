import { useEffect, useRef } from 'react';
import { useClerk, useSession, useUser } from '@clerk/react';
import { ensureClerkIdentityLink } from '@/lib/clerkIdentity';
import { isSupabaseAuthUserId } from '@/lib/authIds';
import { registerClerkSignOut, registerClerkTokenGetter, supabase } from '@/lib/supabase';

export type ClerkBridgeUser = {
  id: string;
  email: string;
  clerkUserId: string;
} | null;

type Props = {
  onSession: (user: ClerkBridgeUser) => Promise<void>;
  onBootstrapComplete: () => void;
};

/**
 * Wires Clerk session tokens into Supabase and mirrors Clerk sign-in into AuthContext.
 */
export default function ClerkSupabaseBridge({ onSession, onBootstrapComplete }: Props) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { session } = useSession();
  const { signOut: clerkSignOut } = useClerk();
  const bootstrapped = useRef(false);
  const lastBridgeKey = useRef<string | null>(null);
  const onSessionRef = useRef(onSession);
  const onBootstrapCompleteRef = useRef(onBootstrapComplete);

  onSessionRef.current = onSession;
  onBootstrapCompleteRef.current = onBootstrapComplete;

  useEffect(() => {
    registerClerkSignOut(() => clerkSignOut());
    return () => registerClerkSignOut(null);
  }, [clerkSignOut]);

  useEffect(() => {
    registerClerkTokenGetter(async () => {
      if (!session) return null;
      return session.getToken();
    });
    return () => registerClerkTokenGetter(null);
  }, [session]);

  useEffect(() => {
    if (!isLoaded) return;

    const email =
      user?.primaryEmailAddress?.emailAddress?.trim() ||
      user?.emailAddresses?.[0]?.emailAddress?.trim() ||
      null;

    const bridgeKey =
      isSignedIn && user?.id && email ? `${user.id}:${email.toLowerCase()}` : 'signed-out';

    if (lastBridgeKey.current === bridgeKey) return;
    lastBridgeKey.current = bridgeKey;

    void (async () => {
      if (!isSignedIn || !user || !email) {
        await onSessionRef.current(null);
      } else {
        const link = await ensureClerkIdentityLink();
        let supabaseUserId = link?.supabaseUserId ?? null;
        if (!supabaseUserId) {
          const { data: linkedId } = await supabase.rpc('my_supabase_user_id');
          if (linkedId && isSupabaseAuthUserId(String(linkedId))) {
            supabaseUserId = String(linkedId);
          }
        }
        await onSessionRef.current({
          id: supabaseUserId ?? '',
          email: link?.email ?? email,
          clerkUserId: link?.clerkUserId ?? user.id,
        });
      }

      if (!bootstrapped.current) {
        bootstrapped.current = true;
        onBootstrapCompleteRef.current();
      }
    })();
  }, [isLoaded, isSignedIn, user?.id, user?.primaryEmailAddress?.emailAddress]);

  return null;
}
