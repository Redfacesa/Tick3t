import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { applyPaySsoTokensFromUrl } from '@/lib/sso';
import { hasSupabaseConfig, supabase } from '@/lib/supabase';

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
  configError: string | null;
};

const Ctx = createContext<AuthState>({
  user: null,
  merchant: null,
  loading: true,
  signOut: async () => undefined,
  configError: null,
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
  const [configError, setConfigError] = useState<string | null>(null);

  const applyUser = useCallback(async (next: AuthUser | null) => {
    setUser(next);
    if (!next?.email) {
      setMerchant(null);
      return;
    }
    try {
      setMerchant(await resolveMerchant(next.email));
    } catch {
      setMerchant(null);
    }
  }, []);

  useEffect(() => {
    let on = true;

    void (async () => {
      if (!hasSupabaseConfig) {
        setConfigError(
          'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY on this deploy. Add the same hub keys as RedFace Pay in Vercel.',
        );
        setLoading(false);
        return;
      }

      const sso = await applyPaySsoTokensFromUrl();
      if (!on) return;

      const { data } = await supabase.auth.getSession();
      if (!on) return;

      const sessionUser = data.session?.user;
      if (sessionUser?.email) {
        await applyUser({ id: sessionUser.id, email: sessionUser.email });
      } else if (sso?.email) {
        await applyUser({ id: sso.userId, email: sso.email });
      } else {
        await applyUser(null);
      }
      setLoading(false);
    })();

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

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    await applyUser(null);
  }, [applyUser]);

  return (
    <Ctx.Provider value={{ user, merchant, loading, signOut, configError }}>
      {children}
    </Ctx.Provider>
  );
}
