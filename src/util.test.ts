import { expect, test } from "bun:test";
import { datePrefix, formatDuration, parseTarget, pool, sanitize } from "./util";

const GUID = "12345678-90ab-cdef-1234-567890abcdef";

test("parses a viewer URL", () => {
  expect(parseTarget(`https://host/Panopto/Pages/Viewer.aspx?id=${GUID}`)).toEqual({
    kind: "session",
    id: GUID,
  });
});

test("parses a folder URL with a quoted folderID", () => {
  const url = `https://host/Panopto/Pages/Sessions/List.aspx?folderID=%22${GUID}%22`;
  expect(parseTarget(url)).toEqual({ kind: "folder", id: GUID });
});

test("parses a folder id from the hash fragment", () => {
  const url = `https://host/Panopto/Pages/Sessions/List.aspx#folderID=%22${GUID}%22&page=0`;
  expect(parseTarget(url)).toEqual({ kind: "folder", id: GUID });
});

test("parses a bare guid as a session", () => {
  expect(parseTarget(GUID.toUpperCase())).toEqual({ kind: "session", id: GUID });
});

test("rejects junk", () => {
  expect(() => parseTarget("not a url")).toThrow();
});

test("sanitize strips path separators and trims", () => {
  expect(sanitize("Lecture 1/2: intro")).toBe("Lecture 1-2- intro");
  expect(sanitize("   ")).toBe("untitled");
});

test("datePrefix handles ISO and ASP.NET dates", () => {
  expect(datePrefix("2025-03-04T10:00:00Z")).toBe("2025-03-04");
  expect(datePrefix("/Date(1741082400000)/")).toBe("2025-03-04");
  expect(datePrefix(null)).toBeNull();
});

test("formatDuration", () => {
  expect(formatDuration(90)).toBe("1:30");
  expect(formatDuration(3671)).toBe("1:01:11");
});

test("pool preserves order and respects the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await Bun.sleep(5);
    inFlight--;
    return n * 2;
  });
  expect(out).toEqual([2, 4, 6, 8, 10]);
  expect(peak).toBeLessThanOrEqual(2);
});

test("datePrefix converts Panopto's 1601-epoch seconds", () => {
  expect(datePrefix(13432115686)).toBe("2026-08-25");
});
