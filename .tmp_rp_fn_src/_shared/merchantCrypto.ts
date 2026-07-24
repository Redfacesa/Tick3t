import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type CryptoAsset = 'btc' | 'eth' | 'usdt_trc20' | 'usdt_erc20';

export const CRYPTO_ASSETS: Record<
  CryptoAsset,
  { coingeckoId: string; label: string; decimals: number; network: string }
> = {
  btc: { coingeckoId: 'bitcoin', label: 'Bitcoin (BTC)', decimals: 8, network: 'Bitcoin' },
  eth: { coingeckoId: 'ethereum', label: 'Ethereum (ETH)', decimals: 6, network: 'Ethereum' },
  usdt_trc20: { coingeckoId: 'tether', label: 'USDT (TRC-20)', decimals: 2, network: 'TRON' },
  usdt_erc20: { coingeckoId: 'tether', label: 'USDT (ERC-20)', decimals: 2, network: 'Ethereum' },
};

type CryptoSettingsRow = {
  merchant_id: string;
  enabled: boolean;
  btc_address: string | null;
  eth_address: string | null;
  usdt_trc20_address: string | null;
  usdt_erc20_address: string | null;
  default_asset: CryptoAsset;
  instructions: string | null;
};

export function walletForAsset(settings: CryptoSettingsRow, asset: CryptoAsset): string | null {
  const map: Record<CryptoAsset, string | null> = {
    btc: settings.btc_address,
    eth: settings.eth_address,
    usdt_trc20: settings.usdt_trc20_address,
    usdt_erc20: settings.usdt_erc20_address,
  };
  const addr = map[asset];
  return addr && addr.trim() ? addr.trim() : null;
}

export async function fetchCryptoFiatRate(asset: CryptoAsset, fiat: string): Promise<number | null> {
  const meta = CRYPTO_ASSETS[asset];
  if (!meta) return null;
  const vs = fiat.toLowerCase() === 'zar' ? 'zar' : fiat.toLowerCase();
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${meta.coingeckoId}&vs_currencies=${vs}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json() as Record<string, Record<string, number>>;
  const rate = data[meta.coingeckoId]?.[vs];
  return typeof rate === 'number' && rate > 0 ? rate : null;
}

export function roundCryptoAmount(amount: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.ceil(amount * factor) / factor;
}

export async function createCryptoPaymentRequest(
  admin: SupabaseClient,
  input: {
    merchantId: string;
    fiatAmount: number;
    fiatCurrency: string;
    asset: CryptoAsset;
    customerEmail?: string | null;
    customerNote?: string | null;
    paymentSessionId?: string | null;
    ttlMinutes?: number;
  },
): Promise<{ ok: true; request: Record<string, unknown> } | { ok: false; message: string }> {
  const { data: settings, error: settingsErr } = await admin
    .from('merchant_crypto_settings')
    .select('*')
    .eq('merchant_id', input.merchantId)
    .maybeSingle();

  if (settingsErr || !settings?.enabled) {
    return { ok: false, message: 'Crypto payments are not enabled for this merchant.' };
  }

  const asset = input.asset in CRYPTO_ASSETS ? input.asset : (settings.default_asset as CryptoAsset);
  const wallet = walletForAsset(settings as CryptoSettingsRow, asset);
  if (!wallet) {
    return { ok: false, message: `No wallet address configured for ${CRYPTO_ASSETS[asset].label}.` };
  }

  const fiatAmount = Math.round(Number(input.fiatAmount) * 100) / 100;
  if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) {
    return { ok: false, message: 'Enter a valid amount.' };
  }

  const fiatCurrency = String(input.fiatCurrency || 'ZAR').toUpperCase();
  const rate = await fetchCryptoFiatRate(asset, fiatCurrency);
  if (!rate) {
    return { ok: false, message: 'Could not fetch live crypto rate. Try again in a moment.' };
  }

  const cryptoAmount = roundCryptoAmount(fiatAmount / rate, CRYPTO_ASSETS[asset].decimals);
  const reference = `RFC-${input.merchantId.slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const ttl = Math.min(Math.max(Number(input.ttlMinutes) || 60, 15), 24 * 60);
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();

  const { data: row, error } = await admin
    .from('crypto_payment_requests')
    .insert({
      merchant_id: input.merchantId,
      reference,
      fiat_amount: fiatAmount,
      fiat_currency: fiatCurrency,
      asset,
      crypto_amount: cryptoAmount,
      crypto_rate: rate,
      wallet_address: wallet,
      customer_email: input.customerEmail?.trim() || null,
      customer_note: input.customerNote?.trim() || null,
      payment_session_id: input.paymentSessionId || null,
      expires_at: expiresAt,
    })
    .select('*')
    .single();

  if (error || !row) {
    return { ok: false, message: error?.message || 'Could not create crypto payment request.' };
  }

  await admin.rpc('track_merchant_business_event', {
    p_merchant_id: input.merchantId,
    p_event_type: 'crypto_payment_requested',
    p_amount: fiatAmount,
    p_currency: fiatCurrency,
    p_session_id: reference,
    p_source: 'crypto',
    p_idempotency_key: `crypto_req:${reference}`,
    p_payload: { asset, crypto_amount: cryptoAmount, wallet_address: wallet },
  });

  return { ok: true, request: row as Record<string, unknown> };
}
