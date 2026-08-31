/**
 * Subteams. Shown as a teaser grid on the Home page and in full on Join.
 */

export interface Subteam {
  id: string;
  name: string;
  /** One-liner for the Home teaser grid. */
  blurb: string;
  /** Full description for the Join page. */
  description: string;
  image: string;
}

export const SUBTEAMS: Subteam[] = [
  {
    id: 'aerostructures',
    name: 'Aerostructures',
    blurb: 'The airframe and recovery — everything that holds the rocket together and brings it home.',
    description:
      "Designs, constructs, and optimizes the rocket's structure — body, fins, and airframe — for stability, aerodynamics, and integrity under the forces of launch and flight. Aerostructures also owns recovery: the parachutes and deployment systems that bring every vehicle safely back to the ground, accounting for altitude, descent rate, and wind, in close coordination with avionics for deployment timing.",
    image: '/img/subteams/airframe.webp',
  },
  {
    id: 'propulsion',
    name: 'Propulsion',
    blurb: 'Building Berkeley’s liquid rocket engines from the injector out.',
    description:
      "Designs, builds, and tests the rocket's propulsion system — including the engine and associated components. On our team, propulsion develops the liquid engine featured in our liquid-series vehicles, working with avionics and airframe to integrate the engine seamlessly and optimize its performance through testing.",
    image: '/img/subteams/propulsion.webp',
  },
  {
    id: 'avionics',
    name: 'Avionics',
    blurb: 'The electronics and firmware that fly, sense, and record the rocket.',
    description:
      "Develops the electronic systems that control and monitor the rocket's flight — sensors, microcontrollers, and communication systems. Avionics ensures accurate data collection, precise trajectory control, and successful recovery deployment, collaborating with airframe and propulsion for seamless integration.",
    image: '/img/subteams/avonics.webp',
  },
  {
    id: 'payload',
    name: 'Payload',
    blurb: 'The science that rides along — from muon detectors to fuel cells.',
    description:
      'Designs, builds, and integrates the scientific and experimental equipment the rocket carries. Payload ensures the experiment is securely housed, meets mission requirements, and survives the conditions of launch and ascent — working with avionics for data collection and integration.',
    image: '/img/subteams/payload.webp',
  },
  {
    id: 'outreach',
    name: 'Outreach',
    blurb: 'Connecting STAR to the community and inspiring the next engineers.',
    description:
      'Builds connections with the broader community, promotes the club, and fosters interest in rocketry and STEM. Outreach runs educational programs, workshops, and demonstrations, collaborates with schools, and raises awareness of our projects and the field of rocket science.',
    image: '/img/subteams/outreach.webp',
  },
  {
    id: 'media',
    name: 'Media',
    blurb: 'Photo, video, and the story of the team — including this website.',
    description:
      'Captures photos and videos of club activities and operates our social media and this website. Media works closely with every team to visually document project work and produce content in support of public relations and sponsor relations — a place to interact with every subteam and pursue creative work at your own pace.',
    image: '/img/subteams/media.webp',
  },
  {
    id: 'operations',
    name: 'Operations',
    blurb: 'Runs the launches and hotfires — logistics, safety, and procedures.',
    description:
      'Keeps our launches and hotfires running smoothly and safely. Operations owns the logistics, documentation, and safety procedures behind every test and flight, coordinating across subteams so the team can focus on building while test days stay organized and low-stress.',
    image: '/img/subteams/operations.webp',
  },
];
