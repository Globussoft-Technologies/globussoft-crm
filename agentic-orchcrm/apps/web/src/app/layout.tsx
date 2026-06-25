import type { Metadata } from 'next';
import { Inter, Sora } from 'next/font/google';
import { Sidebar } from '@/components/layout/Sidebar';
import './globals.css';

// Self-hosted (served from our origin) so they pass the strict CSP.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const sora = Sora({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-sora', display: 'swap' });

export const metadata: Metadata = {
  title: 'Agentic OS — Command Center',
  description: 'Provider-agnostic, sector-adaptable multi-agent orchestration.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable}`}>
      <body className="font-sans text-slate-200 antialiased">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="min-w-0 flex-1 px-8 py-7">{children}</main>
        </div>
      </body>
    </html>
  );
}
