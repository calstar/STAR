// Starter templates, written from the outreach emails STAR actually sent in
// fall 2026 (renewal thank-yous, cold asks, the crowdfunding blast). The
// Templates page offers to add any that are missing; after that they are
// ordinary rows anyone can edit. Compose links can't carry attachments, so a
// template that mentions the packet means "attach it in Gmail".

import type { TemplateKind } from "./constants";

const SIGNATURE = `Best,
{{sender_name}}
Outreach, Space Technologies and Rocketry at Berkeley (STAR)
{{sender_email}} | ucberkeleystar@gmail.com
https://stars.studentorg.berkeley.edu`;

const ABOUT =
  "STAR is UC Berkeley's largest undergraduate aerospace organization: 100+ active members, holders of the Cal altitude record (27,326 ft), 6th in the 30k category at IREC 2024, and 60k followers on Instagram.";

const LE4 =
  "This year we're building LE4, a pressure-fed liquid methane + liquid oxygen rocket that we'll fly at the FAR-OUT competition in the Mojave in May 2027, plus an 8\" solid-motor demonstrator for our new airframe and recovery system.";

export const STARTER_TEMPLATES: { name: string; kind: TemplateKind; subject: string; body: string }[] = [
  {
    name: "Sponsor: thank you + renewal",
    kind: "sponsor_renewal",
    subject: "Thank You + {{season}} {{org}} Sponsorship Renewal: UC Berkeley STAR",
    body: `Hi {{first_name|{{org}} team}},

My name is {{sender_name}}, and I'm on the outreach team for Space Technologies and Rocketry at Berkeley (STAR). Thank you for {{#their_deliverables}}{{their_deliverables}}{{/their_deliverables}}{{^their_deliverables}}supporting STAR{{/their_deliverables}}. It has made a real difference to what we can build.

${LE4} {{#ask}}For {{season}}, we'd love to ask about {{ask}}.{{/ask}}{{^ask}}We'd love to continue our partnership for {{season}}.{{/ask}} Is there anything you need from us to keep it going?

{{org}} will be featured on our website, our vehicle and Instagram. I've attached our updated sponsorship packet.

${SIGNATURE}`,
  },
  {
    name: "Sponsor: cold ask",
    kind: "sponsor_cold",
    subject: "Sponsorship Request: UC Berkeley STAR Rocketry (LE4 Liquid Rocket)",
    body: `Hi {{first_name|{{org}} team}},

My name is {{sender_name}}, and I'm on the outreach team for Space Technologies and Rocketry at Berkeley (STAR). ${ABOUT}

${LE4}

{{#ask}}We'd be grateful for {{ask}}. {{/ask}}In return, {{org}} would be featured on our rocket, website and social media, and we'd be glad to share progress updates, circulate your job postings to our members, and give you access to our resume book.

I've attached our sponsorship packet. Would you be open to a short call?

${SIGNATURE}`,
  },
  {
    name: "Sponsor: follow-up nudge",
    kind: "sponsor_followup",
    subject: "Following up: {{org}} x UC Berkeley STAR",
    body: `Hi {{first_name|{{org}} team}},

I wanted to follow up on my earlier note about {{#ask}}{{ask}}{{/ask}}{{^ask}}{{#renewal}}continuing our partnership{{/renewal}}{{^renewal}}sponsoring STAR{{/renewal}}{{/ask}} for {{season}}. We're moving quickly on LE4 ahead of FAR-OUT in May, and {{org}}'s support would go a long way.

Is there someone else I should be speaking with, or anything you need from us?

${SIGNATURE}`,
  },
  {
    name: "Sponsor: thank you (received)",
    kind: "sponsor_thanks",
    subject: "Thank you from UC Berkeley STAR",
    body: `Hi {{first_name|{{org}} team}},

On behalf of everyone at STAR, thank you for {{their_deliverables|your support}}. We'll share photos and updates as LE4 comes together, and {{org}} will be on our vehicle, website and Instagram.

If there's anything you'd like from us (a logo file, a contact for recruiting, a visit to our build space), just let me know.

${SIGNATURE}`,
  },
  {
    name: "Crowdfunding: personal ask",
    kind: "crowdfunding_ask",
    subject: "Help STAR launch LE4 this year",
    body: `Hi {{first_name|there}},

I'm part of Space Technologies and Rocketry (STAR), Berkeley's competition rocketry team, and our biggest crowdfunding campaign of the year is live. In October we raise nearly all of this year's funding through Berkeley Crowdfunding, and it pays for LE4, our liquid-fuel rocket, and this year's guided-parachute payload.

Any amount helps, and gifts come with perks: for $10 we'll write your name on a rocket we launch.

Donate here: {{campaign_url|https://crowdfund.berkeley.edu/project/50508}}

Thank you!
{{sender_name}}`,
  },
  {
    name: "Crowdfunding: final days",
    kind: "crowdfunding_ask",
    subject: "Last days to help STAR reach our goal",
    body: `Hi {{first_name|there}},

Our crowdfunding campaign closes this week, and every gift now counts toward the goal that funds LE4's hotfires and launch at FAR-OUT this May.

If you've been meaning to give, now's the time: {{campaign_url|https://crowdfund.berkeley.edu/project/50508}}

Thank you for supporting student rocketry at Berkeley!
{{sender_name}}
Space Technologies and Rocketry at Berkeley (STAR)`,
  },
  {
    name: "Crowdfunding: thank you",
    kind: "crowdfunding_thanks",
    subject: "Thank you for supporting STAR!",
    body: `Hi {{first_name|there}},

Thank you so much for your gift{{#last_gift}} of {{last_gift}}{{/last_gift}} to STAR's crowdfunding campaign. Your support goes straight into LE4's hotfires, our launch at FAR-OUT, and this year's guided-parachute payload.

We'll send your perk soon and keep you posted as we build and fly. Follow along on Instagram @starberkeley.

With gratitude,
{{sender_name}} and the STAR team`,
  },
  {
    name: "Event / team collaboration",
    kind: "event",
    subject: "{{org}} x UC Berkeley STAR",
    body: `Hi {{first_name|there}},

My name is {{sender_name}}, and I'm on the outreach team for Space Technologies and Rocketry at Berkeley (STAR). ${ABOUT}

We'd love to work with {{org}}{{#ask}} on {{ask}}{{/ask}}. Would you have time to talk this week or next?

${SIGNATURE}`,
  },
];
