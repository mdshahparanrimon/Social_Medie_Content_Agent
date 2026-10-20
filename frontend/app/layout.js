import './globals.css';
import AppShell from '@/components/Nav';
import { themeInitScript } from '@/components/theme';

export const metadata = {
  title: 'Content Agent',
  description: 'Your AI content team: plan, write, approve, publish.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
