import assert from "node:assert/strict";
import {
  buildRevertScriptArgs,
  buildSecretKey,
  buildSetupScriptArgs,
  deriveHostFromAuthority,
  deriveStatusPatch,
  normalizeProxyError,
  parseScriptEvent,
  redactLine
} from "../services/proxyCore";

suite("Proxy Service Unit", () => {
  test("buildSecretKey uses per-authority namespace", () => {
    assert.equal(
      buildSecretKey("ssh-remote+gpu_polymer_2"),
      "remoteProxy.accessKey.ssh-remote+gpu_polymer_2"
    );
  });

  test("deriveHostFromAuthority uses configured override first", () => {
    assert.equal(deriveHostFromAuthority("ssh-remote+gpu_polymer_2", "custom-host"), "custom-host");
    assert.equal(deriveHostFromAuthority("ssh-remote+gpu_polymer_2", ""), "gpu_polymer_2");
  });

  test("buildSetupScriptArgs builds expected action payload", () => {
    const args = buildSetupScriptArgs(
      "C:\\tmp\\setup.ps1",
      "up",
      "gpu_polymer_2",
      {
        socksPort: 1080,
        shadowsocksVersion: "v1.24.0",
        testUrl: "https://api.openai.com/v1/models",
        logTailLines: 80
      },
      "ssconf://abc"
    );
    assert.equal(args[0], "-File");
    assert.ok(args.includes("-Action"));
    assert.ok(args.includes("up"));
    assert.ok(args.includes("-AccessKey"));
  });

  test("buildRevertScriptArgs builds expected payload", () => {
    const args = buildRevertScriptArgs("C:\\tmp\\revert.ps1", "gpu_polymer_2", {
      socksPort: 1080,
      logTailLines: 120
    });
    assert.ok(args.includes("-SshHost"));
    assert.ok(args.includes("gpu_polymer_2"));
    assert.ok(args.includes("-LogTailLines"));
    assert.ok(args.includes("120"));
  });

  test("redactLine masks secrets and ss urls", () => {
    const raw = "password=abc123 key=ss://exampleSecret";
    const redacted = redactLine(raw, ["abc123"]);
    assert.ok(!redacted.includes("abc123"));
    assert.ok(redacted.includes("ss://<redacted>"));
  });

  test("parseScriptEvent maps log levels", () => {
    const ev = parseScriptEvent("[2026-05-09 12:00:00][ERROR] Boom");
    assert.equal(ev.kind, "error");
    assert.equal(ev.message, "Boom");
  });

  test("deriveStatusPatch maps running/proxy states", () => {
    const patch = deriveStatusPatch([
      "[2026-05-09 12:00:00][OK] sslocal is running (pid=1)",
      "[proxy-state] {'http.proxySupport': 'on'}"
    ]);
    assert.equal(patch.runningState, "on");
    assert.equal(patch.proxyState, "enabled");
  });

  test("normalizeProxyError maps auth failures", () => {
    const out = normalizeProxyError(new Error("Failed to fetch URL: test"));
    assert.equal(out.code, "AuthKeyError");
  });
});
