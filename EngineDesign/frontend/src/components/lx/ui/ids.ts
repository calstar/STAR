/** The ids that tie a tab to its panel (aria-controls / aria-labelledby). */
export function tabId(prefix: string, key: string): string {
  return `${prefix}-tab-${key}`;
}

export function panelId(prefix: string, key: string): string {
  return `${prefix}-panel-${key}`;
}

/** Spread on a page's panel so the tab names it: `<section {...tabPanelProps('lx', 'feed')}>`. */
export function tabPanelProps(prefix: string, key: string) {
  return { id: panelId(prefix, key), role: 'tabpanel' as const, 'aria-labelledby': tabId(prefix, key), tabIndex: -1 };
}
