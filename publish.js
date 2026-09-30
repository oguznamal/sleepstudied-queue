import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { makeIg } from './ig.js';
import { s3Storage, githubRawStorage } from './storage.js';

const MAX_ATTEMPTS = 3;
const DAY = 86400000;
const MIN_SPACING_MS = (2 * 60 + 50) * 60000;
const MAX_MEDIA_PAGES = 10;

export const captionKey = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
export const captionFull = s => String(s ?? '').replace(/\s+/g, ' ').trim();

export function redact(text, { bucket, endpoint, token } = {}) {
  let out = String(text ?? '');
  if (token) out = out.split(token).join('[redacted]');
  if (endpoint) out = out.split(endpoint).join('[redacted]');
  if (bucket) out = out.split(bucket).join('[redacted]');
  return out
    .replace(/X-Amz-[A-Za-z0-9-]*=[^&\s"']*/gi, '[redacted]')
    .replace(/access_token=[^&\s"']*/gi, '[redacted]');
}

export const attemptsOf = queue => Object.fromEntries(queue.posts.map(p => [p.id, p.attempts ?? 0]));
export const attemptFailed = (before, queue) => queue.posts.some(p => (p.attempts ?? 0) > (before[p.id] ?? 0));

export function parseDryRun(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error('DRY_RUN must be exactly "true" or "false"');
}

export function nyHour(date) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(date));
}

export async function runOnce({ queue, now, ig, storage, root, dryRun = false, log: rawLog = console.log, secrets = {} }) {
  const log = m => rawLog(redact(m, secrets));
  const post = queue.posts
    .filter(p => p.status === 'queued' && Date.parse(p.at) <= now.getTime())
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (!post) { log('nothing due'); return queue; }

  const hour = nyHour(now);
  if (hour < 7 || hour >= 23) { log(`${post.id} held: outside 07:00-23:00 New York`); return queue; }

  const me = await ig.call('GET', '/me', { fields: 'user_id,username' });
  const since = Date.parse(post.at) - DAY;
  const want = captionFull(post.caption);
  let live = null;
  let newest = null;
  let unparseable = false;
  let after;
  for (let page = 0; page < MAX_MEDIA_PAGES && !live; page++) {
    const params = { fields: 'id,caption,timestamp', limit: '25' };
    if (after) params.after = after;
    const recent = await ig.call('GET', '/me/media', params);
    const items = recent.data || [];
    if (page === 0) {
      const ts = items.map(m => Date.parse(m.timestamp));
      if (ts.some(Number.isNaN)) unparseable = true;
      else if (ts.length) newest = Math.max(...ts);
    }
    live = items.find(m => Date.parse(m.timestamp) >= since && captionFull(m.caption) === want);
    const last = items[items.length - 1];
    const next = recent.paging?.next ? recent.paging?.cursors?.after : null;
    if (live || !next || !last || Date.parse(last.timestamp) < since) break;
    after = next;
  }
  if (live) {
    Object.assign(post, { status: 'published', media_id: live.id, published_at: live.timestamp, note: 'already live; not reposted' });
    log(`${post.id} already live as ${live.id}`);
    return queue;
  }
  if (unparseable) { log(`${post.id} held: spacing: unparseable timestamp`); return queue; }
  if (newest !== null && now.getTime() - newest < MIN_SPACING_MS) { log(`${post.id} held: spacing (newest post under 2h50m old)`); return queue; }

  const prefix = `${crypto.randomBytes(16).toString('hex')}/`;
  try {
    const slides = fs.readdirSync(path.join(root, post.dir)).filter(f => /^\d{2}\.jpg$/.test(f)).sort();
    const urls = slides.map(f => storage.put(path.join(root, post.dir, f), prefix + f));
    const creation = await ig.createCarousel(me.user_id, urls, post.caption);
    if (dryRun) { log(`DRY RUN ${post.id}: container ${creation} is ready and was not published`); return queue; }
    const mediaId = await ig.publish(me.user_id, creation);
    Object.assign(post, { status: 'published', media_id: mediaId, published_at: now.toISOString() });
    log(`${post.id} published as ${mediaId}`);
  } catch (e) {
    post.attempts = (post.attempts ?? 0) + 1;
    post.last_error = redact(String(e.message), secrets).slice(0, 300);
    if (post.attempts >= MAX_ATTEMPTS) post.status = 'failed';
    log(`${post.id} attempt ${post.attempts} failed: ${post.last_error}`);
  } finally {
    try { storage.removePrefix(prefix); } catch (e) { log(`cleanup failed: ${e.message}`); }
  }
  return queue;
}

function need(k) {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

async function main() {
  const dryRun = parseDryRun(process.env.DRY_RUN);
  const root = process.cwd();
  const file = path.join(root, 'queue.json');
  const queue = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ig = makeIg({ token: need('IG_ACCESS_TOKEN') });
  let secrets = { token: process.env.IG_ACCESS_TOKEN };
  let storage;
  if (process.env.S3_BUCKET) {
    secrets = { ...secrets, bucket: process.env.S3_BUCKET, endpoint: need('S3_ENDPOINT') };
    storage = s3Storage({ bucket: secrets.bucket, endpoint: secrets.endpoint });
  } else {
    // The checked-out commit is what holds the slide files, so ask git rather than trusting GITHUB_SHA.
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    storage = githubRawStorage({ repo: need('GITHUB_REPOSITORY'), sha, root });
  }
  const before = attemptsOf(queue);
  await runOnce({ queue, now: new Date(), ig, storage, root, dryRun, secrets });
  fs.writeFileSync(file, JSON.stringify(queue, null, 2) + '\n');
  if (attemptFailed(before, queue)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(redact(e.message, { bucket: process.env.S3_BUCKET, endpoint: process.env.S3_ENDPOINT, token: process.env.IG_ACCESS_TOKEN })); process.exit(1); });
