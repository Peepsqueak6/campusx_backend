import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { MEDIA_MAX_BYTES, MEDIA_MIME_TYPES } from '../constants.js';
import { AppError } from '../errors.js';

let client: S3Client | undefined;
const s3 = () =>
  (client ??= new S3Client({
    region: config.media.region,
    endpoint: config.media.endpoint, // set for Cloudflare R2, empty for AWS S3
    forcePathStyle: Boolean(config.media.endpoint),
    credentials: { accessKeyId: config.media.accessKeyId, secretAccessKey: config.media.secretAccessKey },
  }));

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
};

/**
 * Presigned PUT for one chat attachment. The client uploads straight to R2/S3, then sends `mediaUrl`
 * back with the message. The size and type are signed into the URL, so the upload must match them.
 */
export async function presignChatUpload(userId: string, mimeType: string, sizeBytes: number) {
  if (!MEDIA_MIME_TYPES.includes(mimeType)) throw new AppError(422, 'INVALID_MEDIA', 'This file type is not allowed');
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MEDIA_MAX_BYTES) {
    throw new AppError(422, 'INVALID_MEDIA', `Files are limited to ${MEDIA_MAX_BYTES / 1024 / 1024} MB`);
  }
  const key = `chat/${userId}/${randomUUID()}.${EXTENSIONS[mimeType]}`;
  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: config.media.bucket, Key: key, ContentType: mimeType, ContentLength: sizeBytes }),
    { expiresIn: config.media.presignTtlSec },
  );
  return {
    uploadUrl,
    mediaUrl: `${config.media.baseUrl}/${key}`,
    mimeType,
    sizeBytes,
    expiresIn: config.media.presignTtlSec,
  };
}
