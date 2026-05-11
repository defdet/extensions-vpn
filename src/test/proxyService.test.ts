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
