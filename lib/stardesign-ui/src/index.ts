/**
 * Shared UI for the STAR design tools.
 *
 * The server side of design sharing is already one implementation
 * (`lib/stardesign`); this is the client side of the same thing. See README.md
 * for what lives here, what deliberately does not, and how an app wires it up.
 */

export { Modal } from './Modal';
export { ChangeModal } from './ChangeModal';
export { btn, primaryBtn, dangerBtn, ghostBtn, relativeTime } from './theme';
export { createDesignApi, keyOf, refOf, ApiError } from './api';
export type {
  BrowseGroup,
  DesignApi,
  DesignApiConfig,
  DesignMeta,
  DocRef,
  MicroVersion,
  PayloadCodec,
  ReleaseVersion,
  TeamUser,
} from './api';
