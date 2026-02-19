'use client'

import { useSensorStore } from '@/lib/store'
import { useEffect } from 'react'
import { getWebSocketClient } from '@/lib/websocket'
import { MessageType, SensorUpdate } from '@/lib/types'
import WindowLauncher from '@/components/windows/WindowLauncher'

export default function Home() {
  const updateSensor = useSensorStore((state) => state.updateSensor)
  const ws = getWebSocketClient()

  useEffect(() => {
    ws.connect()
    const unsubscribe = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      updateSensor(payload as SensorUpdate)
    })
    return unsubscribe
  }, [ws, updateSensor])

  return (
    <main className="min-h-screen bg-background text-text p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold mb-8">Sensor System Control Panel</h1>

        {/* Multi-Window Launcher */}
        <div className="mb-8">
          <WindowLauncher />
        </div>
      </div>
    </main>
  )
}
