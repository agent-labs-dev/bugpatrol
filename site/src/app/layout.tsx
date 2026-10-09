import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains' });

const siteUrl = 'https://agent-labs-dev.github.io/bugpatrol/';
const title = 'Bugpatrol: a QA team made of agents';
const description =
  'Bugpatrol uses your app the way a tester does, finds bugs, fixes them, checks each fix in the running app, and opens the pull requests. Web, Electron, iOS, Android, desktop, HTTP APIs and CLIs. Open source.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  icons: { icon: `${process.env.NEXT_PUBLIC_BASE_PATH}/assets/logo.svg` },
  openGraph: { title, description, url: siteUrl, type: 'website', images: ['assets/social-preview.png'] },
  twitter: { card: 'summary_large_image', title, description, images: ['assets/social-preview.png'] },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
