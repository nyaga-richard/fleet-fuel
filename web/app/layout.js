import './globals.css';
import { AuthProvider } from '@/lib/auth';

export const metadata = {
  title: 'Fleet Fuel Management',
  description: 'Self-hosted fleet fuel management system',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
