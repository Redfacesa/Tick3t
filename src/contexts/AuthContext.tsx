import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { clearSatelliteSession, getSatelliteUser } from '@/lib/satelliteSession';
import { applyPaySsoTokensFromUrl } from '@/lib/sso';
import { hasSupabaseConfig, supabase } from '@/lib/supabase';
import { fetchTick3tOrganizerMe } from '@/lib/tick3t/api';

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

/** Prefer organizer RPC — direct merchants table reads 401 under Clerk satellite JWTs. */
async function resolveMerchant(_email: string): Promise<AuthMerchant | null> {
  const organizer = await fetchTick3tOrganizerMe();
  if (organizer?.merchant_id) {
    return {
      id: organizer.merchant_id,
      business_name: organizer.company_name,
      email: organizer.email || _email,
    };
  }
  return null;
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
      const satellite = getSatelliteUser();

      if (sessionUser?.email) {
        await applyUser({ id: sessionUser.id, email: sessionUser.email });
      } else if (sso?.email) {
        await applyUser({ id: sso.userId, email: sso.email });
      } else if (satellite?.email) {
        await applyUser({ id: satellite.id || satellite.email, email: satellite.email });
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
          const satellite = getSatelliteUser();
          if (satellite?.email) {
            await applyUser({ id: satellite.id || satellite.email, email: satellite.email });
          } else {
            await applyUser(null);
          }
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
    clearSatelliteSession();
    await supabase.auth.signOut();
    await applyUser(null);
  }, [applyUser]);

  return (
    <Ctx.Provider value={{ user, merchant, loading, signOut, configError }}>
      {children}
    </Ctx.Provider>
  );
}
