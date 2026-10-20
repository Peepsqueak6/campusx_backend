import { Schema, model, Types, type InferSchemaType } from 'mongoose';
import { MAX_GROUP_MEMBERS } from '../constants.js';

export const CONVERSATION_STATUSES = ['ACTIVE', 'REQUESTED', 'DECLINED'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

const participantSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    joinedAt: { type: Date, default: Date.now },
    lastReadMessageId: { type: Schema.Types.ObjectId, default: null },
    mutedUntil: { type: Date, default: null },
  },
  { _id: false },
);

const lastMessageSchema = new Schema(
  {
    messageId: Schema.Types.ObjectId,
    senderId: Schema.Types.ObjectId,
    preview: { type: String, default: '' },
    sentAt: Date,
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    isGroup: { type: Boolean, required: true },
    groupName: { type: String, maxlength: 50, default: null },
    groupAvatarUrl: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    adminIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    participantIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      validate: (v: unknown[]) => v.length <= MAX_GROUP_MEMBERS,
    },
    participants: [participantSchema],
    // "<lowerId>:<higherId>" for 1-on-1 chats only. Left unset for groups.
    directKey: { type: String },
    status: { type: String, enum: CONVERSATION_STATUSES, default: 'ACTIVE' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    declinedAt: { type: Date, default: null },
    memberCount: { type: Number, required: true },
    lastMessage: { type: lastMessageSchema, default: null },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

conversationSchema.index({ participantIds: 1, lastMessageAt: -1 }); // inbox
// Partial (not sparse): groups have no directKey, and a plain unique sparse index would still reject
// documents that store an explicit null. This guarantees one direct chat per pair of users.
conversationSchema.index({ directKey: 1 }, { unique: true, partialFilterExpression: { directKey: { $type: 'string' } } });

export type ConversationDoc = InferSchemaType<typeof conversationSchema> & { _id: Types.ObjectId };
export const Conversation = model('Conversation', conversationSchema);
