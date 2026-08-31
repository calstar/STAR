/**
 * Project / launch history.
 *
 * This is the single source of truth for the Projects timeline. Edit here to
 * add a launch, fix a stat, or swap a photo — the timeline renders straight
 * from this array. Ordering is handled by the page (newest first), so you can
 * keep entries in any order; sort key is `year`.
 */

export type ProjectKind = 'vehicle' | 'engine' | 'demonstrator';

export interface Project {
  id: string;
  name: string;
  /** Short descriptor shown under the name, e.g. "1st Liquid Vehicle". */
  tagline: string;
  /** Numeric sort key — the (start) year of the project. */
  year: number;
  /** Human-readable date/era shown on the node, e.g. "IREC 2024" or "2021–". */
  era: string;
  kind: ProjectKind;
  /** Headline stat, e.g. "27,326 ft apogee". Optional. */
  stat?: string;
  /** Longer stat label, e.g. "UC Berkeley apogee record". Optional. */
  statLabel?: string;
  image: string;
  description: string;
  /** True for the team's active builds — pinned to the top of the page. */
  current?: boolean;
}

export const PROJECTS: Project[] = [
  // ── Currently building ──────────────────────────────────────────────────
  {
    id: 'le4',
    name: 'LE4',
    tagline: '4th Liquid Engine',
    year: 2026,
    era: '2026–',
    kind: 'engine',
    image: '/img/projects/le4.webp',
    current: true,
    description:
      "LE4 is the next chapter in STAR's liquids program — our fourth liquid engine and most ambitious propulsion project yet. The team is designing the engine, its feed system, tanks, and airframe in-house.",
  },

  // ── Flight vehicles & engines, newest → oldest ──────────────────────────
  {
    id: 'gojira',
    name: 'Gojira',
    tagline: 'Latest flight vehicle',
    year: 2026,
    era: 'May 2026',
    kind: 'vehicle',
    stat: '20,000 ft',
    statLabel: '~Mach 1.6',
    image: '/img/projects/gojira.webp',
    description:
      'Our high-performance solid rocket, Gojira, was designed to reach 20,000 feet and speeds of approximately Mach 1.6. The vehicle served as an important testbed for STAR’s recovery systems, flying our first-ever reusable aluminum high-altitude black powder recovery charges. Gojira allowed us to validate this new deployment hardware under demanding flight conditions while advancing our experience with high-altitude, supersonic vehicle design and recovery.',
  },
  {
    id: 'le3',
    name: 'LE3',
    tagline: '3rd Liquid Engine · “Diablo”',
    year: 2026,
    era: '2024–2026',
    kind: 'engine',
    stat: 'Custom DAQ',
    statLabel: 'live monitor & control',
    image: '/img/projects/le3engine.webp',
    description:
      "LE3 (Diablo) was STAR’s third liquid engine — a multi-year development project running from 2024 to 2026. A major part of LE3 was our custom data-acquisition and control system (DAQ), which monitors and commands the engine live throughout every hotfire.",
  },
  {
    id: 'flight-computer',
    name: 'Flight Computer',
    tagline: 'In-house avionics',
    year: 2021,
    era: '2021–2024',
    kind: 'engine',
    stat: '13 sensors',
    statLabel: 'GNSS · baro · IMU',
    image: '/img/projects/flight_computer.webp',
    description:
      'A revolutionary amateur rocketry flight computer offering superior performance at a lower price than the TeleMega or Blue Raven. It features full datalogging and live telemetry with 13 sensors (1× GNSS, 3× barometer, 6× accelerometer, 3× gyroscope) with advanced sensor fusion and extended Kalman filtering.',
  },
  {
    id: 'excalibur',
    name: 'Excalibur',
    tagline: 'Competition solid',
    year: 2025,
    era: 'IREC 2025',
    kind: 'vehicle',
    stat: '10,000 ft',
    statLabel: 'target apogee',
    image: '/img/projects/excalibur.webp',
    description:
      'Our IREC 2025 rocket. Excalibur is a solid rocket flying to 10,000 ft, aiming to showcase the highest quality of design and manufacturing we can achieve.',
  },
  {
    id: 'glamourous-glennis',
    name: 'Glamourous Glennis',
    tagline: 'LE3 solid demonstrator',
    year: 2025,
    era: '2025',
    kind: 'demonstrator',
    stat: 'Mach 1',
    statLabel: 'supersonic',
    image: '/img/projects/glamouous_glennisr.webp',
    description:
      'A solid demonstrator for Diablo (LE3), built to test a new parachute deployment system. Sponsored by Mach 1 Hot Sauce, it flew supersonic at Mach 1 — with a bottle of hot sauce aboard.',
  },
  {
    id: 'caldera',
    name: 'Caldera',
    tagline: 'Two-stage vehicle',
    year: 2024,
    era: 'IREC 2024',
    kind: 'vehicle',
    stat: '27,326 ft',
    statLabel: 'UC Berkeley apogee record',
    image: '/img/projects/caldera.webp',
    description:
      'Our two-stage vehicle, Caldera, reached an impressive apogee of 27,326 feet — shattering the UC Berkeley apogee record. It marked a significant milestone for the team and set a new standard for future projects.',
  },
  {
    id: 'calvisitor',
    name: 'Calvisitor',
    tagline: 'Air brakes + dual payload',
    year: 2023,
    era: 'IREC 2023',
    kind: 'vehicle',
    stat: '10,023 ft',
    statLabel: '4th overall at IREC',
    image: '/img/projects/calvisitor.webp',
    description:
      'Our 2023 entry into the Intercollegiate Rocketry Engineering Competition. Spanning two years of work and featuring an axial avionics bay and an air brakes system to reach as close to 10,000 ft as possible. It flew two payloads — a vibrational art system and a muon detector — reaching an apogee of 10,023 ft and placing 4th overall.',
  },
  {
    id: 'ellie',
    name: 'ELLIE (LE1)',
    tagline: '1st Liquid Engine',
    year: 2022,
    era: '2021–2022',
    kind: 'engine',
    stat: '6 s',
    statLabel: 'successful test fire',
    image: '/img/projects/ellie.webp',
    description:
      "The Experimental Liquid Low-Impulse Engine (ELLIE) is the first time STAR attempted a bi-propellant rocket engine — laying the groundwork for a flyable liquid. Across Fall 2021 and Spring 2022, the propulsion and avionics teams carried a long-standing design of the gaseous-oxygen / liquid-ethanol engine to completion, ending with a successful 6-second test fire.",
  },
  {
    id: 'pinkbeary',
    name: 'Pinkbeary',
    tagline: '1st 2-Stage Vehicle',
    year: 2022,
    era: '2022',
    kind: 'vehicle',
    stat: '2,377 ft',
    statLabel: 'stage separation',
    image: '/img/projects/pinkbeary.webp',
    description:
      "Launched September 2022, Pinkbeary (SSEP) is a proof-of-concept testing a two-stage airframe design and a spring-actuated separation mechanism released by explosive 'pyro' bolts. It involved several new recovery methods and airframe architectures. Stage separation makes rockets more efficient by shedding dead weight — a key step toward STAR's eventual spaceshot goal. Its apogee was around 2,377 ft.",
  },
  {
    id: 'bearforce1',
    name: 'BearForce 1',
    tagline: 'Largest rocket to date',
    year: 2021,
    era: 'IREC 2021',
    kind: 'vehicle',
    stat: '10,000+ ft',
    statLabel: 'Mojave Desert',
    image: '/img/projects/bearforce1.webp',
    description:
      'Launched over 10,000 ft above the Mojave Desert for IREC in summer 2021. At over 10 feet tall, BFO is our largest rocket to date. It features a 6-inch fiberglass airframe and a CubeSat-form payload carrying our custom muon detector and microbial fuel cell to 10,000 feet.',
  },
  {
    id: 'alula',
    name: 'ALULA (LE2)',
    tagline: '1st Liquid Vehicle',
    year: 2023,
    era: '2023',
    kind: 'vehicle',
    stat: '6,126 ft',
    statLabel: "Berkeley's first recovered liquid",
    image: '/img/projects/alula.webp',
    description:
      "Our first liquid rocket, ALULA, achieved an apogee of 6,126 feet — making history as the first liquid rocket from UC Berkeley to be successfully recovered. ALULA also won the Dollar-Per-Foot Competition at Friends of Amateur Rocketry, paving the way for more ambitious liquid projects ahead.",
  },
  {
    id: 'mindi',
    name: 'MINDI',
    tagline: '2-inch minimum-diameter rocket',
    year: 2021,
    era: '2021',
    kind: 'vehicle',
    stat: '14,000 ft',
    statLabel: 'projected apogee',
    image: '/img/projects/mindi.webp',
    description:
      "MINDI stands for minimum-diameter — a rocket whose motor slides directly into the body tube rather than a smaller motor-mount tube. That design poses challenges for mounting the fins and retaining the motor. We investigated fin glassing and composites techniques, plus a 3D-printed motor retainer, and set out to shatter Berkeley's altitude record at an astonishing 14,000 feet.",
  },
  {
    id: 'airbears',
    name: 'AirBears',
    tagline: 'Dual-deploy recovery',
    year: 2019,
    era: 'Nov 2019',
    kind: 'vehicle',
    stat: '4,509 ft',
    statLabel: 'within 1 ft of prediction',
    image: '/img/projects/airbears.webp',
    description:
      'AirBears flew nominally to 4,509 ft in November 2019 — incredibly close to its projected 4,500 ft. The two recovery altimeters recorded 4,508 and 4,509 ft. Drogue deployed at apogee and the main at 800 ft; with very little wind, the vehicle drifted to within ~100 meters of the launch site.',
  },
  {
    id: 'arktos',
    name: 'Arktos',
    tagline: 'NASA Student Launch',
    year: 2018,
    era: '2018',
    kind: 'vehicle',
    stat: '5,323 ft',
    statLabel: 'simulated apogee',
    image: '/img/projects/arktos.webp',
    description:
      'Launched several times between February and March 2018. Constructed of Blue Tube tubing and couplers with a fiberglass nose cone, a 3D-printed boattail, and a fiberglass-reinforced 6-to-4-inch transition. At 111 inches long, 27.9 lb wet / 22.9 lb dry, it used a Cesaroni L730 motor for a simulated apogee of 5,323 ft.',
  },
  {
    id: 'subarktos',
    name: 'SubArktos',
    tagline: 'Arktos prototype',
    year: 2017,
    era: 'Nov 2017',
    kind: 'vehicle',
    image: '/img/projects/subarktos.webp',
    description:
      'Launched November 2017 as a prototype of Arktos for the NASA Student Launch. Like the later Arktos, it featured a 3D-printed, fiberglass-reinforced transition piece and flew on a Cesaroni L730.',
  },
  {
    id: 'ursa-major',
    name: 'URSA Major',
    tagline: 'NASA SL competition vehicle',
    year: 2017,
    era: '2016–2017',
    kind: 'vehicle',
    stat: 'Huntsville, AL',
    statLabel: 'target-detection payload',
    image: '/img/projects/ursamajor.webp',
    description:
      'Successfully launched three times between January and April, the last being our competition launch in Huntsville, AL. At 97" long and 6" in diameter on an Aerotech L1150, it used a dual-deployment parachute system. During descent, a nose-cone camera and Raspberry Pi ran a target-detection algorithm before deploying landing legs and ejecting the payload to land upright.',
  },
  {
    id: 'ursa-minor',
    name: 'URSA Minor',
    tagline: 'First high-powered rocket',
    year: 2016,
    era: 'Dec 2016',
    kind: 'vehicle',
    stat: '4,633 m',
    statLabel: 'first HPR flight',
    image: '/img/projects/ursaminor.webp',
    description:
      'On December 4, 2016, CalSTAR launched its first high-powered rocket — a 2/3 sub-scale version of our final vehicle featuring a nose-mounted camera, clear nose cone, and first-person flight video. Its launch altitude was 4,633 meters.',
  },
];
