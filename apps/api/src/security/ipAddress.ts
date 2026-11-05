import { isIP } from "node:net";

const IPV6_MAPPED_IPV4_PREFIX = "::ffff:";

export const normalizeIp = (value: string | null | undefined, mapIpv4Mapped = true): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.split("%")[0].toLowerCase();
  return mapIpv4Mapped && normalized.startsWith(IPV6_MAPPED_IPV4_PREFIX)
    ? normalized.slice(IPV6_MAPPED_IPV4_PREFIX.length)
    : normalized;
};

/** Rewrites a dotted IPv4 tail (`::1.2.3.4`) as its two 16-bit hex groups. */
const hexTail = (address: string): string => address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) =>
  `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`);

/** Expands `::` and returns the eight 16-bit groups of an IPv6 literal. */
const expandIpv6 = (address: string): string[] => {
  const [head, tail] = hexTail(address).split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array<string>(8 - headGroups.length - tailGroups.length).fill("0");
  return [...headGroups, ...fill, ...tailGroups];
};

/** Buckets IPv6 clients by /64, since one subscriber can rotate through a whole /64. */
export const rateLimitIdentity = (address: string): string => {
  if (isIP(address) !== 6) return address;
  const prefix = expandIpv6(address.split("%")[0].toLowerCase()).slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ""));
  // ::/64 holds loopback and IPv4-mapped or -compatible forms, which name single hosts; keep them distinct.
  if (prefix.every((group) => group === "0")) return address;
  return `${prefix.join(":")}::/64`;
};
