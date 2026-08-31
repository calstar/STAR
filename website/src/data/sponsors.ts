/**
 * Sponsors.
 *
 * To add a sponsor: drop a logo in /public/img/sponsors/ and add an entry.
 * Prefer SVG or a transparent PNG. Logos render on a light chip, so dark or
 * black logos show up fine.
 */

export interface Sponsor {
  name: string;
  url: string;
  logo: string;
}

export const SPONSORS: Sponsor[] = [
  { name: 'Boeing', url: 'https://www.boeing.com/', logo: '/img/sponsors/boeing.svg' },
  { name: 'Blue Origin', url: 'https://www.blueorigin.com/', logo: '/img/sponsors/blue_origin.svg' },
  { name: 'General Motors', url: 'https://www.gm.com/', logo: '/img/sponsors/general_motors.svg' },
  { name: 'Dassault Systèmes', url: 'https://www.3ds.com/', logo: '/img/sponsors/dassault_systemes.svg' },
  { name: 'Onshape', url: 'https://www.onshape.com/', logo: '/img/sponsors/onshape.svg' },
  { name: 'Ansys', url: 'https://www.ansys.com/', logo: '/img/sponsors/ansys.svg' },
  { name: '3D Systems', url: 'https://www.3dsystems.com/', logo: '/img/sponsors/3d_systems.svg' },
  { name: 'Protolabs', url: 'https://www.protolabs.com/', logo: '/img/sponsors/protolabs.svg' },
  { name: 'Insta360', url: 'https://www.insta360.com/', logo: '/img/sponsors/insta360.svg' },
  { name: 'JLCPCB', url: 'https://jlcpcb.com/', logo: '/img/sponsors/jlcpcb.png' },
  { name: 'Bay Area Circuits', url: 'https://bayareacircuits.com/', logo: '/img/sponsors/bay_area_circuits.png' },
  { name: 'Seamless Tanks', url: 'https://seamlesstanks.com/', logo: '/img/sponsors/seamless_tanks.png' },
  { name: 'Graphite Store', url: 'https://www.graphitestore.com/', logo: '/img/sponsors/graphite_store.png' },
  { name: 'Baktek', url: 'https://www.baktek.net/', logo: '/img/sponsors/baktek.png' },
  { name: 'Mach 1 Hot Sauce', url: 'https://mach1hotsauce.com/', logo: '/img/sponsors/mach1hotsauce.png' },
  { name: 'Engineering Student Council', url: 'https://esc.berkeley.edu/', logo: '/img/sponsors/esc.png' },
  { name: 'Space Sciences Laboratory', url: 'https://www.ssl.berkeley.edu/', logo: '/img/sponsors/ssl.png' },
  { name: 'ASUC', url: 'https://asuc.org/', logo: '/img/sponsors/asuc.png' },
];
