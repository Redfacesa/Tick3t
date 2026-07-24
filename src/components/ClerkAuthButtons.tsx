import { SignInButton, SignUpButton } from '@clerk/react';
import { cls } from '@/lib/format';

type Props = {
  className?: string;
  /** Full-width CTAs for login pages */
  prominent?: boolean;
};

/**
 * Native Tick3t Clerk auth. Sign up with the same email reconnects the shared
 * RedFace Pay hub user (auth_identity_links + merchants).
 */
export default function ClerkAuthButtons({ className, prominent = false }: Props) {
  const signUpClass = prominent
    ? 'w-full rounded-xl bg-brand py-3.5 text-sm font-bold text-white hover:bg-brand/90'
    : 'rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:bg-brand/90';

  const signInClass = prominent
    ? 'w-full rounded-xl border border-black/15 bg-white py-3.5 text-sm font-bold text-ink hover:border-brand/40'
    : 'rounded-xl border border-black/15 bg-white px-5 py-2.5 text-sm font-bold text-ink hover:border-brand/40';

  return (
    <div
      className={cls(
        'flex flex-col',
        prominent ? 'w-full items-stretch gap-3' : 'items-center gap-2',
        className,
      )}
    >
      <SignUpButton mode="modal">
        <button type="button" className={signUpClass}>
          Sign up with your email
        </button>
      </SignUpButton>
      <p className="text-center text-xs leading-relaxed text-ink/45">
        Already on RedFace Pay? <strong className="font-semibold text-ink/70">Sign up</strong> with the{' '}
        <strong className="font-semibold text-ink/70">same email</strong> — your account reconnects
        automatically. Sign in only works after that.
      </p>
      <SignInButton mode="modal">
        <button type="button" className={signInClass}>
          Already signed up? Sign in
        </button>
      </SignInButton>
    </div>
  );
}
