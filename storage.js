import { execFileSync } from 'node:child_process';
import path from 'node:path';

// S3-compatible bucket (Cloudflare R2 or Backblaze B2) through the AWS CLI on the runner.
export function s3Storage({ bucket, endpoint, run = args => execFileSync('aws', args, { encoding: 'utf8' }) }) {
  const ep = ['--endpoint-url', endpoint];
  return {
    put(localFile, key) {
      run(['s3', 'cp', localFile, `s3://${bucket}/${key}`, '--content-type', 'image/jpeg', '--only-show-errors', ...ep]);
      return run(['s3', 'presign', `s3://${bucket}/${key}`, '--expires-in', '3600', ...ep]).trim();
    },
    removePrefix(prefix) {
      run(['s3', 'rm', `s3://${bucket}/${prefix}`, '--recursive', '--only-show-errors', ...ep]);
    },
  };
}

// Images live in the (public) queue repo itself; Instagram fetches them from raw.githubusercontent.com.
export function githubRawStorage({ repo, sha, root }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) throw new Error('invalid GITHUB_REPOSITORY');
  if (!/^[0-9a-f]{40}$/i.test(String(sha))) throw new Error('invalid commit sha');
  return {
    put(localFile) {
      const rel = path.relative(path.resolve(root), path.resolve(localFile));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('file is outside the repo root');
      const encoded = rel.split(path.sep).map(encodeURIComponent).join('/');
      return `https://raw.githubusercontent.com/${repo}/${sha}/${encoded}`;
    },
    removePrefix() {},
  };
}
