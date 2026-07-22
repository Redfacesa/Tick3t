export const fmtMoney = (n: number, cur = 'ZAR') => {
  const sym: Record<string, string> = { ZAR: 'R', NGN: '₦', GHS: 'GH₵', KES: 'KSh', USD: '$' };
  return (sym[cur] || cur + ' ') + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
};

export const cls = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(' ');
