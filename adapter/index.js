'use strict'

/**
 * S3 storage adapter for Ghost, built on AWS SDK v3.
 *
 * Vendored rather than installed from npm — see README.md for why.
 * Derived from ghos3 (ISC, (c) Shibo Lyu) which in turn derives from
 * ghost-storage-adapter-s3 (MIT, (c) Colin Meinke). See LICENSE.md.
 */

const { S3 } = require('@aws-sdk/client-s3')
const StorageBase = require('ghost-storage-base')
const errors = require('@tryghost/errors')
const tpl = require('@tryghost/tpl')
const { join } = require('path')
const { createReadStream } = require('fs')
const { stat } = require('fs/promises')

const stripLeadingSlash = s => (s.startsWith('/') ? s.slice(1) : s)
const stripEndingSlash = s => (s.endsWith('/') ? s.slice(0, -1) : s)

// Error names S3 uses for "the key isn't there". HeadObject reports 404s as
// `NotFound`, GetObject as `NoSuchKey`.
const NOT_FOUND = new Set(['NotFound', 'NoSuchKey'])
const isNotFound = err =>
  NOT_FOUND.has(err?.name) || err?.$metadata?.httpStatusCode === 404

/**
 * Ghost passes config values through as strings, so `Boolean(value)` turns the
 * string "false" into `true`. Parse the usual falsey spellings instead.
 */
const readBool = (envValue, configValue, fallback = false) => {
  const raw = envValue !== undefined ? envValue : configValue
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  return !['false', '0', 'no', 'off'].includes(String(raw).trim().toLowerCase())
}

/**
 * SDK v3 requires an explicit region where v2 would sign without one. Most
 * S3-compatible endpoints embed the region (`s3.us-west-004.backblazeb2.com`,
 * `s3.eu-central-1.amazonaws.com`), so fall back to reading it off the endpoint
 * rather than failing a deploy that worked yesterday.
 */
const regionFromEndpoint = endpoint => {
  if (!endpoint) return undefined
  const host = endpoint.replace(/^https?:\/\//, '').split('/')[0]
  const match = host.match(/^s3[.-]([a-z]{2}-[a-z]+-\d+)\./)
  return match ? match[1] : undefined
}

class S3Storage extends StorageBase {
  constructor (config = {}) {
    super()

    const {
      accessKeyId,
      assetHost,
      bucket,
      pathPrefix,
      region,
      secretAccessKey,
      endpoint,
      forcePathStyle,
      acl,
      checksums
    } = config

    // Compatible with the aws-sdk's default environment variables
    this.accessKeyId = accessKeyId
    this.secretAccessKey = secretAccessKey

    this.bucket = process.env.GHOST_STORAGE_ADAPTER_S3_PATH_BUCKET || bucket
    if (!this.bucket) throw new Error('S3 storage adapter: bucket not specified')

    this.endpoint = process.env.GHOST_STORAGE_ADAPTER_S3_ENDPOINT || endpoint || ''

    this.region =
      process.env.AWS_DEFAULT_REGION || region || regionFromEndpoint(this.endpoint)
    if (!this.region) {
      throw new Error(
        'S3 storage adapter: region not specified, and it could not be derived ' +
        'from the endpoint. Set storage.s3.region (storage__s3__region) or ' +
        'AWS_DEFAULT_REGION — AWS SDK v3 requires it.'
      )
    }

    this.forcePathStyle = readBool(
      process.env.GHOST_STORAGE_ADAPTER_S3_FORCE_PATH_STYLE,
      forcePathStyle
    )

    // Several S3-compatible providers reject the CRC32 checksum headers the SDK
    // started sending by default in 3.729.0, so only send them where the API
    // actually requires it.
    this.checksums = readBool(
      process.env.GHOST_STORAGE_ADAPTER_S3_CHECKSUMS,
      checksums
    )

    const s3Subdomain = `s3${this.region === 'us-east-1' ? '' : `.${this.region}`}`
    const defaultHost = this.forcePathStyle
      ? `https://${s3Subdomain}.amazonaws.com/${this.bucket}`
      : `https://${this.bucket}.${s3Subdomain}.amazonaws.com`

    this.host =
      process.env.GHOST_STORAGE_ADAPTER_S3_ASSET_HOST || assetHost || defaultHost

    this.pathPrefix = stripLeadingSlash(
      process.env.GHOST_STORAGE_ADAPTER_S3_PATH_PREFIX || pathPrefix || ''
    )
    this.acl = process.env.GHOST_STORAGE_ADAPTER_S3_ACL || acl || 'public-read'
  }

  s3 () {
    const checksumMode = this.checksums ? 'WHEN_SUPPORTED' : 'WHEN_REQUIRED'

    const options = {
      region: this.region,
      forcePathStyle: this.forcePathStyle,
      requestChecksumCalculation: checksumMode,
      responseChecksumValidation: checksumMode
    }

    // Set credentials only if provided, falls back to AWS SDK's default provider chain
    if (this.accessKeyId && this.secretAccessKey) {
      options.credentials = {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey
      }
    }

    if (this.endpoint !== '') {
      options.endpoint = this.endpoint
    }

    return new S3(options)
  }

  async delete (fileName, targetDir) {
    const directory = targetDir || this.getTargetDir(this.pathPrefix)

    try {
      await this.s3().deleteObject({
        Bucket: this.bucket,
        Key: stripLeadingSlash(join(directory, fileName))
      })
    } catch {
      return false
    }
    return true
  }

  /**
   * Only a genuine 404 counts as "does not exist". Reporting a network or
   * credentials failure as `false` would let `getUniqueFileName` hand back a
   * name that is already taken, and the upload would overwrite it.
   */
  async exists (fileName, targetDir) {
    try {
      await this.s3().headObject({
        Bucket: this.bucket,
        Key: stripLeadingSlash(targetDir ? join(targetDir, fileName) : fileName)
      })
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
    return true
  }

  async save (file, targetDir) {
    const directory = targetDir || this.getTargetDir(this.pathPrefix)

    const fileName = await this.getUniqueFileName(file, directory)
    // Stream the body, but pass an explicit length: without it the SDK cannot
    // sign a stream of unknown size, and large media uploads fail.
    const { size } = await stat(file.path)

    await this.s3().putObject({
      ACL: this.acl,
      Body: createReadStream(file.path),
      ContentLength: size,
      Bucket: this.bucket,
      CacheControl: `max-age=${30 * 24 * 60 * 60}`,
      ContentType: file.type,
      Key: stripLeadingSlash(fileName)
    })

    return `${this.host}/${stripLeadingSlash(fileName)}`
  }

  serve () {
    return async (req, res, next) => {
      try {
        const output = await this.s3().getObject({
          Bucket: this.bucket,
          Key: stripLeadingSlash(stripEndingSlash(this.pathPrefix) + req.path)
        })

        const headers = {}
        if (output.AcceptRanges) headers['accept-ranges'] = output.AcceptRanges
        if (output.CacheControl) headers['cache-control'] = output.CacheControl
        if (output.ContentDisposition) headers['content-disposition'] = output.ContentDisposition
        if (output.ContentEncoding) headers['content-encoding'] = output.ContentEncoding
        if (output.ContentLanguage) headers['content-language'] = output.ContentLanguage
        if (output.ContentLength) headers['content-length'] = `${output.ContentLength}`
        if (output.ContentRange) headers['content-range'] = output.ContentRange
        if (output.ContentType) headers['content-type'] = output.ContentType
        if (output.ETag) headers.etag = output.ETag
        res.set(headers)

        output.Body.pipe(res)
      } catch (err) {
        if (isNotFound(err)) {
          return next(new errors.NotFoundError({
            message: tpl('File not found'),
            code: 'STATIC_FILE_NOT_FOUND',
            property: err.path
          }))
        }
        next(new errors.InternalServerError({ err }))
      }
    }
  }

  async read (options = {}) {
    // remove trailing slashes
    let path = (options.path || '').replace(/\/$|\\$/, '')

    // check if path is stored in s3 handled by us
    if (!path.startsWith(this.host)) {
      throw new Error(`${path} is not stored in s3`)
    }
    path = path.substring(this.host.length)

    const response = await this.s3().getObject({
      Bucket: this.bucket,
      Key: stripLeadingSlash(path)
    })

    return Buffer.from(await response.Body.transformToByteArray())
  }

  /**
   * Undocumented in Ghost, but required for non-image media (audio and video
   * cards) to resolve. See https://github.com/laosb/ghos3/pull/6
   *
   * Strips the configured host rather than returning `new URL(url).pathname`:
   * when assetHost carries a path (`https://cdn.example/bucket`) the pathname
   * still contains that path, and Ghost would derive a target directory with
   * the prefix duplicated — writing `bucket/2026/07/photo_o.png`.
   */
  urlToPath (url) {
    if (!url.startsWith(this.host)) {
      throw new Error(`${url} is not stored in s3`)
    }
    return url.substring(this.host.length)
  }
}

module.exports = S3Storage
