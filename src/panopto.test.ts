import { expect, test } from "bun:test";
import { captionLanguages, podcastStream, sourceStreams, stripHtml } from "./panopto";

test("captionLanguages trusts the delivery's own list", () => {
  expect(captionLanguages({ HasCaptions: true, AvailableCaptions: [{ Language: 16 }] })).toEqual([16]);
});

test("captionLanguages falls back to 0, or nothing when there are no captions", () => {
  expect(captionLanguages({ HasCaptions: true })).toEqual([0]);
  expect(captionLanguages({ HasCaptions: false })).toEqual([]);
});

test("podcastStream prefers a real mp4", () => {
  const chosen = podcastStream({
    PodcastStreams: [
      { StreamUrl: "https://cdn/x.m3u8" },
      { StreamUrl: "https://cdn/x.mp4?sig=1" },
    ],
  });
  expect(chosen?.StreamUrl).toBe("https://cdn/x.mp4?sig=1");
});

test("sourceStreams keeps Panopto's order and drops empty entries", () => {
  const streams = sourceStreams({
    Streams: [
      { StreamUrl: "dv", RelativeStart: 0, RelativeEnd: 100 },
      { StreamUrl: "", RelativeStart: 0, RelativeEnd: 100 },
      { StreamUrl: "object", RelativeStart: 0, RelativeEnd: 101 },
    ],
  });
  expect(streams.map((s) => s.StreamUrl)).toEqual(["dv", "object"]);
});

test("stripHtml flattens Panopto's HTML error messages", () => {
  expect(stripHtml("Unauthorized access.<br/>See <a href='/help'>help</a>.")).toBe(
    "Unauthorized access. See help",
  );
  expect(stripHtml("Session &amp; folder not found.")).toBe("Session & folder not found");
  expect(stripHtml("plain text")).toBe("plain text");
});
