import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import App from '@/App';
import { isClerkEnabled } from '@/lib/clerkEnabled';
import '@/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

const tree = (
  <StrictMode>
    <App />
  </StrictMode>
);

// Clerk is optional UI only — session identity comes from RedFace Pay SSO → Supabase.
createRoot(root).render(
  isClerkEnabled() ? (
    <ClerkProvider
      publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
      afterSignOutUrl="/"
    >
      {tree}
    </ClerkProvider>
  ) : (
    tree
  ),
);
