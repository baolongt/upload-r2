import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

// R2 speaks the S3 API. The region is always "auto".
export const r2 = new S3Client({
  region: 'auto',
  endpoint: config.endpoint,
  forcePathStyle: config.forcePathStyle,
  // R2 does not want the SDK's default CRC32 request checksums.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  },
});

export const BUCKET = config.bucket;
