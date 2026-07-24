import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import App from '@/App';
import { tick3tClerkAppearance } from '@/lib/clerkAppearance';
import { isClerkEnabled } from '@/lib/clerkEnabled';
import '@/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

const tree = (
  <StrictMode>
    <App />
  </StrictMode>
);

// Clerk is primary auth UI when configured — clerk-link creates the shared hub user.
// Pay ecosystem SSO remains a fallback for satellites without a Clerk key.
createRoot(root).render(
  isClerkEnabled() ? (
    <ClerkProvider
      publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
      appearance={tick3tClerkAppearance}
      afterSignOutUrl="/"
    >
      {tree}
    </ClerkProvider>
  ) : (
    tree
  ),
);
