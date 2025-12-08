import './globals.css';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'EfficoreChat - WhatsApp Business Platform',
  description: 'Plataforma de automatizacion de WhatsApp con IA',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ],
    apple: [
      { url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }
    ],
    shortcut: '/icon.svg'
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'EfficoreChat'
  },
  applicationName: 'EfficoreChat',
  keywords: ['WhatsApp', 'Business', 'Automatizacion', 'IA', 'Chatbot', 'CRM'],
  authors: [{ name: 'EfficoreChat' }],
  openGraph: {
    type: 'website',
    title: 'EfficoreChat - WhatsApp Business Platform',
    description: 'Plataforma de automatizacion de WhatsApp con IA',
    siteName: 'EfficoreChat'
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#00D4FF'
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className="dark">
      <body className="bg-dark-bg text-white min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
