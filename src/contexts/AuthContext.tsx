import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import ClerkSupabaseBridge from '@/components/ClerkSupabaseBridge';
import { isClerkEnabled } from '@/lib/clerkEnabled';
import { clearSatelliteSession, getSatelliteUser } from '@/lib/satelliteSession';
import { applyPaySsoTokensFromUrl } from '@/lib/sso';
import {
  hasSupabaseConfig,
  signOutViaClerk,
  supabase,
  usesThirdPartySupabaseAuth,
} from '@/lib/supabase';
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
  const clerkEnabled = isClerkEnabled();

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

  const applyClerkSession = useCallback(
    async (bridgeUser: { id: string; email: string; clerkUserId: string } | null) => {
      if (bridgeUser?.email) {
        await applyUser({
          id: bridgeUser.id,
          email: bridgeUser.email,
          clerkUserId: bridgeUser.clerkUserId,
        });
        // Identity link / merchant row can lag one tick after modal sign-up.
        for (const delayMs of [400, 1200]) {
          await new Promise((r) => setTimeout(r, delayMs));
          await applyUser({
            id: bridgeUser.id,
            email: bridgeUser.email,
            clerkUserId: bridgeUser.clerkUserId,
          });
        }
        return;
      }

      // Clerk signed out — keep Pay SSO satellite identity if present.
      const satellite = getSatelliteUser();
      if (satellite?.email) {
        await applyUser({ id: satellite.id || satellite.email, email: satellite.email });
      } else {
        await applyUser(null);
      }
    },
    [applyUser],
  );

  const completeClerkBootstrap = useCallback(() => {
    setLoading(false);
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

      const satellite = getSatelliteUser();

      if (clerkEnabled) {
        // Prefer SSO/satellite until Clerk bridge reports a session (or confirms signed out).
        if (sso?.email) {
          await applyUser({ id: sso.userId, email: sso.email });
        } else if (satellite?.email) {
          await applyUser({ id: satellite.id || satellite.email, email: satellite.email });
        }
        // loading ends via ClerkSupabaseBridge.onBootstrapComplete
        return;
      }

      const { data } = await supabase.auth.getSession();
      if (!on) return;

      const sessionUser = data.session?.user;
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

    if (clerkEnabled || usesThirdPartySupabaseAuth) {
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
  }, [applyUser, clerkEnabled]);

  const signOut = useCallback(async () => {
    clearSatelliteSession();
    if (clerkEnabled) {
      await signOutViaClerk();
    } else {
      await supabase.auth.signOut();
    }
    await applyUser(null);
  }, [applyUser, clerkEnabled]);

  return (
    <Ctx.Provider value={{ user, merchant, loading, signOut, configError }}>
      {clerkEnabled && (
        <ClerkSupabaseBridge
          onSession={applyClerkSession}
          onBootstrapComplete={completeClerkBootstrap}
        />
      )}
      {children}
    </Ctx.Provider>
  );
}
