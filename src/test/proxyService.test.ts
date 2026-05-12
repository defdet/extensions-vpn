import assert from "node:assert/strict";
import {
  buildSecretKey,
  deriveHostFromAuthority,
  deriveStatusPatch,
  normalizeProxyError,
  parseScriptEvent,
  redactLine
} from "../services/proxyCore";
import {
  encodeBase64Utf8,
  parseEndpoint,
  parseYamlLikePayload
} from "../services/accessKeyResolver";

suite("Proxy Core Unit", () => {
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

suite("Access Key Resolver Unit", () => {
  test("encodeBase64Utf8 encodes correctly", () => {
    const encoded = encodeBase64Utf8("ss://test@example:8080");
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    assert.equal(decoded, "ss://test@example:8080");
  });

  test("parseEndpoint handles host:port", () => {
    const ep = parseEndpoint("example.com:8388");
    assert.equal(ep.host, "example.com");
    assert.equal(ep.port, 8388);
  });

  test("parseEndpoint handles IPv6 [host]:port", () => {
    const ep = parseEndpoint("[::1]:8388");
    assert.equal(ep.host, "::1");
    assert.equal(ep.port, 8388);
  });

  test("parseEndpoint throws on missing port", () => {
    assert.throws(() => parseEndpoint("example.com"), /host:port/);
  });

  test("parseYamlLikePayload extracts config from YAML-like text", () => {
    const payload = [
      "# comment",
      "endpoint: example.com:8388",
      "cipher: aes-256-gcm",
      "secret: hunter2",
    ].join("\n");
    const result = parseYamlLikePayload(payload);
    assert.ok(result);
    assert.equal(result.server, "example.com");
    assert.equal(result.server_port, 8388);
    assert.equal(result.password, "hunter2");
    assert.equal(result.method, "aes-256-gcm");
  });

  test("parseYamlLikePayload strips quotes from secret", () => {
    const payload = [
      "endpoint: 1.2.3.4:443",
      "cipher: chacha20-ietf-poly1305",
      'secret: "my secret"',
    ].join("\n");
    const result = parseYamlLikePayload(payload);
    assert.ok(result);
    assert.equal(result.password, "my secret");
  });

  test("parseYamlLikePayload returns null for incomplete payload", () => {
    const result = parseYamlLikePayload("endpoint: a:1\ncipher: x\n");
    assert.equal(result, null);
  });
});

suite("Cluster Profile Unit", () => {
  // Import inline so the suite is self-contained
  const { buildRemoteCommand } = require("../services/clusterProfile") as typeof import("../services/clusterProfile");

  const direct = { profile: "direct" as const, dockerContainer: "", customCommandTemplate: "" };
  const docker = (container: string) => ({ profile: "docker" as const, dockerContainer: container, customCommandTemplate: "" });
  const custom = (template: string) => ({ profile: "custom" as const, dockerContainer: "", customCommandTemplate: template });

  test("direct profile without env prefix", () => {
    const cmd = buildRemoteCommand("", direct);
    assert.equal(cmd, "tr -d '\\r' | bash -s");
  });

  test("direct profile with env prefix", () => {
    const cmd = buildRemoteCommand("ACTION='up' PORT='1080'", direct);
    assert.equal(cmd, "tr -d '\\r' | ACTION='up' PORT='1080' bash -s");
  });

  test("docker profile wraps in docker exec", () => {
    const cmd = buildRemoteCommand("ACTION='up'", docker("my-container"));
    assert.equal(cmd, "tr -d '\\r' | docker exec -i my-container env ACTION='up' bash -s");
  });

  test("docker profile without env prefix", () => {
    const cmd = buildRemoteCommand("", docker("my-container"));
    assert.equal(cmd, "tr -d '\\r' | docker exec -i my-container bash -s");
  });

  test("docker profile with empty container throws", () => {
    assert.throws(() => buildRemoteCommand("", docker("")), /no container name/i);
  });

  test("custom profile replaces {{SCRIPT}} placeholder", () => {
    const cmd = buildRemoteCommand("KEY='val'", custom("sudo {{SCRIPT}}"));
    assert.equal(cmd, "tr -d '\\r' | sudo env KEY='val' bash -s");
  });

  test("custom profile without env prefix", () => {
    const cmd = buildRemoteCommand("", custom("sudo {{SCRIPT}}"));
    assert.equal(cmd, "tr -d '\\r' | sudo bash -s");
  });

  test("custom profile with empty template throws", () => {
    assert.throws(() => buildRemoteCommand("", custom("")), /no command template/i);
  });

  test("custom profile without {{SCRIPT}} placeholder throws", () => {
    assert.throws(() => buildRemoteCommand("", custom("sudo bash -s")), /\{\{SCRIPT\}\}/);
  });
});

suite("Local Execution Unit", () => {
  const { buildLocalCommand } = require("../services/clusterProfile") as typeof import("../services/clusterProfile");
  const { findLocalBash } = require("../services/localRunner") as typeof import("../services/localRunner");

  const direct = { profile: "direct" as const, dockerContainer: "", customCommandTemplate: "" };
  const docker = (container: string) => ({ profile: "docker" as const, dockerContainer: container, customCommandTemplate: "" });
  const custom = (template: string) => ({ profile: "custom" as const, dockerContainer: "", customCommandTemplate: template });

  test("direct local profile without env prefix", () => {
    const cmd = buildLocalCommand("", direct);
    assert.equal(cmd, "bash -s");
  });

  test("direct local profile with env prefix", () => {
    const cmd = buildLocalCommand("ACTION='up' PORT='1080'", direct);
    assert.equal(cmd, "ACTION='up' PORT='1080' bash -s");
  });

  test("docker local profile wraps in docker exec", () => {
    const cmd = buildLocalCommand("ACTION='up'", docker("my-container"));
    assert.equal(cmd, "docker exec -i my-container env ACTION='up' bash -s");
  });

  test("docker local profile without env prefix", () => {
    const cmd = buildLocalCommand("", docker("my-container"));
    assert.equal(cmd, "docker exec -i my-container bash -s");
  });

  test("docker local profile with empty container throws", () => {
    assert.throws(() => buildLocalCommand("", docker("")), /no container name/i);
  });

  test("custom local profile replaces {{SCRIPT}} placeholder", () => {
    const cmd = buildLocalCommand("KEY='val'", custom("sudo {{SCRIPT}}"));
    assert.equal(cmd, "sudo env KEY='val' bash -s");
  });

  test("custom local profile without env prefix", () => {
    const cmd = buildLocalCommand("", custom("sudo {{SCRIPT}}"));
    assert.equal(cmd, "sudo bash -s");
  });

  test("findLocalBash returns a string", () => {
    // On CI / dev machines, this should resolve to something.
    // On Windows without Git, it will throw — which is the expected behavior.
    try {
      const bash = findLocalBash();
      assert.equal(typeof bash, "string");
      assert.ok(bash.length > 0);
    } catch (err) {
      // On Windows without Git Bash, we expect a specific error message
      if (process.platform === "win32") {
        assert.ok((err as Error).message.includes("Git Bash is required"));
      } else {
        throw err;
      }
    }
  });
});

suite("SSH Runner Unit", () => {
  const { buildSshArgs } = require("../services/sshRunner") as typeof import("../services/sshRunner");

  test("buildSshArgs clears configured forwards", () => {
    const args = buildSshArgs("gpu_polymer_2", "bash -s");
    assert.deepEqual(args, ["-o", "ClearAllForwardings=yes", "gpu_polymer_2", "bash -s"]);
  });
});
