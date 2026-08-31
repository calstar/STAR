/**
 * The modal shell, now shared with the other design tools.
 *
 * Kept as a re-export rather than changing every import site: the component
 * itself lives in lib/stardesign-ui, but this app has always said `./ui`.
 */

export { Modal } from '@stardesign-ui';
