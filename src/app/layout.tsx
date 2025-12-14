import type { Metadata, Viewport } from "next";
import { Crimson_Pro, DM_Sans } from "next/font/google";
import Script from "next/script";
import { ServiceWorkerProvider } from "@/components/ServiceWorkerProvider";
import "./globals.css";

const crimsonPro = Crimson_Pro({
  variable: "--font-serif",
  subsets: ["latin"],
  display: "swap",
});

const dmSans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Narrator — EPUB Reader with TTS",
  description: "Transform your ebooks into immersive audiobooks with AI-powered text-to-speech and word-level highlighting",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#1a1612",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Enable cross-origin isolation for SharedArrayBuffer/WebAssembly multi-threading */}
        <Script src="/coi-serviceworker.js" strategy="beforeInteractive" />
      </head>
      <body
        className={`${crimsonPro.variable} ${dmSans.variable} font-sans antialiased`}
      >
        <ServiceWorkerProvider>
          {children}
        </ServiceWorkerProvider>
      </body>
    </html>
  );
}
