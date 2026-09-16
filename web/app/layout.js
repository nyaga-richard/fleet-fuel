import './globals.css';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';

export const metadata = {
  title: 'Fleet Fuel Management',
  description: 'Self-hosted fleet fuel management system',
};

// §34 — no-flash bootstrap: resolve the stored preference (default SYSTEM)
// against the OS setting before first paint. Same key as lib/theme.js.
const noFlash = `(function(){try{var t=localStorage.getItem('ff_theme')||'SYSTEM';t=String(t).toUpperCase();
if(t!=='LIGHT'&&t!=='DARK')t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'DARK':'LIGHT';
document.documentElement.dataset.theme=t.toLowerCase();}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body>
        <AuthProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
