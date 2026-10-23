export interface Cookie {
  value: string;
  maxAge: number | null; // seconds
}

/** Reads a cookie from Set-Cookie header values. */
export function readCookie(setCookies: string[], name: string): Cookie | null {
  for (const header of setCookies) {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    if (pair.slice(0, separator) !== name) continue;

    const maxAgeAttribute = attributes.find((a) => a.toLowerCase().startsWith("max-age="));
    return {
      value: pair.slice(separator + 1),
      maxAge: maxAgeAttribute ? Number(maxAgeAttribute.split("=")[1]) : null,
    };
  }
  return null;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}
