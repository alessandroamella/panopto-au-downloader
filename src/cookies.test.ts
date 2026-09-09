import { expect, test } from "bun:test";
import { domainMatches, isExpired } from "./cookies";

test("domainMatches respects host-only vs domain cookies", () => {
  expect(domainMatches("au.cloud.panopto.eu", "au.cloud.panopto.eu")).toBe(true);
  expect(domainMatches("au.cloud.panopto.eu", "cloud.panopto.eu")).toBe(false);
  expect(domainMatches("au.cloud.panopto.eu", ".panopto.eu")).toBe(true);
  expect(domainMatches("au.cloud.panopto.eu", ".panopto.eu".toUpperCase())).toBe(true);
  expect(domainMatches("au.cloud.panopto.eu", ".panopto.EU")).toBe(true);
  expect(domainMatches("panopto.eu", ".panopto.eu")).toBe(true);
  expect(domainMatches("evilpanopto.eu", ".panopto.eu")).toBe(false);
});

test("isExpired handles both second and millisecond expiries", () => {
  const now = Date.UTC(2026, 0, 1);
  expect(isExpired(0, now)).toBe(false); // session cookie
  expect(isExpired(Date.UTC(2025, 0, 1), now)).toBe(true); // ms, past
  expect(isExpired(Date.UTC(2027, 0, 1), now)).toBe(false); // ms, future
  expect(isExpired(Date.UTC(2025, 0, 1) / 1000, now)).toBe(true); // seconds, past
  expect(isExpired(Date.UTC(2027, 0, 1) / 1000, now)).toBe(false); // seconds, future
});
