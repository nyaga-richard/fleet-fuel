import './globals.css';

export const metadata = {
  title: 'Fleet Fuel Management',
  description: 'Self-hosted fleet fuel management system',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
