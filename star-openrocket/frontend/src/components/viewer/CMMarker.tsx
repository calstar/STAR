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

/**
 * Above every other render order in the scene (part draw orders, edges, the
 * selection mask/hull at 1000/1001, and the face-selection highlight), so a
 * marker is never hidden behind geometry or an overlay.
 */
const MARKER_RENDER_ORDER = 10000

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
      <mesh renderOrder={MARKER_RENDER_ORDER}>
        <sphereGeometry args={[scale, 24, 24]} />
        {/* depthTest + depthWrite off so the marker floats to the front of the
            canvas, ahead of every highlight/planform, and never occludes them. */}
        <meshBasicMaterial color={color} depthTest={false} depthWrite={false} transparent opacity={0.95} />
      </mesh>

      <lineSegments renderOrder={MARKER_RENDER_ORDER}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[arms, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} depthTest={false} depthWrite={false} transparent opacity={0.9} />
      </lineSegments>

      {label && (
        <Billboard position={[0, scale * 3, 0]}>
          <Text
            fontSize={scale * 3}
            anchorX="center"
            anchorY="bottom"
            outlineWidth={scale * 0.3}
            outlineColor="#000"
            renderOrder={MARKER_RENDER_ORDER}
          >
            {label}
            {/* A real material on the label so depth is actually disabled --
                troika honours the provided base material. */}
            <meshBasicMaterial color={color} depthTest={false} depthWrite={false} transparent />
          </Text>
        </Billboard>
      )}
    </group>
  )
}
