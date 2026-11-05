import { BlockList, isIP } from "node:net";
import { normalizeIp } from "./ipAddress";
const INTEGER_PATTERN = /^\d+$/;

export type TrustProxyMode = "never" | "always" | "trusted";

/** Produces the configuration error used for every invalid trusted-proxy entry. */
const invalidTrustedProxy = (value: string): never => {
  throw new Error(`Invalid BFF_TRUSTED_PROXIES entry: ${value}; expected an IP address or CIDR range`);
};

/** Separates a CIDR address from its optional prefix without normalizing it. */
const splitRange = (value: string): [string, string | undefined] => {
  const parts = value.trim().split("/");
  if (parts.length > 2 || !parts[0]) invalidTrustedProxy(value);
  return [parts[0], parts[1]];
};

/** Validates an IP literal and reports the family needed for its prefix bounds. */
const getFamily = (address: string, original: string): "ipv4" | "ipv6" => {
  const family = isIP(address);
  if (family === 4) return "ipv4";
  if (family === 6) return "ipv6";
  return invalidTrustedProxy(original);
};

/** Parses and bounds a CIDR prefix according to the address family. */
const getPrefix = (value: string | undefined, family: "ipv4" | "ipv6", original: string): number | undefined => {
  if (value === undefined) return undefined;
  const maximum = family === "ipv4" ? 32 : 128;
  if (!INTEGER_PATTERN.test(value)) invalidTrustedProxy(original);
  const prefix = Number(value);
  return prefix <= maximum ? prefix : invalidTrustedProxy(original);
};

/** Adds one already-validated address or CIDR to the matcher. */
const addRange = (blockList: BlockList, value: string): void => {
  const [rawAddress, rawPrefix] = splitRange(value);
  // Keep mapped IPv6 ranges intact. Matching additionally checks an IPv4-normalized
  // candidate so a mapped socket peer also matches an ordinary IPv4 allowlist.
  const address = normalizeIp(rawAddress, false) ?? invalidTrustedProxy(value);
  const family = getFamily(address, value);
  const prefix = getPrefix(rawPrefix, family, value);
  if (prefix === undefined) blockList.addAddress(address, family);
  else blockList.addSubnet(address, prefix, family);
};

export type TrustedProxyMatcher = {
  isTrusted(address: string): boolean;
};

/** Compiles configured CIDRs into a matcher for the direct peer address. */
export function createTrustedProxyMatcher(values: readonly string[]): TrustedProxyMatcher {
  const blockList = new BlockList();
  values.forEach((value) => addRange(blockList, value));
  return {
    isTrusted(address: string): boolean {
      const original = normalizeIp(address, false);
      const mapped = normalizeIp(address);
      return [original, mapped]
        .filter((candidate): candidate is string => candidate !== null)
        .some((candidate) => blockList.check(candidate, isIP(candidate) === 4 ? "ipv4" : "ipv6"));
    }
  };
}
