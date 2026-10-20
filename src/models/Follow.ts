// STAND-IN for Module A's follow graph. Only `isMutualFollow` is used by Module D.
import { Schema, model, Types } from 'mongoose';

const followSchema = new Schema({
  followerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  followeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});
followSchema.index({ followerId: 1, followeeId: 1 }, { unique: true });
followSchema.index({ followeeId: 1 });

export const Follow = model('Follow', followSchema);

export async function isMutualFollow(a: Types.ObjectId | string, b: Types.ObjectId | string): Promise<boolean> {
  const count = await Follow.countDocuments({
    $or: [
      { followerId: a, followeeId: b },
      { followerId: b, followeeId: a },
    ],
  });
  return count === 2;
}
