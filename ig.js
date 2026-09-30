const BASE = 'https://graph.instagram.com/v23.0';

export function makeIg({ token, fetchImpl = fetch, timeoutMs = 60000, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  async function call(method, path, params = {}) {
    const body = new URLSearchParams({ ...params, access_token: token });
    const res = method === 'GET' ? await fetchImpl(`${BASE}${path}?${body}`, { signal: AbortSignal.timeout(timeoutMs) }) : await fetchImpl(`${BASE}${path}`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`IG ${method} ${path}: ${json.error?.message ?? res.status}`);
    return json;
  }
  async function waitReady(id, tries = 20) {
    for (let i = 0; i < tries; i++) {
      const { status_code } = await call('GET', `/${id}`, { fields: 'status_code' });
      if (status_code === 'FINISHED') return;
      if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`container ${id} ${status_code}`);
      await sleep(3000);
    }
    throw new Error(`container ${id} not ready`);
  }
  async function createCarousel(userId, imageUrls, caption) {
    if (imageUrls.length < 2 || imageUrls.length > 10) throw new Error(`a carousel needs 2-10 images, got ${imageUrls.length}`);
    const children = [];
    for (const image_url of imageUrls) children.push((await call('POST', `/${userId}/media`, { image_url, is_carousel_item: 'true' })).id);
    for (const id of children) await waitReady(id);
    const { id } = await call('POST', `/${userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
    await waitReady(id);
    return id;
  }
  async function publish(userId, creationId) {
    return (await call('POST', `/${userId}/media_publish`, { creation_id: creationId })).id;
  }
  return { call, waitReady, createCarousel, publish };
}
