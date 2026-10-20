import { Schema, model } from 'mongoose';

const userBlockSchema = new Schema({
  blockerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  blockedId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});
userBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

export const UserBlock = model('UserBlock', userBlockSchema);
