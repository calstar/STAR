/**
 * Team leads.
 *
 * ⚠️ PLACEHOLDER DATA — last year's roster is stale, so every entry below is a
 * scaffold. To publish: replace `name`, `bio`, and drop a headshot into
 * /public/img/leads/<id>.jpg for each role. Set `image` to that path (or leave
 * it blank to show the initials avatar). Add or remove roles freely.
 */

export interface Lead {
  id: string;
  /** Role / title, e.g. "President" or "Propulsion Lead". */
  role: string;
  /** Person's name. Use "TBD" until confirmed. */
  name: string;
  bio: string;
  /** Headshot path, e.g. "/img/leads/president.jpg". Blank → initials avatar. */
  image?: string;
  email?: string;
  linkedin?: string;
}

export interface LeadGroup {
  title: string;
  leads: Lead[];
}

const TBD = 'Bio coming soon.';

export const LEAD_GROUPS: LeadGroup[] = [
  {
    title: 'Executive',
    leads: [
      { id: 'president', role: 'President', name: 'TBD', bio: TBD },
      { id: 'vp-1', role: 'Vice President', name: 'TBD', bio: TBD },
      { id: 'vp-2', role: 'Vice President', name: 'TBD', bio: TBD },
    ],
  },
  {
    title: 'Team Leads',
    leads: [
      { id: 'airframe', role: 'Airframe', name: 'TBD', bio: TBD },
      { id: 'propulsion', role: 'Propulsion', name: 'TBD', bio: TBD },
      { id: 'avionics', role: 'Avionics', name: 'TBD', bio: TBD },
      { id: 'recovery', role: 'Recovery', name: 'TBD', bio: TBD },
      { id: 'payload', role: 'Payload', name: 'TBD', bio: TBD },
      { id: 'simulation', role: 'Simulation', name: 'TBD', bio: TBD },
      { id: 'operations', role: 'Operations', name: 'TBD', bio: TBD },
      { id: 'outreach', role: 'Outreach', name: 'TBD', bio: TBD },
      { id: 'media', role: 'Media', name: 'TBD', bio: TBD },
    ],
  },
  {
    title: 'Project Managers',
    leads: [{ id: 'le3-pm', role: 'LE3 Project Manager', name: 'TBD', bio: TBD }],
  },
];
