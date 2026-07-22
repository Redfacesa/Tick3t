import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import ClerkSupabaseBridge, { type ClerkBridgeUser } from '@/components/ClerkSupabaseBridge';
import { isClerkEnabled } from '@/lib/clerkEnabled';
import { applyPaySsoTokensFromUrl } from '@/lib/sso';
import { signOutViaClerk, supabase, usesThirdPartySupabaseAuth } from '@/lib/supabase';

export type AuthUser = {
  id: string;
  email: string;
  clerkUserId?: string;
};

export type AuthMerchant = {
  id: string;
  business_name?: string | null;
  email?: string | null;
};

type AuthState = {
  user: AuthUser | null;
  merchant: AuthMerchant | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState>({
  user: null,
  merchant: null,
  loading: true,
  signOut: async () => undefined,
});

export const useAuth = () => useContext(Ctx);

async function resolveMerchant(email: string): Promise<AuthMerchant | null> {
  const { data } = await supabase
    .from('merchants')
    .select('id, business_name, email')
    .ilike('email', email)
    .maybeSingle();
  if (!data?.id) return null;
  return data as AuthMerchant;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [merchant, setMerchant] = useState<AuthMerchant | null>(null);
  const [loading, setLoading] = useState(true);

  const applyUser = useCallback(async (next: AuthUser | null) => {
    setUser(next);
    if (!next?.email) {
      setMerchant(null);
      return;
    }
    setMerchant(await resolveMerchant(next.email));
  }, []);

  useEffect(() => {
    let on = true;

    void (async () => {
      // Consume RedFace Pay ecosystem SSO tokens first (satellite return).
      await applyPaySsoTokensFromUrl();
      if (!on) return;

      if (isClerkEnabled()) {
        // Clerk bridge owns bootstrap loading state.
        return;
      }

      const { data } = await supabase.auth.getSession();
      if (!on) return;
      const sessionUser = data.session?.user;
      if (sessionUser?.email) {
        await applyUser({ id: sessionUser.id, email: sessionUser.email });
      } else {
        await applyUser(null);
      }
      setLoading(false);
    })();

    if (isClerkEnabled()) {
      return () => {
        on = false;
      };
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      void (async () => {
        const sessionUser = session?.user;
        if (sessionUser?.email) {
          await applyUser({ id: sessionUser.id, email: sessionUser.email });
        } else {
          await applyUser(null);
        }
        setLoading(false);
      })();
    });

    return () => {
      on = false;
      sub.subscription.unsubscribe();
    };
  }, [applyUser]);

  const onClerkSession = useCallback(
    async (bridgeUser: ClerkBridgeUser) => {
      if (!bridgeUser) {
        await applyUser(null);
        return;
      }
      await applyUser({
        id: bridgeUser.id,
        email: bridgeUser.email,
        clerkUserId: bridgeUser.clerkUserId,
      });
    },
    [applyUser],
  );

  const signOut = useCallback(async () => {
    if (usesThirdPartySupabaseAuth) {
      await signOutViaClerk();
    }
    await supabase.auth.signOut();
    await applyUser(null);
  }, [applyUser]);

  return (
    <Ctx.Provider value={{ user, merchant, loading, signOut }}>
      {isClerkEnabled() && (
        <ClerkSupabaseBridge
          onSession={onClerkSession}
          onBootstrapComplete={() => setLoading(false)}
        />
      )}
      {children}
    </Ctx.Provider>
  );
}
