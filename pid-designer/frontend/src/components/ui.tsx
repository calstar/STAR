/**
 * The modal shell, now shared with the other design tools.
 *
 * pid-designer had no dialog component at all before sharing landed -- New /
 * Rename / Delete used `window.prompt` and `window.confirm`. Kept as a
 * re-export rather than changing every import site.
 */

export { Modal } from '@stardesign-ui';
