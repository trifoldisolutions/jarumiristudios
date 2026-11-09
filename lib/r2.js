// Cloudflare R2 client (S3-compatible API) — object storage for uploaded files, replacing
// local disk. See dev_resources/plans/july26-milestone.md's R2 migration entry for the full rollout plan.
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, CopyObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { Upload } = require("@aws-sdk/lib-storage");

const BUCKET = process.env.R2_BUCKET_NAME;

const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.S3_API,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// One-shot upload for content already fully in memory — used for images, which are buffered
// anyway so `sharp()` can generate a blur preview from the same buffer.
async function putObject(key, body, contentType) {
  await r2Client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

// Streams a file straight into R2 (multipart under the hood for large bodies) without ever
// fully buffering it in memory or touching local disk — used for video/audio/archives.
async function streamUpload(key, body, contentType) {
  const upload = new Upload({ client: r2Client, params: { Bucket: BUCKET, Key: key, Body: body, ContentType: contentType } });
  await upload.done();
}

// Short-lived signed URL for a private object — the read path redirects here instead of
// proxying bytes through Express (R2 natively supports Range requests for video scrubbing).
async function getPresignedDownloadUrl(key, expiresIn = 300) {
  return getSignedUrl(r2Client, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

// Server-side copy (no download/re-upload) — used to relocate an object to a new key when its
// logical folder changes, e.g. promoting a chat attachment into a booking's project files.
async function copyObject(fromKey, toKey) {
  await r2Client.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/${encodeURIComponent(fromKey)}`, Key: toKey }));
}

async function deleteObject(key) {
  if (!key) return;
  await r2Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// Batch delete — well above this app's per-booking file counts, so a single call always suffices.
async function deleteObjects(keys) {
  const list = keys.filter(Boolean);
  if (!list.length) return;
  await r2Client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: list.map((Key) => ({ Key })) } }));
}

async function headObject(key) {
  return r2Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

// Lists every key under a prefix (paginated — R2 caps a single response at 1000 keys).
async function listObjectKeys(prefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await r2Client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken }));
    (res.Contents || []).forEach((o) => keys.push(o.Key));
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

// Wipes every object under a prefix — R2 has no recursive-delete primitive (unlike
// fs.rmSync's {recursive:true}), so this is list-then-batch-delete. Since this app's R2 keys
// are flat (`<crCode>/<storedName>`), a single `<crCode>/` prefix covers every uploaded file,
// deliverable, and chat attachment for that booking in one call.
async function deleteObjectsByPrefix(prefix) {
  const keys = await listObjectKeys(prefix);
  await deleteObjects(keys);
}

// Same as above but preserves a given set of keys — used when a client-triggered file wipe must
// spare the booking's delivered final files (kept on record) while purging everything else.
async function deleteObjectsByPrefixExcept(prefix, keepKeys) {
  const keep = new Set((keepKeys || []).filter(Boolean));
  const keys = (await listObjectKeys(prefix)).filter((key) => !keep.has(key));
  await deleteObjects(keys);
}

module.exports = { r2Client, BUCKET, putObject, streamUpload, getPresignedDownloadUrl, copyObject, deleteObject, deleteObjects, deleteObjectsByPrefix, deleteObjectsByPrefixExcept, headObject, listObjectKeys };
