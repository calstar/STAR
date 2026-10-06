/**
 * Layer X's primitives (docs/layerx/GUI-SPEC.md, "Components"). Every page is built from these and
 * the tokens in ../theme.css; a page that needs a new look adds a primitive here rather than
 * styling one inline.
 */
export { Badge } from './Badge';
export { Button } from './Button';
export { DeltaChip } from './DeltaChip';
export { Field } from './Field';
export { Figure } from './Figure';
export { Kbd } from './Kbd';
export { MarginBar, MarginList, type MarginItem } from './MarginBar';
export { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';
export { Num } from './Num';
export { NotComputed, Panel } from './Panel';
export { Popover } from './Popover';
export { Segmented, type SegmentOption } from './Segmented';
export { Tabs, type TabSpec } from './Tabs';
export { GlossaryCard, Term } from './Term';
export { Toggle } from './Toggle';

export { delta, deltaText, type Delta } from './delta';
export { editText, fieldError, parseNumber, sameAtDigits, type Parsed } from './fieldParse';
export { useHover } from './hover';
export { panelId, tabId, tabPanelProps } from './ids';
export { compareMargins, directionWords, gradeLimit, marginScale, niceCeil, sortWorstFirst, type Direction, type LimitSpec, type MarginScale, type Tick, type Zone } from './margin';
export { placePopover, type Placement } from './place';
export { STATUS_GLYPH, STATUS_SOFT, STATUS_VAR, STATUS_WORD, statusRank, worst, type Status } from './status';
export { buttonClass, type ButtonSize, type ButtonVariant } from './styles';
