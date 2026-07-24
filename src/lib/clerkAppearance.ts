/** Light Clerk modal theme — matches Tick3t paper / brand red. */
export const tick3tClerkAppearance = {
  variables: {
    colorPrimary: '#ff4b4b',
    colorBackground: '#ffffff',
    colorText: '#0a0a0a',
    colorTextSecondary: 'rgba(10, 10, 10, 0.55)',
    colorInputBackground: '#ffffff',
    colorInputText: '#0a0a0a',
    colorNeutral: '#0a0a0a',
    colorDanger: '#dc2626',
    colorModalBackdrop: 'rgba(0, 0, 0, 0.45)',
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'z-[100]',
    cardBox: 'bg-white shadow-lg border border-black/10 rounded-2xl',
    card: 'bg-white',
    headerTitle: 'font-extrabold text-ink',
    headerSubtitle: 'text-ink/55',
    formButtonPrimary: 'bg-[#ff4b4b] hover:bg-[#e23b3b] text-white font-bold',
    formFieldInput: 'border border-black/10 bg-white text-ink focus:border-[#ff4b4b]/50',
    footerActionLink: 'text-[#ff4b4b] font-semibold',
  },
} as const;
