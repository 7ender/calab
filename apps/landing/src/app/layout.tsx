import type { ReactNode } from 'react';

// Pass-through root layout: <html lang> depends on the locale, so [locale]/layout.tsx and not-found.tsx
// render the document themselves; the root `/` is a plain HTML redirect page (route.ts), not a React page.
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
