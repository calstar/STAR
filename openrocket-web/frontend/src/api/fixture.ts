/**
 * OpenRocket's bundled example "A simple model rocket", hand-transcribed from
 * tests/rockets/A simple model rocket.ork into the SCHEMA.md document shape,
 * and the design-view numbers OpenRocket 24.12 itself gives for it
 * (tests/golden/A simple model rocket.json, Mach 0.3, AoA 0, config C6-5).
 *
 * Angles are radians on the wire (SCHEMA.md); the .ork writes the launch lug's
 * 19.0 in degrees, so it is converted here.
 */
import type { Analysis, Component, Material, RocketDocument } from '../types'

const CARDBOARD: Material = { type: 'bulk', density: 680.0, name: 'Cardboard' }
const POLYSTYRENE: Material = { type: 'bulk', density: 1050.0, name: 'Polystyrene' }
const RIPSTOP: Material = { type: 'surface', density: 0.067, name: 'Ripstop nylon' }
const ELASTIC: Material = { type: 'line', density: 0.0018, name: 'Elastic cord (round 2mm, 1/16 in)' }

const DEG = Math.PI / 180

export const ID = {
  rocket: '13fcc99a-97af-4285-a18b-3748b018fbdf',
  stage: '51c9a60e-465f-40e8-8a10-aee9732aa47a',
  nose: 'f742413d-bf05-4ac6-ab04-0c410feebc08',
  body: '23676342-cab1-4180-bdc3-645af8cec2ca',
  chute: '99a9ba6b-15ea-4c14-8ddc-a2b95453ff5c',
  cord: 'b3f082f4-52e0-4804-841d-d502f9b134e7',
  wadding: '9e56185b-6429-41e9-ab4d-7f869ee1a86b',
  lug: '1acfd7b9-e645-45da-8704-2e523297c942',
  fins: '9acd3480-76fb-4d48-b203-ce394d8c3d8e',
  ring1: '1ad78625-8389-4894-8ba4-9d98209d57d7',
  ring2: 'a47c0331-7554-4bc9-80cc-490ef68aa4f5',
  mmt: '9c92077c-f74f-4c95-b6ab-0dc765a377e7',
  block: 'e2613fe3-cb14-4d73-ba98-a62f4ea723ec',
} as const

const CFG = {
  a8: 'da326836-0959-4c94-bcd5-49dee07235a4',
  b4: '05896b5a-71a7-48ac-b7ae-eadeb267975b',
  c63: 'b13e8ca2-f54d-4ca8-9b23-06c6c9eb237a',
  c65: 'e1dc7488-77c0-403a-b54f-c01db07aba2f',
  c67: '5d9a2765-395d-4d9c-9678-38eed0988c72',
} as const

function leaf(id: string, type: Component['type'], name: string, params: Component['params']): Component {
  return { id, type, name, params, children: [] }
}

const rocket: Component = {
  id: ID.rocket,
  type: 'rocket',
  name: 'A simple model rocket',
  params: { designer: 'Sampo Niskanen', designtype: 'original', referencetype: 'maximum' },
  children: [
    {
      id: ID.stage,
      type: 'stage',
      name: 'Sustainer',
      params: {},
      children: [
        leaf(ID.nose, 'nosecone', 'Nose cone', {
          finish: 'normal', material: POLYSTYRENE,
          length: 0.1, thickness: 0.002, shape: 'ogive', shapeparameter: 1.0,
          aftradius: { auto: false, value: 0.0125 },
          aftshoulderradius: 0.0115, aftshoulderlength: 0.02, aftshoulderthickness: 0.002,
          aftshouldercapped: true, isflipped: false,
        }),
        {
          id: ID.body,
          type: 'bodytube',
          name: 'Body tube',
          params: {
            finish: 'normal', material: CARDBOARD,
            length: 0.3, thickness: 0.001, radius: { auto: true, value: 0.0125 },
          },
          children: [
            leaf(ID.chute, 'parachute', 'Parachute', {
              axialoffset: { method: 'top', value: 0.032 },
              packedlength: 0.042, packedradius: 0.009, radialposition: 0, radialdirection: 0,
              cd: { auto: true, value: 0.8 }, material: RIPSTOP,
              deployevent: 'ejection', deployaltitude: 200.0, deploydelay: 0.0,
              diameter: 0.3, linecount: 6, linelength: 0.3, linematerial: ELASTIC,
            }),
            leaf(ID.cord, 'shockcord', 'Shock cord', {
              axialoffset: { method: 'top', value: 0.02 },
              comment: 'The shock cord does not need to be attached to anything in particular, as it functions only as a mass component.',
              packedlength: 0.052, packedradius: 0.006, radialposition: 0, radialdirection: 0,
              cordlength: 0.4, material: ELASTIC,
            }),
            leaf(ID.wadding, 'masscomponent', 'Wadding', {
              axialoffset: { method: 'top', value: 0.08 },
              packedlength: 0.03, packedradius: 0.0115, radialposition: 0, radialdirection: 0,
              mass: 0.002, masscomponenttype: 'masscomponent',
            }),
            leaf(ID.lug, 'launchlug', 'Launch lug', {
              instancecount: 1, instanceseparation: 0, angleoffset: 19.0 * DEG,
              axialoffset: { method: 'middle', value: 0 },
              finish: 'normal', material: CARDBOARD,
              radius: 0.0035, length: 0.035, thickness: 0.001,
            }),
            leaf(ID.fins, 'trapezoidfinset', 'Trapezoidal fin set', {
              fincount: 3, rotation: 0, angleoffset: 0,
              axialoffset: { method: 'bottom', value: 0 },
              finish: 'normal', material: CARDBOARD,
              thickness: 0.002, crosssection: 'rounded', cant: 0, filletradius: 0, filletmaterial: CARDBOARD,
              rootchord: 0.0508, tipchord: 0.0508, sweeplength: 0.0254, height: 0.03,
            }),
            leaf(ID.ring1, 'centeringring', 'Centering ring', {
              instancecount: 1, instanceseparation: 0,
              axialoffset: { method: 'bottom', value: -0.045 },
              comment: 'The centering ring automatically takes the outer diameter of the body tube and the inner diameter of the inner tube.',
              material: CARDBOARD, length: 0.002, radialposition: 0, radialdirection: 0,
              outerradius: { auto: true, value: 0.0115 }, innerradius: { auto: true, value: 0.0095 },
            }),
            leaf(ID.ring2, 'centeringring', 'Centering ring', {
              instancecount: 1, instanceseparation: 0,
              axialoffset: { method: 'bottom', value: 0 },
              comment: 'The centering ring automatically takes the outer diameter of the body tube and the inner diameter of the inner tube.',
              material: CARDBOARD, length: 0.002, radialposition: 0, radialdirection: 0,
              outerradius: { auto: true, value: 0.0115 }, innerradius: { auto: true, value: 0.0095 },
            }),
            {
              id: ID.mmt,
              type: 'innertube',
              name: 'Inner Tube',
              params: {
                axialoffset: { method: 'bottom', value: 0.005 },
                material: CARDBOARD, length: 0.075, radialposition: 0, radialdirection: 0,
                outerradius: 0.0095, thickness: 0.0005,
                clusterconfiguration: 'single', clusterscale: 1.0, clusterrotation: 0,
                motormount: { ignitionevent: 'automatic', ignitiondelay: 0, overhang: 0.003 },
              },
              children: [
                leaf(ID.block, 'engineblock', 'Engine block', {
                  axialoffset: { method: 'top', value: 0.002 },
                  material: CARDBOARD, length: 0.005, radialposition: 0, radialdirection: 0,
                  outerradius: { auto: true, value: 0.009 }, thickness: 0.003,
                }),
              ],
            },
          ],
        },
      ],
    },
  ],
}

function estes(designation: string, digest: string, delay: number) {
  return { [ID.mmt]: { designation, manufacturer: 'Estes', digest, delay, ignitionEvent: 'automatic', ignitionDelay: 0 } }
}

export const SIMPLE_ROCKET: RocketDocument = {
  version: 1,
  rocket,
  motorConfigs: [
    { id: CFG.a8, name: '', stages: { '0': true }, motors: estes('A8', '22aec01287ea1e3b8c6f66b26fe5fea6', 3) },
    { id: CFG.b4, name: '', stages: { '0': true }, motors: estes('B4', 'c15b9b96bf06e0ab896394787da3c47e', 4) },
    { id: CFG.c63, name: '', stages: { '0': true }, motors: estes('C6', 'c8743ef3fa99e14a89885cbe0ead47b2', 3) },
    { id: CFG.c65, name: '', default: true, stages: { '0': true }, motors: estes('C6', 'c8743ef3fa99e14a89885cbe0ead47b2', 5) },
    { id: CFG.c67, name: '', stages: { '0': true }, motors: estes('C6', 'c8743ef3fa99e14a89885cbe0ead47b2', 7) },
  ],
  selectedConfig: CFG.c65,
}

/**
 * OpenRocket 24.12's own numbers for SIMPLE_ROCKET at M=0.3, AoA 0, C6-5
 * (golden file: rocket.launch / rocket.structure, aero[mach=0.3, aoa=0]).
 * `figure` is left empty here; the mock fills it from the geometry.
 */
export const SIMPLE_ROCKET_GOLDEN: Omit<Analysis, 'figure' | 'components'> & {
  components: Pick<Analysis['components'][number], 'id' | 'name' | 'x' | 'mass' | 'cgx' | 'cpx' | 'cna'>[]
} = {
  conditions: { mach: 0.3, aoaDeg: 0, rollRate: 0, theta: 0, configId: CFG.c65 },
  reference: { length: 0.025, area: 0.000490873852123405 },
  length: 0.4254,
  maxDiameter: 0.025,
  cg: { x: 0.259812312416435, mass: 0.0712591305052178 },
  cgEmpty: { x: 0.205520726257148, mass: 0.0481591305052178 },
  cp: { x: 0.319768805338136, cna: 11.9701731527066 },
  stability: { calibers: (0.319768805338136 - 0.259812312416435) / 0.025, percent: 100 * (0.319768805338136 - 0.259812312416435) / 0.4254 },
  cd: { total: 0.633936647157599, friction: 0.429519044674109, pressure: 0.0727176024834907, base: 0.1317 },
  components: [
    { id: ID.nose, name: 'Nose cone', x: 0, mass: 0.0131559761619466, cgx: 0.0760200608311203, cpx: 0.0464305528638605, cna: 2.0 },
    { id: ID.body, name: 'Body tube', x: 0.1, mass: 0.0153812376319756, cgx: 0.25, cpx: 0, cna: 0 },
    { id: ID.chute, name: 'Parachute', x: 0.132, mass: 0.00797595092528661, cgx: 0.153, cpx: 0, cna: 0 },
    { id: ID.cord, name: 'Shock cord', x: 0.12, mass: 0.00072, cgx: 0.146, cpx: 0, cna: 0 },
    { id: ID.wadding, name: 'Wadding', x: 0.18, mass: 0.002, cgx: 0.195, cpx: 0, cna: 0 },
    { id: ID.lug, name: 'Launch lug', x: 0.2325, mass: 0.000448619430932623, cgx: 0.25, cpx: 0, cna: 0 },
    { id: ID.fins, name: 'Trapezoidal fin set', x: 0.3492, mass: 0.0061557408, cgx: 0.3873, cpx: 0.3746, cna: 9.97017315270664 },
    { id: ID.ring1, name: 'Centering ring', x: 0.353, mass: 0.000179447772373049, cgx: 0.354, cpx: 0, cna: 0 },
    { id: ID.ring2, name: 'Centering ring', x: 0.398, mass: 0.000179447772373049, cgx: 0.399, cpx: 0, cna: 0 },
    { id: ID.mmt, name: 'Inner Tube', x: 0.33, mass: 0.00148204633433099, cgx: 0.3675, cpx: 0, cna: 0 },
    { id: ID.block, name: 'Engine block', x: 0.332, mass: 0.000480663675999238, cgx: 0.3345, cpx: 0, cna: 0 },
  ],
  warnings: [],
}
