// A palette entry's preset is written into the symbol's options when it is
// dropped (PIDDesigner onDrop). The config dialog writes back only the options
// its spec declares, wholesale (ConfigDialog, saveConfig) -- so a preset key the
// spec does not name is lost on the first save. That is how a hydraulic QD came
// back as a fluid one.
import { describe, expect, it } from 'vitest';
import { COMPONENT_DEFS } from './types';
import { COMPONENT_SPECS } from './spec';

describe('what a palette entry presets, the dialog keeps', () => {
  const preset = COMPONENT_DEFS.filter(d => d.preset);

  it('has presets to check', () => {
    expect(preset.map(d => d.id)).toContain('QD_H');
  });

  for (const def of preset) {
    it(`${def.id}: every preset key is an option of ${def.type}, with the preset among its choices`, () => {
      const options = COMPONENT_SPECS[def.type]?.options ?? [];
      for (const [key, value] of Object.entries(def.preset!)) {
        const spec = options.find(o => o.key === key);
        expect(spec, `${def.type} declares no option '${key}'`).toBeDefined();
        expect(spec!.choices.map(c => c.value)).toContain(value);
      }
    });
  }
});
