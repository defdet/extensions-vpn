/**
 * Cluster execution profiles.
 *
 * All profiles still connect via SSH — the profile controls how the bash
 * script is **wrapped** on the remote side:
 *
 *   direct  — run bash directly on the host  (current / default)
 *   docker  — wrap in `docker exec -i <container>`
 *   custom  — user-supplied command template with a {{SCRIPT}} placeholder
 */

export type ClusterProfileType = "direct" | "docker" | "custom";

export interface ClusterProfileConfig {
  profile: ClusterProfileType;
  /** Docker container name/ID — required when profile is "docker". */
  dockerContainer: string;
  /**
   * Custom command template — required when profile is "custom".
   * Use `{{SCRIPT}}` as the placeholder for the `env … bash -s` invocation.
   */
  customCommandTemplate: string;
}

/**
 * Build the remote command that SSH will execute.
 *
 * @param envPrefix  Pre-built `KEY='val' KEY2='val2'` string (may be empty).
 * @param profile    Active cluster profile configuration.
 * @returns The full remote command string passed to `ssh <host> <command>`.
 */
export function buildRemoteCommand(
  envPrefix: string,
  profile: ClusterProfileConfig
): string {
  // The "script invocation" is always:  [env KEY=val …] bash -s
  const scriptInvocation = envPrefix ? `env ${envPrefix} bash -s` : "bash -s";

  switch (profile.profile) {
    case "direct": {
      // Current behaviour: pipe through tr then execute bash
      const bashCmd = envPrefix ? `${envPrefix} bash -s` : "bash -s";
      return `tr -d '\\r' | ${bashCmd}`;
    }

    case "docker": {
      const container = profile.dockerContainer.trim();
      if (!container) {
        throw new Error(
          "Cluster profile is 'docker' but no container name is configured. " +
            "Set 'remoteProxy.dockerContainer' in settings."
        );
      }
      // Pipe stdin through tr, then into docker exec which runs bash inside the container
      return `tr -d '\\r' | docker exec -i ${container} ${scriptInvocation}`;
    }

    case "custom": {
      const template = profile.customCommandTemplate.trim();
      if (!template) {
        throw new Error(
          "Cluster profile is 'custom' but no command template is configured. " +
            "Set 'remoteProxy.customCommandTemplate' in settings."
        );
      }
      if (!template.includes("{{SCRIPT}}")) {
        throw new Error(
          "Custom command template must contain the {{SCRIPT}} placeholder. " +
            "Example: 'sudo {{SCRIPT}}'"
        );
      }
      const expanded = template.replace(/\{\{SCRIPT\}\}/g, scriptInvocation);
      return `tr -d '\\r' | ${expanded}`;
    }

    default: {
      const _exhaustive: never = profile.profile;
      throw new Error(`Unknown cluster profile: ${_exhaustive}`);
    }
  }
}

/**
 * Build the command for **local** execution (no SSH wrapper).
 *
 * The cluster profile wrapping (docker, custom) applies identically —
 * it wraps the bash invocation regardless of whether SSH is involved.
 *
 * @param envPrefix  Pre-built `KEY='val' KEY2='val2'` string (may be empty).
 * @param profile    Active cluster profile configuration.
 * @returns The full local command string passed to `bash -c "<command>"`.
 */
export function buildLocalCommand(
  envPrefix: string,
  profile: ClusterProfileConfig
): string {
  const scriptInvocation = envPrefix ? `env ${envPrefix} bash -s` : "bash -s";

  switch (profile.profile) {
    case "direct": {
      const bashCmd = envPrefix ? `${envPrefix} bash -s` : "bash -s";
      return bashCmd;
    }

    case "docker": {
      const container = profile.dockerContainer.trim();
      if (!container) {
        throw new Error(
          "Cluster profile is 'docker' but no container name is configured. " +
            "Set 'remoteProxy.dockerContainer' in settings."
        );
      }
      return `docker exec -i ${container} ${scriptInvocation}`;
    }

    case "custom": {
      const template = profile.customCommandTemplate.trim();
      if (!template) {
        throw new Error(
          "Cluster profile is 'custom' but no command template is configured. " +
            "Set 'remoteProxy.customCommandTemplate' in settings."
        );
      }
      if (!template.includes("{{SCRIPT}}")) {
        throw new Error(
          "Custom command template must contain the {{SCRIPT}} placeholder. " +
            "Example: 'sudo {{SCRIPT}}'"
        );
      }
      return template.replace(/\{\{SCRIPT\}\}/g, scriptInvocation);
    }

    default: {
      const _exhaustive: never = profile.profile;
      throw new Error(`Unknown cluster profile: ${_exhaustive}`);
    }
  }
}
