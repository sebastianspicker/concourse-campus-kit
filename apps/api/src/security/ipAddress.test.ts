import { describe, expect, it } from "vitest";
import { rateLimitIdentity } from "./ipAddress";

describe("rateLimitIdentity", () => {
  it("maps addresses in one IPv6 /64 to the same key", () => {
    expect(rateLimitIdentity("2001:db8:1:2::a")).toBe("2001:db8:1:2::/64");
    expect(rateLimitIdentity("2001:db8:1:2:ffff::1")).toBe(rateLimitIdentity("2001:db8:1:2::a"));
  });

  it("separates different /64 networks", () => {
    expect(rateLimitIdentity("2001:db8:1:3::1")).not.toBe(rateLimitIdentity("2001:db8:1:2::1"));
  });

  it("strips leading zeros so spellings agree", () => {
    expect(rateLimitIdentity("2001:0db8:0001:0002:0:0:0:1")).toBe(rateLimitIdentity("2001:db8:1:2::1"));
  });

  it("groups a dotted IPv4 tail with its /64", () => {
    expect(rateLimitIdentity("2001:db8:1:2::1.2.3.4")).toBe("2001:db8:1:2::/64");
    expect(rateLimitIdentity("64:ff9b::1.2.3.4")).toBe("64:ff9b:0:0::/64");
  });

  it("keeps loopback and IPv4-mapped forms in ::/64 distinct", () => {
    expect(rateLimitIdentity("::ffff:102:304")).toBe("::ffff:102:304");
    expect(rateLimitIdentity("::1")).toBe("::1");
  });

  it("leaves IPv4 unchanged", () => {
    expect(rateLimitIdentity("203.0.113.7")).toBe("203.0.113.7");
  });
});
