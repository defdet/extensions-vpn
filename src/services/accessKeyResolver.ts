import * as http from "node:http";
import * as https from "node:https";

export interface AccessKeyRuntime {
  serverInfoB64: string;
  source: string;
  summary: string;
}

interface ConfigObj {
  server: string;
  server_port: number;
  password: string;
  method: string;
}

function decodeBase64Loose(value: string): string | null {
  let v = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (v.length % 4 !== 0) {
    v += "=";
  }
  try {
    return Buffer.from(v, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

export function parseSsUrl(url: string): ConfigObj | null {
  if (!url.startsWith("ss://")) {
    return null;
  }
  let rest = url.substring(5);
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    rest = rest.substring(0, hashIdx);
  }
  const qIdx = rest.indexOf("?");
  if (qIdx >= 0) {
    rest = rest.substring(0, qIdx);
  }
  const slashIdx = rest.indexOf("/");
  if (slashIdx >= 0) {
    rest = rest.substring(0, slashIdx);
  }
  if (!rest) {
    return null;
  }

  const atIdx = rest.lastIndexOf("@");
  if (atIdx >= 0) {
    // SIP002: base64(method:password)@host:port
    const userInfo = rest.substring(0, atIdx);
    const hostPort = rest.substring(atIdx + 1);
    const decoded = decodeBase64Loose(userInfo);
    if (decoded === null) {
      return null;
    }
    const colon = decoded.indexOf(":");
    if (colon < 0) {
      return null;
    }
    const method = decoded.substring(0, colon);
    const password = decoded.substring(colon + 1);
    let ep: { host: string; port: number };
    try {
      ep = parseEndpoint(hostPort);
    } catch {
      return null;
    }
    return { server: ep.host, server_port: ep.port, method, password };
  }

  // Legacy: base64(method:password@host:port)
  const decoded = decodeBase64Loose(rest);
  if (decoded === null) {
    return null;
  }
  const atIdx2 = decoded.lastIndexOf("@");
  if (atIdx2 < 0) {
    return null;
  }
  const credentials = decoded.substring(0, atIdx2);
  const hostPort = decoded.substring(atIdx2 + 1);
  const colon = credentials.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const method = credentials.substring(0, colon);
  const password = credentials.substring(colon + 1);
  let ep: { host: string; port: number };
  try {
    ep = parseEndpoint(hostPort);
  } catch {
    return null;
  }
  return { server: ep.host, server_port: ep.port, method, password };
}

export function encodeBase64Utf8(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

export function fetchUrl(url: string, depth = 0): Promise<string> {
  if (depth > 5) {
    return Promise.reject(new Error(`Failed to fetch URL: ${url} (too many redirects)`));
  }
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https://") ? https : http;
    const req = client.get(url, { timeout: 20_000 }, (res) => {
      const status = res.statusCode ?? 0;
      if (
        (status >= 301 && status <= 303) ||
        status === 307 ||
        status === 308
      ) {
        const location = res.headers.location;
        if (location) {
          fetchUrl(location, depth + 1).then(resolve, reject);
          return;
        }
      }
      if (status >= 400) {
        reject(new Error(`Failed to fetch URL: ${url} (HTTP ${status})`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Failed to fetch URL: ${url} (timeout)`));
    });
  });
}

export function parseEndpoint(endpoint: string): { host: string; port: number } {
  const ep = endpoint.trim();
  // IPv6: [host]:port
  if (ep.startsWith("[") && ep.includes("]:")) {
    const idx = ep.lastIndexOf("]:");
    const host = ep.substring(1, idx);
    const port = parseInt(ep.substring(idx + 2), 10);
    return { host, port };
  }
  // host:port
  const parts = ep.split(":");
  if (parts.length < 2) {
    throw new Error(`Endpoint does not include host:port: ${endpoint}`);
  }
  const port = parseInt(parts[parts.length - 1], 10);
  const host = parts.slice(0, parts.length - 1).join(":");
  return { host, port };
}

export function parseYamlLikePayload(payload: string): ConfigObj | null {
  let endpoint: string | null = null;
  let cipher: string | null = null;
  let secret: string | null = null;

  for (const line of payload.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) {
      continue;
    }
    if (endpoint === null) {
      const m = s.match(/^endpoint:\s*([^\s#]+)/);
      if (m) {
        endpoint = m[1];
        continue;
      }
    }
    if (cipher === null) {
      const m = s.match(/^cipher:\s*([^\s#]+)/);
      if (m) {
        cipher = m[1];
        continue;
      }
    }
    if (secret === null) {
      const m = s.match(/^secret:\s*(.+)$/);
      if (m) {
        let val = m[1].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.substring(1, val.length - 1);
        }
        secret = val;
        continue;
      }
    }
  }

  if (endpoint === null || cipher === null || secret === null) {
    return null;
  }

  const ep = parseEndpoint(endpoint);
  return {
    server: ep.host,
    server_port: ep.port,
    password: secret,
    method: cipher,
  };
}

function buildRuntime(configObj: ConfigObj, source: string): AccessKeyRuntime {
  const serverInfo = JSON.stringify({
    server: configObj.server,
    server_port: configObj.server_port,
    password: configObj.password,
    method: configObj.method,
  });
  return {
    serverInfoB64: encodeBase64Utf8(serverInfo),
    source,
    summary: `server=${configObj.server}:${configObj.server_port}, method=${configObj.method}`,
  };
}

export async function resolveAccessKey(key: string): Promise<AccessKeyRuntime> {
  if (!key || !key.trim()) {
    throw new Error("Access key is empty.");
  }

  const trimmed = key.trim();

  // Direct ss:// URL
  if (trimmed.startsWith("ss://")) {
    const parsed = parseSsUrl(trimmed);
    if (!parsed) {
      throw new Error("Failed to parse ss:// URL.");
    }
    return buildRuntime(parsed, "inline-ss-url");
  }

  // Dynamic fetch
  let payload: string;
  let source: string;

  if (trimmed.startsWith("ssconf://")) {
    source = "dynamic-ssconf";
    const url = "https://" + trimmed.substring("ssconf://".length);
    payload = (await fetchUrl(url)).trim();
  } else if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://")
  ) {
    source = "dynamic-http";
    payload = (await fetchUrl(trimmed)).trim();
  } else {
    throw new Error(
      "Unsupported key format. Expected ssconf://, ss://, https:// or http://"
    );
  }

  // Dynamic payload returned an ss:// URL
  if (payload.startsWith("ss://")) {
    const parsed = parseSsUrl(payload);
    if (!parsed) {
      throw new Error("Dynamic key returned an ss:// URL that could not be parsed.");
    }
    return buildRuntime(parsed, source);
  }

  // Try JSON parse
  let configObj: ConfigObj | null = null;
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj.error === "string" && obj.error) {
      throw new Error(`Access provider returned error: ${obj.error}`);
    }

    const hasDirect =
      typeof obj.server === "string" &&
      (typeof obj.server_port === "number" ||
        typeof obj.server_port === "string") &&
      typeof obj.password === "string" &&
      typeof obj.method === "string";

    if (hasDirect) {
      configObj = {
        server: String(obj.server),
        server_port: Number(obj.server_port),
        password: String(obj.password),
        method: String(obj.method),
      };
    } else if (obj.transport?.tcp) {
      const tcp = obj.transport.tcp;
      if (tcp.endpoint && tcp.cipher && tcp.secret) {
        const ep = parseEndpoint(String(tcp.endpoint));
        configObj = {
          server: ep.host,
          server_port: ep.port,
          password: String(tcp.secret),
          method: String(tcp.cipher),
        };
      }
    }
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.startsWith("Access provider returned error:")
    ) {
      throw e;
    }
    configObj = null;
  }

  // Fallback: YAML-like
  if (configObj === null) {
    configObj = parseYamlLikePayload(payload);
  }

  if (configObj === null) {
    throw new Error(
      "Dynamic key payload is not recognized as ss://, JSON, or YAML config."
    );
  }

  return buildRuntime(configObj, source);
}
