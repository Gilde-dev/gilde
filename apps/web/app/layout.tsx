import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CopilotProvider } from '@/components/copilot-provider';
import './globals.css';

export const metadata: Metadata = { title: 'Gilde', description: 'Control plane of the AI factory' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CopilotProvider>{children}</CopilotProvider>
      </body>
    </html>
  );
}
