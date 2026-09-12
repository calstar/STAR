/**
 * The config gate: read what a run is about to deploy, and say whether it is fit to run.
 *
 * The rules themselves live in shared/config-validation.ts so the config editor renders the same
 * findings inline as you type. What lives HERE is the part that must not be in a browser: which
 * files get read, and the error a refused start throws. SessionManager.start() is the only caller
 * that matters — it refuses to start a run when this reports anything, unless the operator
 * explicitly overrides. A client cannot skip the gate by not asking for it.
 *
 * What gets validated is the ACTIVE PROFILE, not the deployed config/config.toml: the profile is
 * what session start is about to copy into place (deployActiveProfile), so validating config.toml
 * would be checking the *previous* run's config and passing a broken profile straight through.
 */
import {
  validateConfigForRun,
  countByLevel,
  type ConfigIssue,
} from '../../shared/config-validation.js';
import {
  readActiveProfile,
  readStateCsv,
  getActiveProfileName,
} from './routes/config-profiles.js';

export type { ConfigIssue };

/** Thrown by SessionManager.start() when the profile it was about to deploy has issues and the
 *  caller did not override. Distinguishable from an ordinary start failure so the WebSocket layer
 *  can answer with the structured list instead of a one-line error string. */
export class ConfigIssuesError extends Error {
  readonly issues: ConfigIssue[];
  readonly profile: string;
  constructor(issues: ConfigIssue[], profile: string) {
    const { errors, warnings } = countByLevel(issues);
    super(
      `Config profile "${profile}" has ${errors} error(s) and ${warnings} warning(s). ` +
      'Nothing was started and config.toml is unchanged.',
    );
    this.name = 'ConfigIssuesError';
    this.issues = issues;
    this.profile = profile;
  }
}

export interface ConfigValidationResult {
  profile: string;
  issues: ConfigIssue[];
  errors: number;
  warnings: number;
}

/**
 * Validate the active profile and its state-machine tables.
 *
 * A read failure is reported as an issue rather than thrown: "the profile cannot be read" is
 * exactly the kind of thing an operator must see before a run, and throwing here would turn it
 * into a generic start failure with no page to open.
 */
export function validateActiveProfile(): ConfigValidationResult {
  const profile = getActiveProfileName();
  try {
    const config = readActiveProfile();
    const issues = validateConfigForRun(config, {
      actuators: readStateCsv('actuators'),
      delays: readStateCsv('delays'),
      transitions: readStateCsv('transitions'),
    });
    return { profile, issues, ...countByLevel(issues) };
  } catch (e) {
    const issues: ConfigIssue[] = [{
      page: 'system',
      level: 'error',
      message: `The active config profile "${profile}" could not be read: ${(e as Error)?.message ?? String(e)}`,
    }];
    return { profile, issues, ...countByLevel(issues) };
  }
}
