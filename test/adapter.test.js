/**
 * Adapter test suite. Runs inside the built image, against a MinIO container
 * standing in for S3. Driven by test/run.sh — see README.md.
 */

const Adapter = require(process.env.ADAPTER_PATH || '/var/lib/ghost/adapters/storage/s3')
const fs = require('fs')

const ENDPOINT = process.env.S3_ENDPOINT || 'http://minio:9000'
const BUCKET = process.env.S3_BUCKET || 'ghost-test'

const results = []
const check = (name, ok, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)

const baseConfig = {
  accessKeyId: 'testkey',
  secretAccessKey: 'testsecret123',
  bucket: BUCKET,
  endpoint: ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: 'true',
  assetHost: `${ENDPOINT}/${BUCKET}`
}

async function main () {
  const store = new Adapter(baseConfig)

  // Region: SDK v3 demands one where v2 did not.
  check('region derived from a B2-style endpoint',
    new Adapter({ bucket: 'b', endpoint: 'https://s3.us-west-004.backblazeb2.com' })
      .region === 'us-west-004')

  let regionErr = ''
  try { new Adapter({ bucket: 'b', endpoint: 'https://nyc3.digitaloceanspaces.com' }) } catch (e) { regionErr = e.message }
  check('missing, underivable region throws a clear error',
    regionErr.includes('region not specified'))

  // Ghost hands config through as strings; "false" must not read as true.
  check('forcePathStyle "false" parses as false',
    new Adapter({ bucket: 'b', region: 'x', forcePathStyle: 'false' }).forcePathStyle === false)
  check('forcePathStyle "true" parses as true', store.forcePathStyle === true)

  fs.writeFileSync('/tmp/photo.jpg', Buffer.from('hello ghost s3 adapter'))
  const file = { name: 'photo.jpg', path: '/tmp/photo.jpg', type: 'image/jpeg' }

  check('exists() false for a missing key', (await store.exists('nope.jpg', '2026/07')) === false)

  const url = await store.save(file)
  check('save() returns an assetHost url',
    new RegExp(`^${ENDPOINT}/${BUCKET}/\\d{4}/\\d{2}/photo\\.jpg$`).test(url), url)

  const dir = url.split('/').slice(-3, -1).join('/')

  check('exists() true after save', (await store.exists('photo.jpg', dir)) === true)
  check('save() de-duplicates a colliding name', (await store.save(file)).endsWith('photo-1.jpg'))
  check('read() round-trips content',
    (await store.read({ path: url })).toString() === 'hello ghost s3 adapter')

  // Regression: assetHost with a path must not end up duplicated in the key.
  check('urlToPath() strips the whole assetHost, path included',
    store.urlToPath(url) === `/${dir}/photo.jpg`, store.urlToPath(url))

  // serve()
  const headers = {}
  const chunks = []
  const res = {
    set: h => Object.assign(headers, h),
    on () {}, once () {}, emit () {}, end () {},
    write (c) { chunks.push(c); return true }
  }
  await new Promise(resolve => {
    res.end = () => resolve()
    store.serve()({ path: `/${dir}/photo.jpg` }, res, err => resolve(err))
  })
  check('serve() streams the body', Buffer.concat(chunks).toString() === 'hello ghost s3 adapter')
  check('serve() sets content-type', headers['content-type'] === 'image/jpeg')

  const notFound = await new Promise(resolve =>
    store.serve()({ path: `/${dir}/missing.jpg` }, { set () {} }, err => resolve(err)))
  check('serve() maps a miss to NotFoundError', notFound?.code === 'STATIC_FILE_NOT_FOUND')

  check('delete() returns true', (await store.delete('photo.jpg', dir)) === true)
  check('exists() false after delete', (await store.exists('photo.jpg', dir)) === false)

  // A failure that is not a 404 must not be reported as "does not exist" —
  // that would let getUniqueFileName hand back a name already in use.
  let threw = false
  try {
    await new Adapter({ ...baseConfig, accessKeyId: 'bad', secretAccessKey: 'bad' })
      .exists('photo.jpg', dir)
  } catch { threw = true }
  check('exists() throws on auth failure rather than returning false', threw)

  console.log(results.join('\n'))
  const failed = results.filter(r => r.startsWith('FAIL')).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1) })
