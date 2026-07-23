/** Pay SSO satellite session — supports Clerk access_token-only returns. */

const TOKEN_KEY = 'tick3t_pay_sso_access_v1';
const USER_KEY = 'tick3t_pay_sso_user_v1';

export type SatelliteUser = {
  id: string;
  email: string;
};

export function getSatelliteAccessToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getSatelliteUser(): SatelliteUser | null {
  try {
    const raw = sessionStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SatelliteUser;
    if (!parsed?.email) return null;
    return { id: String(parsed.id || ''), email: String(parsed.email).toLowerCase() };
  } catch {
    return null;
  }
}

export function setSatelliteSession(input: {
  accessToken: string;
  email: string;
  userId: string;
}): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, input.accessToken);
    sessionStorage.setItem(
      USER_KEY,
      JSON.stringify({
        id: input.userId,
        email: input.email.trim().toLowerCase(),
      }),
    );
  } catch {
    /* private mode */
  }
}

export function clearSatelliteSession(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}
