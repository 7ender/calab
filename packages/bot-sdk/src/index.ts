// Calab Bot SDK (ADR-0031, docs/19-bot-api.md).
export { Bot } from './bot.js';
export type {
  BotEvents,
  BotOptions,
  CommandEvent,
  FileInput,
  MessageDeleteEvent,
  ReactionEvent,
  SendContent,
  SendOptions,
} from './bot.js';
export { ApiError, GatewayFatalError, type GatewayFatal } from './errors.js';
export { Gateway, gatewayUrl, type GatewayOptions, type GatewayStatus, type SocketLike } from './gateway.js';
export { Rest, parseRetryAfter, type RestOptions } from './rest.js';
export { DELIVERY_HEADER, SIGNATURE_HEADER, parseWebhookUpdate, signWebhook, verifyWebhookSignature } from './webhook.js';
// Contract types the events and methods use (generated from proto/calaba/v1).
export type {
  Bot as BotProfile,
  BotCommand,
  BotWebhook,
  BotWebhookUpdate,
  DispatchEvent,
  DmSummary,
  FileMeta,
  JoinVoiceResponse,
  Message,
  MessageCommand,
  Ready,
  Resumed,
  Room,
  Sticker,
  StickerPack,
  UploadStickersResponse,
  User,
  VoiceState,
  Workspace,
  WorkspaceMember,
} from '@calaba/protocol';
export { RoomType } from '@calaba/protocol';
