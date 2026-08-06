/** Centre-of-mass marker: a sphere plus crosshair axes. */

import { useMemo } from 'react'
import { Billboard, Text } from '@react-three/drei'

interface Props {
  position: [number, number, number]
  /** Scales the marker with the model so it stays visible on any size of part. */
  scale: number
  color: string
  label?: string
  /** Length of the crosshair arms, in model units. */
  armLength: number
}

export function CMMarker({ position, scale, color, label, armLength }: Props) {
  // Three crosshair arms as one lineSegments: six vertices, three pairs.
  // `<line>` is avoided deliberately -- it collides with SVG's line element in
  // React's JSX typings.
  const arms = useMemo(() => {
    const a = armLength
    return new Float32Array([
      -a, 0, 0, a, 0, 0,
      0, -a, 0, 0, a, 0,
      0, 0, -a, 0, 0, a,
    ])
  }, [armLength])

  return (
    <group position={position}>
      <mesh renderOrder={999}>
        <sphereGeometry args={[scale, 24, 24]} />
        {/* depthTest off so the marker stays visible when it falls inside
            the airframe, which for a rocket it essentially always does. */}
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
      </mesh>

      <lineSegments renderOrder={999}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[arms, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
      </lineSegments>

      {label && (
        <Billboard position={[0, scale * 3, 0]}>
          <Text fontSize={scale * 3} color={color} anchorX="center" anchorY="bottom" outlineWidth={scale * 0.3} outlineColor="#000">
            {label}
          </Text>
        </Billboard>
      )}
    </group>
  )
}
