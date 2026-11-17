/**
 * The mock API's GET /api/components/defaults/{type} and /api/materials:
 * OpenRocket 24.12's constructor defaults (core/.../rocketcomponent/*.java)
 * and a slice of its built-in material database.
 */
import type { Component, ComponentType, Material, MaterialDb } from '../types'
import { newId } from '../lib/tree'

export const MATERIALS: MaterialDb = {
  bulk: [
    { name: 'Acrylic', density: 1190 },
    { name: 'Aluminum', density: 2700 },
    { name: 'Balsa', density: 170 },
    { name: 'Basswood', density: 500 },
    { name: 'Birch', density: 670 },
    { name: 'Blue tube', density: 1300 },
    { name: 'Cardboard', density: 680 },
    { name: 'Carbon fiber', density: 1780 },
    { name: 'Delrin', density: 1420 },
    { name: 'Fiberglass', density: 1850 },
    { name: 'Kraft phenolic', density: 950 },
    { name: 'Nylon', density: 1150 },
    { name: 'Paper (office)', density: 820 },
    { name: 'Plywood (birch)', density: 630 },
    { name: 'Polycarbonate (Lexan)', density: 1200 },
    { name: 'Polystyrene', density: 1050 },
    { name: 'PVC', density: 1390 },
    { name: 'Quantum tubing', density: 1050 },
    { name: 'Spruce', density: 450 },
    { name: 'Steel', density: 7850 },
    { name: 'Titanium', density: 4500 },
  ],
  surface: [
    { name: 'Cellophane', density: 0.018 },
    { name: 'Cotton', density: 0.05 },
    { name: 'Mylar', density: 0.021 },
    { name: 'Nylon fabric', density: 0.064 },
    { name: 'Polyethylene (thin)', density: 0.015 },
    { name: 'Polyethylene (heavy)', density: 0.04 },
    { name: 'Ripstop nylon', density: 0.067 },
    { name: 'Silk', density: 0.06 },
    { name: 'Paper (office)', density: 0.08 },
  ],
  line: [
    { name: 'Elastic cord (round 2mm, 1/16 in)', density: 0.0018 },
    { name: 'Elastic cord (flat 6mm, 1/4 in)', density: 0.0043 },
    { name: 'Elastic cord (flat 12mm, 1/2 in)', density: 0.008 },
    { name: 'Kevlar thread', density: 0.0003 },
    { name: 'Nylon (tubular 9mm, 3/8 in)', density: 0.0123 },
    { name: 'Nylon (tubular 25mm, 1 in)', density: 0.029 },
    { name: 'Thread (heavy-duty)', density: 0.0003 },
  ],
}

const m = (type: Material['type'], name: string): Material => {
  const e = MATERIALS[type].find((x) => x.name === name)!
  return { type, name, density: e.density }
}

const NAMES: Record<ComponentType, string> = {
  rocket: 'Rocket', stage: 'Stage', parallelstage: 'Boosters', podset: 'Pods',
  nosecone: 'Nose cone', bodytube: 'Body tube', transition: 'Transition',
  trapezoidfinset: 'Trapezoidal fin set', ellipticalfinset: 'Elliptical fin set',
  freeformfinset: 'Freeform fin set', tubefinset: 'Tube fin set',
  launchlug: 'Launch lug', railbutton: 'Rail button',
  innertube: 'Inner tube', tubecoupler: 'Tube coupler', centeringring: 'Centering ring',
  bulkhead: 'Bulkhead', engineblock: 'Engine block',
  masscomponent: 'Mass component', shockcord: 'Shock cord', parachute: 'Parachute', streamer: 'Streamer',
}

function params(type: ComponentType): Component['params'] {
  const card = m('bulk', 'Cardboard')
  switch (type) {
    case 'rocket':
      return { designer: '', designtype: 'original', referencetype: 'maximum' }
    case 'stage':
      return { separationevent: 'ejection', separationdelay: 0 }
    case 'parallelstage':
    case 'podset':
      return { instancecount: 2, axialoffset: { method: 'bottom', value: 0 }, radiusoffset: 0, angleoffset: 0 }
    case 'nosecone':
      return {
        finish: 'normal', material: m('bulk', 'Polystyrene'), length: 0.15, thickness: 0.002,
        shape: 'ogive', shapeparameter: 1, aftradius: { auto: true, value: 0.025 },
        aftshoulderradius: 0, aftshoulderlength: 0, aftshoulderthickness: 0, aftshouldercapped: false, isflipped: false,
      }
    case 'bodytube':
      return { finish: 'normal', material: card, length: 0.3, thickness: 0.002, radius: { auto: true, value: 0.025 } }
    case 'transition':
      return {
        finish: 'normal', material: card, length: 0.1, thickness: 0.002, shape: 'conical', shapeparameter: 0,
        clipped: true, foreradius: { auto: true, value: 0.025 }, aftradius: { auto: true, value: 0.025 },
        foreshoulderradius: 0, foreshoulderlength: 0, foreshoulderthickness: 0, foreshouldercapped: false,
        aftshoulderradius: 0, aftshoulderlength: 0, aftshoulderthickness: 0, aftshouldercapped: false,
      }
    case 'trapezoidfinset':
      return {
        fincount: 3, rotation: 0, angleoffset: 0, axialoffset: { method: 'bottom', value: 0 },
        finish: 'normal', material: card, thickness: 0.003, crosssection: 'square', cant: 0,
        filletradius: 0, filletmaterial: card,
        rootchord: 0.05, tipchord: 0.05, sweeplength: 0.025, height: 0.03,
      }
    case 'ellipticalfinset':
      return {
        fincount: 3, rotation: 0, angleoffset: 0, axialoffset: { method: 'bottom', value: 0 },
        finish: 'normal', material: card, thickness: 0.003, crosssection: 'square', cant: 0,
        filletradius: 0, filletmaterial: card, rootchord: 0.05, height: 0.05,
      }
    case 'freeformfinset':
      return {
        fincount: 3, rotation: 0, angleoffset: 0, axialoffset: { method: 'bottom', value: 0 },
        finish: 'normal', material: card, thickness: 0.003, crosssection: 'square', cant: 0,
        filletradius: 0, filletmaterial: card,
        finpoints: [[0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0]],
      }
    case 'tubefinset':
      return {
        fincount: 6, angleoffset: 0, axialoffset: { method: 'bottom', value: 0 }, finish: 'normal', material: card,
        length: 0.1, outerradius: { auto: true, value: 0.025 }, thickness: 0.002,
      }
    case 'launchlug':
      return {
        instancecount: 1, instanceseparation: 0, angleoffset: 0, axialoffset: { method: 'middle', value: 0 },
        finish: 'normal', material: card, radius: 0.005, length: 0.03, thickness: 0.001,
      }
    case 'railbutton':
      return {
        instancecount: 1, instanceseparation: 0, angleoffset: 0, axialoffset: { method: 'middle', value: 0 },
        finish: 'normal', material: m('bulk', 'Delrin'), outerdiameter: 0.0097, innerdiameter: 0.008,
        totalheight: 0.0097, flangeheight: 0.002, baseheight: 0.002, screwheight: 0,
      }
    case 'innertube':
      return {
        axialoffset: { method: 'top', value: 0 }, material: card, length: 0.07,
        outerradius: 0.0095, thickness: 0.0005, radialposition: 0, radialdirection: 0,
        clusterconfiguration: 'single', clusterscale: 1, clusterrotation: 0,
      }
    case 'tubecoupler':
      return { axialoffset: { method: 'top', value: 0 }, material: card, length: 0.06, outerradius: { auto: true, value: 0.0235 }, thickness: 0.002 }
    case 'centeringring':
      return {
        instancecount: 1, instanceseparation: 0, axialoffset: { method: 'top', value: 0 }, material: card, length: 0.002,
        outerradius: { auto: true, value: 0.0235 }, innerradius: { auto: true, value: 0 },
      }
    case 'bulkhead':
      return { instancecount: 1, instanceseparation: 0, axialoffset: { method: 'top', value: 0 }, material: card, length: 0.002, outerradius: { auto: true, value: 0.0235 } }
    case 'engineblock':
      return { axialoffset: { method: 'top', value: 0 }, material: card, length: 0.005, outerradius: { auto: true, value: 0.009 }, thickness: 0.005 }
    case 'masscomponent':
      return {
        axialoffset: { method: 'top', value: 0 }, packedlength: 0.025, packedradius: 0.0125,
        radialposition: 0, radialdirection: 0, mass: 0, masscomponenttype: 'masscomponent',
      }
    case 'shockcord':
      return {
        axialoffset: { method: 'top', value: 0 }, packedlength: 0.025, packedradius: { auto: true, value: 0.0125 },
        radialposition: 0, radialdirection: 0, cordlength: 0.4, material: m('line', 'Elastic cord (round 2mm, 1/16 in)'),
      }
    case 'parachute':
      return {
        axialoffset: { method: 'top', value: 0 }, packedlength: 0.025, packedradius: { auto: true, value: 0.0125 },
        radialposition: 0, radialdirection: 0, cd: { auto: true, value: 0.8 }, material: m('surface', 'Ripstop nylon'),
        deployevent: 'ejection', deployaltitude: 200, deploydelay: 0, diameter: 0.3,
        linecount: 6, linelength: 0.3, linematerial: m('line', 'Elastic cord (round 2mm, 1/16 in)'),
      }
    case 'streamer':
      return {
        axialoffset: { method: 'top', value: 0 }, packedlength: 0.025, packedradius: { auto: true, value: 0.0125 },
        radialposition: 0, radialdirection: 0, cd: { auto: true, value: 0.6 }, material: m('surface', 'Ripstop nylon'),
        deployevent: 'ejection', deployaltitude: 200, deploydelay: 0, striplength: 0.5, stripwidth: 0.05,
      }
  }
}

export function defaultComponent(type: ComponentType): Component {
  return { id: newId(), type, name: NAMES[type], params: params(type), children: [] }
}

export function newRocketDocument(): import('../types').RocketDocument {
  const stage = defaultComponent('stage')
  stage.name = 'Sustainer'
  const rocket = defaultComponent('rocket')
  rocket.children = [stage]
  const cfg = newId()
  return {
    version: 1,
    rocket,
    motorConfigs: [{ id: cfg, name: '', default: true, stages: { '0': true }, motors: {} }],
    selectedConfig: cfg,
  }
}
