import type { Metadata } from 'next'
import './globals.css'
import TopBar from '@/components/dashboard/TopBar'

export const metadata: Metadata = {
  title: 'Sensor System Control Panel',
  description: 'High-fidelity real-time sensor monitoring and control',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="h-screen flex flex-col overflow-hidden">
        <TopBar />
        <div className="flex-1 min-h-0 overflow-auto flex flex-col">
          {children}
        </div>
      </body>
    </html>
  )
}
