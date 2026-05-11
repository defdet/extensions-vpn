# VS Code Extension Conversion Plan

## Goal

Package the current proxy-mode script workflow into a VS Code extension so users can enable/disable remote proxy mode from UI instead of terminal scripts.

## Scope

The extension should:

1. Accept and securely store `ssconf://` or `ss://` access key.
2. Run remote proxy lifecycle operations (`install`, `up`, `down`, `status`, `logs`, `test`) against current Remote-SSH host.
3. Apply/remove remote VS Code machine proxy settings.
4. Optionally enforce Codex workspace placement.
5. Surface health and diagnostics in status bar and output channel.

## High-Level Architecture

1. `workspace` extension host component:
   - Runs when connected to Remote-SSH.
   - Owns remote process management and remote settings mutation.
2. `ui` extension host component:
   - Presents commands, input UX, status bar.
   - Stores secret using VS Code `SecretStorage`.
3. Shared service layer:
   - Key resolution and validation.
   - Command execution wrappers.
   - Log parsing and status model.

## Proposed Commands

1. `Proxy: Configure Access Key`
2. `Proxy: Enable (Up)`
3. `Proxy: Disable (Down)`
4. `Proxy: Status`
5. `Proxy: Test Connectivity`
6. `Proxy: Show Logs`
7. `Proxy: Reinstall sslocal`

## Data and Secrets

1. Store access key in `SecretStorage` only.
2. Never print full key or password in logs.
3. Persist non-secret state in `globalState`:
   - last SSH host
   - last action time
   - last health result

## Permissions and User Prompts

1. VS Code extensions can prompt users (for example `showInformationMessage`, `showWarningMessage`, `showInputBox`, `showQuickPick`) before sensitive actions.
2. Extension prompts are UX consent, not OS-level sandbox permissions. In Remote-SSH, execution still uses the remote user account permissions.
3. First run per host should require explicit confirmation:
   - "This will install/start proxy tools on host X and update remote VS Code machine settings."
4. Provide "Preview command" and "Run now" options for risky operations.
5. Keep a per-host acknowledgment flag in `globalState` so users can re-confirm when host profile changes.

## Multi-Cluster Execution Profiles

1. Store execution profile per remote authority (for example `ssh-remote+gpu_polymer_2`).
2. Support at least these profile modes:
   - `direct`: execute command as-is on remote host.
   - `dockerExec`: wrap command into `docker exec -i <container> bash -lc "<cmd>"`.
   - `customTemplate`: user-defined wrapper template with `{cmd}` placeholder.
3. Add a profile wizard command:
   - "Select host -> Select mode -> Enter container/template -> Test command."
4. Cache successful profile probes and show active mode in status bar.
5. Fallback behavior:
   - if `direct` fails with policy restrictions, offer one-click switch to `dockerExec` mode.

## Execution Strategy

Option A (fastest): ship the current `setup_remote_ssconf_proxy.ps1` and invoke it from extension commands.

Option B (cleaner long-term): reimplement logic in TypeScript (key resolve + process manager + JSON settings updater).

Recommended path:

1. Start with Option A for rapid rollout.
2. Migrate to Option B once behavior stabilizes.

## UX Details

1. Status bar indicator:
   - `Proxy: On` (green)
   - `Proxy: Off` (gray)
   - `Proxy: Error` (red)
2. Output channel `Remote Proxy`:
   - Structured action logs.
3. Notifications:
   - On `up`: suggest VS Code reload/reconnect.
   - On `down`: confirm traffic reverted.

## Limitations to Document

1. Proxy effect depends on whether each extension respects VS Code proxy settings.
2. Some external CLIs started by extensions may bypass VS Code network stack.
3. Requires remote `python3`, `curl`, and outbound access to Shadowsocks endpoint.

## Rollout Plan

1. Milestone 1: internal alpha
   - Commands + script invocation + output channel.
2. Milestone 2: reliability
   - Better error handling, restart policies, status polling.
3. Milestone 3: team distribution
   - Signed `.vsix`, onboarding docs, troubleshooting checklist.

## Suggested Repo Structure (Extension)

1. `src/commands/*.ts`
2. `src/services/proxyService.ts`
3. `src/services/secretService.ts`
4. `resources/scripts/setup_remote_ssconf_proxy.ps1` (if Option A)
5. `package.json` command/menus/contributes

## Testing Checklist

1. Fresh machine with no `sslocal`: `up` installs and runs.
2. Invalid key: error is clear, no secret leak.
3. Restart VS Code: status remains accurate.
4. `down` always clears remote proxy settings.
5. Multiple SSH hosts: state isolation works.
