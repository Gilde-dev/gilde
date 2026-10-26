import type { Metadata } from 'next';
import { Figtree, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { CopilotProvider } from '@/components/copilot-provider';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

const sans = Figtree({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = { title: 'Gilde', description: 'Control plane of the AI factory' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <CopilotProvider>{children}</CopilotProvider>
      </body>
    </html>
  );
}
