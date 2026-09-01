/**
 * Team leads.
 *
 * Names/bios are current; headshots are still to come. Drop a photo into
 * /public/img/leads/<id>.jpg and set `image` to that path (blank → initials
 * avatar). Add or remove roles freely.
 */

export interface Lead {
  id: string;
  /** Role / title, e.g. "President" or "Propulsion". */
  role: string;
  name: string;
  bio: string;
  /** Class year (1–4+). Optional. */
  year?: number;
  /** Major. Optional. */
  major?: string;
  /** Headshot path, e.g. "/img/leads/president.jpg". Blank → initials avatar. */
  image?: string;
  email?: string;
  linkedin?: string;
}

export interface LeadGroup {
  title: string;
  leads: Lead[];
}

export const LEAD_GROUPS: LeadGroup[] = [
  {
    title: 'Executive',
    leads: [
      {
        id: 'president',
        image: '/img/leads/president.webp',
        role: 'President',
        name: 'Aidan Rickert',
        year: 4,
        major: 'EECS',
        bio: "I’m Aidan, the President of STAR. I previously served as Avionics Lead and my background is in electronics; I serve as the director of the Advanced PCB Engineering (APE) DeCal and have interned at Apple and Astranis, focusing on PCBs. My focus this year is on creating long-lasting infrastructure so our team can continue to advance. If you have any questions about STAR, electrical engineering, or life, feel free to reach out!",
      },
      {
        id: 'vp-aahil',
        image: '/img/leads/vp-aahil.webp',
        role: 'Vice President',
        name: 'Aahil Syed',
        year: 4,
        major: 'Computer Science + Applied Mathematics',
        bio: "Hi Everyone!! I'm Aahil, one of the Vice Presidents for STAR. This year, I hope to help our projects succeed as much as possible and make STAR the best rocketry club ever. My goal is to get LE4 in the air, work with our members, and have fun while doing the hard stuff. Outside of STAR, I am very much into music (both playing and listening), tennis, walking around, and going on adventures. I hope you all are as excited as I am for this year!",
      },
      {
        id: 'vp-manank',
        image: '/img/leads/vp-manank.webp',
        role: 'Vice President',
        name: 'Manank Doshi',
        year: 3,
        major: 'Mechanical Engineering & Materials Science',
        bio: "Hi! I’m Manank, and I’m excited to be serving as Vice President for STAR this year. It’s my third year on the team, and I’m also part of the Propulsion subteam. I’m excited to see our team go to new heights this year with LE4 and make friends along the way. Outside of rocketry, I love playing basketball and chess, building Legos, and spending time with friends. Looking forward to an amazing year with all of you in STAR!",
      },
      {
        id: 'le4-pm',
        image: '/img/leads/le4-pm.webp',
        role: 'LE4 Project Manager',
        name: 'Thomas Chang',
        year: 4,
        major: 'Mechanical Engineering',
        bio: "Hello! I’m Thomas, and I’m the project manager for LE4. I’m looking forward to putting in the work for this year’s ultimate goal of completing our LE4 liquid vehicle in one year and competing in FAR-OUT. Besides building rockets, I like going rock climbing, playing soccer and playing Deadlock. I’m looking forward to seeing everyone at RFS!",
      },
    ],
  },
  {
    title: 'Team Leads',
    leads: [
      {
        id: 'aerostructures',
        image: '/img/leads/aerostructures.webp',
        role: 'Aerostructures',
        name: 'Marwan Haggag',
        year: 3,
        major: 'Mechanical Engineering',
        bio: "Hey everyone! I’m Marwan, the current aerostructures lead, and this is going to be my third year on STAR. I’m currently taking the semester off to work at Zipline in SF, but I'm still going to be focused on the team. My main goals are to get us our first aluminum airframe and complete our one-year liquid vehicle on time. Outside of STAR, I like going to the gym, boxing, going to functions, and exploring the bay. If you have any questions about STAR or just want to talk, feel free to reach out!",
      },
      {
        id: 'propulsion',
        image: '/img/leads/propulsion.webp',
        role: 'Propulsion',
        name: 'Carlos Bautista',
        year: 3,
        major: 'Aerospace Engineering',
        bio: "Hey! I’m Carlos; this is my third year on STAR, and I’m the current propulsion lead. This past summer, I worked at NASA Ames on CFD focused on aeroelasticity, and on this team I handled the design, build, and testing of LE3. My goals this year are to learn from LE3's mistakes and get LE4 built, hot-fired, and flying at FAR-OUT.",
      },
      {
        id: 'avionics',
        image: '/img/leads/avionics.webp',
        role: 'Avionics',
        name: 'Rohith Chikka',
        year: 4,
        major: 'EECS',
        bio: "Hello! I’m Rohith, the Avionics lead. I have a lot of background in hardware engineering and PCB design, and I'm an intern at a humanoid robotics startup in San Francisco. This is my fourth year on STAR and I’m aiming to organize our team to develop our flight avionics stack and custom electrical systems for the year. Apart from STAR, my interests are playing piano, painting, and reading books.",
      },
      {
        id: 'payload',
        image: '/img/leads/payload.webp',
        role: 'Payload',
        name: 'Hudson Kim',
        year: 2,
        major: 'EECS & Aerospace Engineering',
        bio: "Hi everyone! I’m Hudson and I’m the payload lead! A little about me: most of my background is in GNC and robotics. I’ve previously worked on space planes at Sierra Space and interned at NASA developing wildfire models with satellite-based imagery. Apart from STAR, I enjoy playing badminton and watching F1. I’m looking forward to an amazing year with everyone and can’t wait to get started!",
      },
      {
        id: 'operations',
        image: '/img/leads/operations.webp',
        role: 'Operations',
        name: 'Forrest Hou',
        year: 2,
        major: 'Mechanical Engineering',
        bio: "Hello! I’m Forrest, your operations lead this year. I’m excited for this year’s project of completing our LE4 liquid vehicle in one year. I’m focused on making sure our operations and logistics run smoothly so we can go to FAR as efficiently as possible. Besides building rockets, I like going hiking, riding my bike, and rock climbing. I’m looking forward to seeing everyone at RFS!",
      },
      {
        id: 'outreach',
        image: '/img/leads/outreach.webp',
        role: 'Outreach',
        name: 'Roshan Taneja',
        year: 2,
        major: 'EECS',
        bio: 'Hello, I am Roshan!',
      },
      {
        id: 'media',
        image: '/img/leads/media.webp',
        role: 'Media',
        name: 'Theo Parker',
        year: 3,
        major: 'EECS',
        bio: "Hey everyone! I’m Theo, and this is my second year as Media Lead. I’m also Avionics Deputy, and this is my third year on STAR. Outside of rocketry, I enjoy playing music, watching college football, and theatrical lighting design. If you have any questions about STAR media or anything else, feel free to reach out!",
      },
    ],
  },
];
