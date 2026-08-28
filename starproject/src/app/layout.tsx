import type { Metadata } from "next";

import { AppHeader } from "@/components/AppHeader";
import { getCurrentSettings } from "@/lib/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: "STARProject",
  description: "STAR team task tracker",
};

export default async function RootLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  const { settings } = await getCurrentSettings();
  return (
    <html lang="en" className={settings.theme === "dark" ? "dark" : ""}>
      <body className="min-h-screen bg-neutral-50 text-neutral-900 dark:text-neutral-100 antialiased dark:bg-neutral-950">
        <AppHeader />
        {children}
        {modal}
      </body>
    </html>
  );
}
