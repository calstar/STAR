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
      <body>
        <TopBar />
        {children}
      </body>
    </html>
  )
}
