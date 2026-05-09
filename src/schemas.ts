import { Static, Type } from "@sinclair/typebox";

export const MediaStateSchema = Type.Object({
  title: Type.Optional(Type.String()),
  artist: Type.Optional(Type.String()),
  album: Type.Optional(Type.String()),
  uniqueIdentifier: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  contentItemIdentifier: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  artworkData: Type.Optional(Type.String()),
  artworkMimeType: Type.Optional(Type.String()),
  playing: Type.Optional(Type.Boolean()),
  durationMicros: Type.Optional(Type.Number()),
  elapsedTimeMicros: Type.Optional(Type.Number()),
  timestampEpochMicros: Type.Optional(Type.Number()),
  playbackRate: Type.Optional(Type.Number()),
  prohibitsSkip: Type.Optional(Type.Boolean()),
  instrumental: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

export const StreamDataMessageSchema = Type.Object({
  type: Type.Literal("data"),
  diff: Type.Boolean(),
  payload: MediaStateSchema,
}, { additionalProperties: true });

export const StreamMessageSchema = Type.Union([
  StreamDataMessageSchema,
]);

export const CommandSymbolSchema = Type.Union([
  Type.Literal("<"),
  Type.Literal("_"),
  Type.Literal(">"),
  Type.Literal(">>"),
  Type.Literal("<<"),
  Type.Literal("|<<"),
  Type.Literal("|>>"),
]);

export const CommandMessageSchema = Type.Union([
  Type.Object({
    type: Type.Literal("seek"),
    position: Type.Number({ minimum: 0 }),
  }, { additionalProperties: true }),
  Type.Object({
    type: Type.Literal("command"),
    command: CommandSymbolSchema,
  }, { additionalProperties: true }),
]);

export const LyricsResponseSchema = Type.Object({
  id: Type.Number(),
  trackName: Type.String(),
  artistName: Type.String(),
  albumName: Type.String(),
  duration: Type.Number(),
  instrumental: Type.Boolean(),
  plainLyrics: Type.Optional(Type.String()),
  syncedLyrics: Type.Optional(Type.String()),
}, { additionalProperties: true });

export type MediaState = Static<typeof MediaStateSchema>;
export type StreamDataMessage = Static<typeof StreamDataMessageSchema>;
export type StreamMessage = Static<typeof StreamMessageSchema>;
export type CommandSymbol = Static<typeof CommandSymbolSchema>;
export type CommandMessage = Static<typeof CommandMessageSchema>;
export type LyricsResponse = Static<typeof LyricsResponseSchema>;
