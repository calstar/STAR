import type { Metadata, Viewport } from "next";
import { Suspense } from "react";

import { Sidebar } from "@/components/Sidebar";
import { TaskModalProvider } from "@/components/TaskModalProvider";
import { getCurrentSettings } from "@/lib/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: "STAR Project",
  description: "STAR team task tracker",
  icons: { icon: "/star-icon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Matches the rail/top-bar's own box exactly (width, height, borders) so the
// real Sidebar popping in behind Suspense never shifts layout.
function SidebarFallback() {
  return (
    <>
      <div className="sticky top-0 z-40 h-14 border-b border-neutral-200 bg-white lg:hidden dark:border-neutral-800 dark:bg-neutral-900" />
      <div className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-neutral-200 bg-white lg:block dark:border-neutral-800 dark:bg-neutral-900" />
    </>
  );
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { settings } = await getCurrentSettings();
  return (
    <html lang="en" className={settings.theme === "dark" ? "dark" : ""}>
      <body className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900 antialiased lg:flex-row dark:bg-neutral-950 dark:text-neutral-100">
        <Suspense fallback={<SidebarFallback />}>
          <Sidebar />
        </Suspense>
        <div className="min-w-0 flex-1">
          <TaskModalProvider>{children}</TaskModalProvider>
        </div>
      </body>
    </html>
  );
}
