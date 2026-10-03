import { createWriteStream } from 'node:fs';
import { get, request } from 'node:https';
import { pipeline } from 'node:stream/promises';

type DownloadGrant = { url: string; token: string; expires_at: number; token_type: 'Bearer' };

class DownloadHttpError extends Error {
  constructor(readonly statusCode: number) {
    super(`artifact download failed with HTTP ${statusCode}`);
  }
}

function validateGrant(raw: unknown, serviceUrl: string): DownloadGrant {
  try {
    if (!raw || typeof raw !== 'object') throw new Error();
    const grant = raw as Record<string, unknown>;
    if (typeof grant.url !== 'string' || typeof grant.token !== 'string' ||
        grant.token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(grant.token) ||
        grant.token_type !== 'Bearer' || !Number.isSafeInteger(grant.expires_at) ||
        (grant.expires_at as number) <= Math.floor(Date.now() / 1000)) throw new Error();
    const url = new URL(grant.url);
    const source = new URL(serviceUrl).pathname.match(/\/v1\/audio-artifacts\/engine\/(\d+\.\d+\.\d+)\/([^/]+)\/token$/);
    if (!source || url.origin !== 'https://download.tellus.ai.kr' || url.username || url.password || url.search || url.hash ||
        !['dev', 'stg', 'prod'].some((environment) => url.pathname === `/${environment}/audio/engine/v${source[1]}/${decodeURIComponent(source[2])}`)) throw new Error();
    return grant as DownloadGrant;
  } catch {
    throw new Error('invalid artifact download grant');
  }
}

function requestGrant(serviceUrl: string, installationToken: string): Promise<DownloadGrant> {
  return new Promise((resolve, reject) => {
    const req = request(serviceUrl, { method: 'POST', headers: {
      Authorization: `Bearer ${installationToken}`, Accept: 'application/json',
      'User-Agent': 'tellus-audio-sdk-installer',
    } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new DownloadHttpError(response.statusCode || 0));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_384) {
          response.destroy(new Error('artifact download grant is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(validateGrant(JSON.parse(Buffer.concat(chunks).toString('utf8')), serviceUrl));
        } catch {
          reject(new Error('invalid artifact download grant'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('artifact token request timed out')));
    req.end();
  });
}

function downloadGrantedFile(grant: DownloadGrant, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = get(grant.url, { headers: {
      Authorization: `Bearer ${grant.token}`, Accept: 'application/octet-stream',
      'User-Agent': 'tellus-audio-sdk-installer',
    } }, (response) => {
      // Never follow a redirect carrying a download token, including same-origin redirects.
      if (response.statusCode !== 200) {
        response.resume();
        reject(new DownloadHttpError(response.statusCode || 0));
        return;
      }
      pipeline(response, createWriteStream(destination, { mode: 0o600 })).then(resolve, reject);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('artifact download timed out')));
  });
}

export async function downloadArtifact(serviceUrl: string, destination: string, installationToken: string): Promise<void> {
  const grant = await requestGrant(serviceUrl, installationToken);
  try {
    await downloadGrantedFile(grant, destination);
  } catch (error) {
    if (!(error instanceof DownloadHttpError) || error.statusCode !== 401) throw error;
    // A token that expires before the CDN request gets one fresh issuance, never an unbounded retry.
    await downloadGrantedFile(await requestGrant(serviceUrl, installationToken), destination);
  }
}
