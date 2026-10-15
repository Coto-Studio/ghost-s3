# ghost-s3

The official Ghost image with an S3 storage adapter baked in.

Published to `ghcr.io/coto-studio/ghost-s3`.

## Why the adapter is vendored

This image used to `npm install ghost-storage-adapter-s3@2`. That package was
last published in **June 2022** and depends on **AWS SDK for JavaScript v2**,
which reached [end-of-support on 8 September 2025][eos] — hence the deprecation
notices in the container logs. It is not getting security patches.

The adapter itself is ~200 lines. Rather than fork an npm package and take on
publishing, the code now lives in [`adapter/`](adapter/) and is copied into the
image at build time. It is derived from [ghos3][ghos3], which had already ported
the original to AWS SDK v3. See [`adapter/LICENSE.md`](adapter/LICENSE.md).

Side effect: the image no longer carries AWS SDK v2, which was **99.8 MB** of
the previous 111.9 MB of `node_modules`.

[eos]: https://aws.amazon.com/blogs/developer/announcing-end-of-support-for-aws-sdk-for-javascript-v2/
[ghos3]: https://github.com/laosb/ghos3

## Configuration

Ghost loads the adapter when `storage.active` is `s3`. Configure it under
`storage.s3`, or with the environment variables in the right-hand column.

| Option | Env var | Notes |
|---|---|---|
| `bucket` | `GHOST_STORAGE_ADAPTER_S3_PATH_BUCKET` | Required. |
| `region` | `AWS_DEFAULT_REGION` | **Required** — see below. |
| `accessKeyId` | — | Falls back to the AWS default credential chain. |
| `secretAccessKey` | — | Must be set together with `accessKeyId`. |
| `endpoint` | `GHOST_STORAGE_ADAPTER_S3_ENDPOINT` | For non-AWS S3 (B2, R2, MinIO). |
| `assetHost` | `GHOST_STORAGE_ADAPTER_S3_ASSET_HOST` | CDN/proxy origin. Include the scheme. |
| `pathPrefix` | `GHOST_STORAGE_ADAPTER_S3_PATH_PREFIX` | Subdirectory within the bucket. |
| `forcePathStyle` | `GHOST_STORAGE_ADAPTER_S3_FORCE_PATH_STYLE` | Path-style URLs. |
| `acl` | `GHOST_STORAGE_ADAPTER_S3_ACL` | Defaults to `public-read`. |
| `checksums` | `GHOST_STORAGE_ADAPTER_S3_CHECKSUMS` | Defaults to off — see below. |

### `region` is now required

SDK v2 would sign requests without an explicit region when an `endpoint` was
set. **SDK v3 will not.** Existing stacks that set `endpoint` but no `region`
must add one:

```yaml
storage__s3__region: us-west-004
```

As a safety net the adapter derives the region from endpoints that embed it
(`s3.us-west-004.backblazeb2.com`, `s3.eu-central-1.amazonaws.com`), so a B2 or
AWS endpoint keeps working untouched. Endpoints that do not embed a region —
DigitalOcean Spaces, most MinIO deployments — will fail at boot with an explicit
error. Set `region` anyway rather than relying on the fallback.

### Checksums

SDK v3.729.0 began sending CRC32 checksum headers by default, which several
S3-compatible providers reject. The adapter requests checksums only when the API
requires it. Set `checksums: true` to restore the SDK default.

## Differences from `ghost-storage-adapter-s3@2`

Behavioural changes worth knowing about, beyond the SDK swap:

- **`region` is required** (above).
- **`urlToPath()` was added.** Without it, audio and video uploads fail on
  Ghost 5+. It strips the configured `assetHost` rather than returning
  `new URL(url).pathname` — with an `assetHost` that has a path, the latter
  duplicates that path into the object key.
- **`exists()` only reports `false` for a genuine 404.** Previously any error —
  including a network or credentials failure — read as "not there", which let
  `getUniqueFileName` return a name already in use and the upload would
  overwrite it. Other errors now propagate.
- **`serve()` returns Ghost's `NotFoundError`** on a miss instead of a bare 404.
- **Boolean options parse properly.** `Boolean("false")` is `true` in
  JavaScript, so the old adapter treated `forcePathStyle: "false"` as enabled.
- **`signatureVersion` and `serverSideEncryption` are gone.** SDK v3 handles
  signing itself and models SSE differently. Neither was in use here.
- **Uploads stream** with an explicit `ContentLength` rather than being read
  into memory first.

## Adapter location

The adapter is installed to `/var/lib/ghost/adapters/storage/s3` and found via
`paths.installedAdaptersPath`, which the Dockerfile sets. Ghost documents this
as the escape hatch for custom Docker builds. The older `content/adapters/`
location still works, but it sits inside the content volume and Ghost has it
marked for possible removal in 7.0.

## Testing

Requires Docker. Builds the image, runs the adapter against a throwaway MinIO,
and tears it down:

```bash
test/run.sh            # against ghost:6-alpine
test/run.sh 5-alpine   # against the legacy tag
```

## Building

```bash
docker buildx bake            # latest (6-alpine)
docker buildx bake legacy     # 5-alpine
```

CI builds on push to `main` and nightly against the upstream base image.

## Ghost 6 ships its own S3 adapter

Since 6.x, Ghost bundles `S3Storage` in core (`storage.active: S3Storage`),
which is why `@aws-sdk/client-s3` is already a Ghost dependency. It is verified
working against S3-compatible storage, and it supports multipart uploads, which
this adapter does not.

It is not a drop-in replacement here. It requires a non-empty
`staticFileURLPrefix`, so it writes `content/images/2026/07/photo.png` where
this adapter writes `2026/07/photo.png`. Per-feature prefixes work and are
verified — `storage.media.adapter` / `storage.files.adapter` set to `S3Storage`
inherit the common config and override the prefix, giving the usual
`content/images`, `content/media`, `content/files` split.

The obstacle is not the bucket layout, it is the database. **Ghost stores the
absolute asset URL**, not a `__GHOST_URL__` placeholder — the placeholder
rewrite only applies to URLs on the site's own domain, and the asset host is a
different domain. A published post holds the full CDN URL in `feature_image`,
`lexical` and rendered `html`, and the same is true of `posts_meta`, `tags`,
`users`, `settings` and `newsletters`. Relocating existing objects invalidates
every one of those references.

Three ways through it, if this migration is ever taken on:

1. **Leave existing objects alone.** Set the prefix and let only new uploads
   use it. Old URLs keep resolving. The bucket carries two layouts, and
   `read`/`delete` on pre-existing images throw `IncorrectUsageError` —
   `urlToPath` rejects any URL without the configured prefix — so deleting or
   reprocessing an old image fails.
2. **Move the objects and add one rewrite to b2-proxy.** It proxies
   `$request_uri` straight through to the bucket key, so a
   `rewrite ^/(\d{4}/\d{2}/.*)$ /content/images/$1 last;` maps every legacy URL
   onto its new location with no database changes. Same `read`/`delete` caveat:
   those calls go direct to S3 and never see the rewrite.
3. **Move the objects and rewrite the database.** The only option that leaves
   nothing behind. A scripted replacement across the tables above, with care
   around the JSON in `lexical`/`mobiledoc`.

The stronger argument for waiting is that none of this config is documented.
`cdnUrl`, `staticFileURLPrefix`, `multipartUploadThresholdBytes` and
`multipartChunkSizeBytes` are all required and all look like Ghost's own hosting
configuration. Migrating a bucket layout onto an undocumented interface means a
renamed key upstream breaks every site on the next nightly rebuild.

Worth revisiting when Ghost documents it, particularly around 7.0 when
`content/adapters` is due for removal. The multipart upload support is a genuine
advantage for large video.
