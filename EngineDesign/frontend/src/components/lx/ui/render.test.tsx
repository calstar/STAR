import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeUnits, DEFAULT_SYSTEM, PRESETS } from '../units';
import { Badge } from './Badge';
import { Button } from './Button';
import { DeltaChip } from './DeltaChip';
import { Field } from './Field';
import { Figure } from './Figure';
import { MarginBar, MarginList } from './MarginBar';
import { marginScale } from './margin';
import { Menu, MenuItem } from './Menu';
import { Num } from './Num';
import { NotComputed, Panel } from './Panel';
import { Segmented } from './Segmented';
import { Tabs } from './Tabs';
import { Term } from './Term';
import { Toggle } from './Toggle';

/**
 * The primitives' markup: the names, roles and links a screen reader and the keyboard depend on.
 * Rendered on the server (no DOM in this suite), so this checks structure, not behaviour.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const NBSP = '\u00a0';
const u = makeUnits(DEFAULT_SYSTEM);
const noop = () => {};

describe('MarginBar', () => {
  const scale = marginScale({ limit: 1, warn: 1.2, direction: 'higher-is-safer' }, 1.33);

  it('is a button with the whole reading as its name when it can jump', () => {
    const h = html(<MarginBar label="Chug margin" value="1.33" status="ok" scale={scale} worstText="worst at T+0.04 s" limitText={'> 1'} onJump={noop} />);
    expect(h).toMatch(/^<button type="button"/);
    expect(h).toContain('aria-label="Chug margin 1.33, Within limits, worst at T+0.04 s, limit &gt; 1. Jump to the worst moment."');
    const described = /aria-describedby="([^"]+)"/.exec(h)?.[1];
    expect(described && h.includes(`id="${described}"`)).toBe(true);
    expect(h).toContain('Higher is safer.');
  });

  it('is still focusable, as a group, when it cannot jump', () => {
    const h = html(<MarginBar label="Chug margin" value="1.33" status="ok" scale={scale} />);
    expect(h).toMatch(/^<div role="group" tabindex="0"/);
  });

  it('labels the red line and the amber edge alike ("1.0", "1.2") and draws the marker', () => {
    const h = html(<MarginBar label="Chug margin" value="1.33" status="ok" scale={marginScale({ limit: 1, warn: 1.2, direction: 'higher-is-safer' }, 1.33, { trackPx: 320 })} />);
    expect(h).toContain('>1.0<');
    expect(h).toContain('>1.2<');
    expect(h).toContain('background:var(--lx-bad)');
    expect(h).toContain('bg-[var(--lx-text)]');
  });

  it('shows the glyph and never colour alone', () => {
    for (const [status, glyph] of [['ok', '✓'], ['warn', '!'], ['bad', '✗']] as const) {
      expect(html(<MarginBar label="x" value="1" status={status} scale={scale} />)).toContain(`>${glyph}<`);
    }
  });
});

describe('MarginList', () => {
  const items = [
    { key: 'chug', label: 'Chug margin', value: '1.33', scale: marginScale({ limit: 1, warn: 1.2, direction: 'higher-is-safer' }, 1.33) },
    { key: 'sag', label: 'Fuel tank sag, the longest label in the list by some way', value: '71.0\u00a0psi', scale: marginScale({ limit: 60, warn: 30, direction: 'lower-is-safer' }, 71) },
    { key: 'stiff', label: 'LOX injector ΔP/Pc', value: '43.1\u00a0%', scale: marginScale({ limit: 20, direction: 'higher-is-safer', far: { warn: 40 } }, 43.1) },
  ].map((i) => ({ ...i, status: i.scale.status }));

  it('lists worst first and shares one grid, the value column as wide as the widest value', () => {
    const h = html(<MarginList items={items} />);
    const order = [...h.matchAll(/aria-label="([^"]+?) [\d.,]+/g)].map((m) => m[1]);
    expect(order).toEqual(['Fuel tank sag, the longest label in the list by some way', 'LOX injector ΔP/Pc', 'Chug margin']);
    expect(h).toContain('grid-cols-[minmax(7rem,1fr)_max-content_minmax(8rem,1.5fr)]');
    expect((h.match(/grid-cols-subgrid/g) ?? []).length).toBe(3);
  });

  it('keeps a cut label whole in its tooltip and says a band is a band', () => {
    const h = html(<MarginList items={items} />);
    expect(h).toContain('title="Fuel tank sag, the longest label in the list by some way"');
    expect(h).toContain('Safe between 20 and 40.');
  });

  it('keeps the given order when told not to sort', () => {
    const h = html(<MarginList items={items} sort={false} />);
    const order = [...h.matchAll(/aria-label="([^"]+?) [\d.,]+/g)].map((m) => m[1]);
    expect(order[0]).toBe('Chug margin');
  });
});

describe('Field', () => {
  it('shows the value at its unit\'s digits with the unit inside the box', () => {
    const h = html(<Field label="Tank pressure" value={578.4} scale={u.scale('pressure', { pressure: 'gauge', gaugeZeroPsia: 14.7 })} onCommit={noop} />);
    expect(h).toContain('value="578"');
    expect(h).toContain('>psia<');
    expect(h).toMatch(/<label for="([^"]+)"[^>]*>Tank pressure<\/label>/);
    const forId = /<label for="([^"]+)"/.exec(h)?.[1];
    expect(h).toContain(`id="${forId}"`);
  });

  it('converts both ways under a different system', () => {
    const si = makeUnits(PRESETS.si);
    const h = html(<Field label="Tank pressure" value={578.4} scale={si.scale('pressure')} onCommit={noop} />);
    expect(h).toContain('value="39.9"');
    expect(h).toContain('>bar(a)<');
  });

  it('marks a value changed from the design and offers the reset, only then', () => {
    const changed = html(<Field label="Tank pressure" value={600} defaultValue={578} unit="psia" onCommit={noop} />);
    expect(changed).toContain('aria-label="Reset Tank pressure to the design value, 578 psia"');
    expect(changed).toContain('Changed from the design value, 578 psia.');
    const same = html(<Field label="Tank pressure" value={578.2} defaultValue={578} unit="psia" onCommit={noop} />);
    expect(same).not.toContain('Reset');
  });

  it('has no reset when read-only, and carries readOnly to the input', () => {
    const h = html(<Field label="Tank pressure" value={600} defaultValue={578} unit="psia" onCommit={noop} readOnly />);
    expect(h).not.toContain('Reset');
    expect(h).toContain('readOnly=""');
  });

  it('shows an outside error, tied to the input', () => {
    const h = html(<Field label="Tank pressure" value={600} unit="psia" onCommit={noop} error="Above the tank MAWP" />);
    expect(h).toContain('aria-invalid="true"');
    const errId = /aria-describedby="([^"]+)"/.exec(h)?.[1];
    expect(h).toContain(`id="${errId}" role="alert"`);
    expect(h).toContain('Above the tank MAWP');
  });

  it('shows a measured value\'s spread', () => {
    expect(html(<Field label="Cd" value={0.72} digits={3} onCommit={noop} measured={{ pm: '±0.02' }} />)).toContain('measured ±0.02');
  });
});

describe('Term', () => {
  it('inside a label, adds only its words to the field\'s name: the card is a hidden description', () => {
    const h = html(<Field label="Dome setting" termKey="domeSetting" value={560} unit="psig" onCommit={noop} />);
    const label = /<label[^>]*>([\s\S]*?)<\/label>/.exec(h)?.[1] ?? '';
    // Whatever the label holds beyond the words sits in a hidden node, which a name never reads.
    expect(label.replace(/<span[^>]*hidden=""[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '')).toBe('Dome setting');
  });

  it('is focusable and described by its glossary entry', () => {
    const h = html(<p>The <Term k="chugMargin" /> is the gain margin.</p>);
    expect(h).toContain('tabindex="0"');
    const id = /aria-describedby="([^"]+)"/.exec(h)?.[1];
    expect(h).toContain(`id="${id}" hidden=""`);
    expect(h).toContain('>Chug margin<');
    expect(h).toContain('GM = 1 / |L(jω₁₈₀)|');
  });
});

describe('Figure and Num', () => {
  it('joins the number to its unit with a no-break space', () => {
    expect(html(<Figure label="Mean thrust" q={u.f(6804.4)} />)).toContain(`>6,804</span>${NBSP}<span`);
    expect(html(<Num q={u.p(564.2)} />)).toContain(`>564</span>${NBSP}<span class="lx-unit">psia<`);
  });

  it('keeps a long sub-line whole in its tooltip', () => {
    expect(html(<Figure label="Burn time" value="3.55" unit="s" sub="LOX ran out first, 0.21 kg of fuel left" />))
      .toContain('title="LOX ran out first, 0.21 kg of fuel left"');
  });

  it('draws a delta chip only when there is one', () => {
    expect(html(<Figure label="Burn time" value="3.55" unit="s" delta="+0.11 s" />)).toContain('+0.11 s');
    expect(html(<DeltaChip text={null} />)).toBe('');
  });
});

describe('controls', () => {
  it('Segmented is a radio group with one Tab stop, the selected one', () => {
    const h = html(<Segmented ariaLabel="Pressure unit" value="bar" onChange={noop} options={[{ value: 'psi', label: 'psi' }, { value: 'bar', label: 'bar' }]} />);
    expect(h).toContain('role="radiogroup" aria-label="Pressure unit"');
    expect(h).toContain('role="radio" aria-checked="false" tabindex="-1"');
    expect(h).toContain('role="radio" aria-checked="true" tabindex="0"');
  });

  it('Toggle is a switch named by its label', () => {
    expect(html(<Toggle checked label="Line walls" onChange={noop} />)).toContain('role="switch" aria-checked="true"');
    expect(html(<Toggle checked={false} label="Line walls" hideLabel onChange={noop} />)).toContain('aria-label="Line walls"');
  });

  it('Button defaults to type=button and passes disabled through', () => {
    const h = html(<Button variant="primary" disabled>Run</Button>);
    expect(h).toContain('type="button"');
    expect(h).toContain('disabled=""');
  });

  it('Menu is a menu button, closed until used', () => {
    const h = html(<Menu label="Export"><MenuItem onClick={noop}>CSV</MenuItem></Menu>);
    expect(h).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(h).not.toContain('role="menu"');
  });

  it('Tabs tie each tab to its panel and keep one Tab stop', () => {
    const h = html(<Tabs ariaLabel="Pages" value="feed" onChange={noop} subtitle="Where does the pressure go?"
                         tabs={[{ key: 'overview', label: 'Overview' }, { key: 'feed', label: 'Feed' }]} />);
    expect(h).toContain('role="tab" id="lx-tab-feed" aria-selected="true" aria-controls="lx-panel-feed" tabindex="0"');
    expect(h).toContain('id="lx-tab-overview" aria-selected="false" aria-controls="lx-panel-overview" tabindex="-1"');
    expect(h).toContain('Where does the pressure go?');
  });
});

describe('Panel and status', () => {
  it('names its region by its title', () => {
    const h = html(<Panel title="Limits">x</Panel>);
    const id = /aria-labelledby="([^"]+)"/.exec(h)?.[1];
    expect(h).toContain(`<h2 id="${id}"`);
  });

  it('says "Not computed for this run" quietly', () => {
    expect(html(<NotComputed />)).toContain('Not computed for this run');
  });

  it('Badge carries the word, not just the colour', () => {
    expect(html(<Badge status="bad" />)).toContain('Fails');
    expect(html(<Badge status="warn">2 to check</Badge>)).toContain('2 to check');
  });
});
