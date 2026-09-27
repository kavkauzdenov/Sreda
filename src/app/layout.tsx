import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import type { ReactNode } from "react";
import { APP_DESCRIPTION, APP_NAME, BRAND_ASSETS } from "@/config/brand";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { THEME_BOOTSTRAP } from "@/components/theme/bootstrap";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

function metadataBaseFromEnv(): URL | undefined {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.origin !== raw) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export const metadata: Metadata = {
  metadataBase: metadataBaseFromEnv(),
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  icons: {
    icon: [
      {
        url: BRAND_ASSETS.favicon,
        type: "image/svg+xml",
        sizes: "any",
      },
    ],
    shortcut: BRAND_ASSETS.favicon,
  },
  alternates: {
    canonical: "/",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${manrope.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-full bg-[var(--bg-page)] font-sans text-[var(--text-primary)]">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
