/**
 * Site-wide constants — external links, contact, socials. Edit here once.
 */

export const SITE = {
  name: 'STAR',
  fullName: 'Space Technologies and Rocketry',
  tagline: "UC Berkeley's Space Technologies and Rocketry",
  contactEmail: 'ucberkeleystar@gmail.com',

  applyUrl: 'https://apply.starberkeley.org',
  donateUrl: 'https://donate.starberkeley.org',
  wikiUrl: 'https://rocketry.gitbook.io/public/',

  socials: {
    instagram: 'https://www.instagram.com/starberkeley/',
    youtube: 'https://www.youtube.com/channel/UC-ceqnZp3XVz5mH8297izJA',
    linkedin: 'https://www.linkedin.com/company/calstar',
    facebook: 'https://www.facebook.com/ucberkeleystar/',
  },
} as const;

/** Headline stats for the Home page. Update as records fall. */
export const STATS = [
  { value: '18', label: 'Complete vehicles' },
  { value: '3', label: 'Liquid engines' },
  { value: '27,326 ft', label: 'Apogee record' },
  { value: '10+ yrs', label: 'Launch history' },
] as const;
