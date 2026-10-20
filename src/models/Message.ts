import { Schema, model, Types, type InferSchemaType } from 'mongoose';
import { MESSAGE_MAX_CHARS } from '../constants.js';

export const MESSAGE_TYPES = ['TEXT', 'MEDIA', 'SYSTEM'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

const mediaSchema = new Schema(
  {
    url: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    width: Number,
    height: Number,
    durationSec: Number,
  },
  { _id: false },
);

const messageSchema = new Schema({
  conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
  senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: MESSAGE_TYPES, default: 'TEXT' },
  text: { type: String, default: '', maxlength: MESSAGE_MAX_CHARS },
  media: { type: mediaSchema, default: null },
  clientMessageId: { type: String, required: true, maxlength: 64 },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
});

messageSchema.index({ conversationId: 1, _id: -1 }); // history pages, cursor on _id
// A retried send returns the stored message instead of creating a duplicate.
messageSchema.index({ conversationId: 1, senderId: 1, clientMessageId: 1 }, { unique: true });

export type MessageDoc = InferSchemaType<typeof messageSchema> & { _id: Types.ObjectId };
export const Message = model('Message', messageSchema);
