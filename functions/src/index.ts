 import express, { Request, Response } from 'express';
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

admin.initializeApp();
const db = getFirestore();

const app = express();
app.use(express.json());

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const MAX_SITEMAP_DEPTH = 3;

type ParsedSitemap =
  | { type: 'index'; sitemaps: { loc: string; lastmod?: string | null }[] }
  | { type: 'urlset'; urls: { loc: string; lastmod?: string | null }[] };

type GscRow = {
  url: string;
  date: string; // YYYY-MM-DD
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

function makeUrlId(loc: string): string {
  return Buffer.from(loc).toString('base64url');
}

function isEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

function getIngestToken(): string | null {
  const fromEnv = process.env.FIXER_INGEST_TOKEN;
  const fromConfig = (functions.config()?.fixer?.ingest_token as string | undefined) ?? undefined;
  return fromEnv ?? fromConfig ?? null;
}

function requireIngestAuth(req: Request, res: Response): boolean {
  const expected = getIngestToken();
  if (!expected) {
    if (isEmulator()) return true;
    res.status(500).json({ error: 'ingest_token_not_configured' });
    return false;
  }

  const headerToken = req.get('x-fixer-token') || '';
  const authHeader = req.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : authHeader;
  const provided = headerToken || bearer;

  if (provided !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }

  return true;
}

type GscOauthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

function getGscOauthConfig(): GscOauthConfig | null {
  const clientId =
    process.env.GSC_CLIENT_ID ??
    ((functions.config()?.gsc?.client_id as string | undefined) ?? undefined) ??
    null;
  const clientSecret =
    process.env.GSC_CLIENT_SECRET ??
    ((functions.config()?.gsc?.client_secret as string | undefined) ?? undefined) ??
    null;
  const redirectUri =
    process.env.GSC_REDIRECT_URI ??
    ((functions.config()?.gsc?.redirect_uri as string | undefined) ?? undefined) ??
    null;

  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function isValidIsoDate(value: any): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function getGscRefreshToken(): Promise<string | null> {
  const fromEnv = process.env.GSC_REFRESH_TOKEN;
  const fromConfig = (functions.config()?.gsc?.refresh_token as string | undefined) ?? undefined;
  if (fromEnv || fromConfig) return fromEnv ?? fromConfig ?? null;

  const snap = await db.collection('integrations').doc('gsc').get();
  const token = snap.data()?.refreshToken;
  if (typeof token === 'string' && token) return token;
  return null;
}

let cachedGscAccessToken: string | null = null;
let cachedGscAccessTokenExpiryMs = 0;

async function refreshGscAccessToken(refreshToken: string): Promise<{ accessToken: string; expiryMs: number }> {
  const cfg = getGscOauthConfig();
  if (!cfg) throw new Error('gsc_oauth_config_missing');

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const resp = await axios.post('https://oauth2.googleapis.com/token', body.toString(), {
    timeout: 20000,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  const accessToken = resp.data?.access_token;
  const expiresIn = Number(resp.data?.expires_in ?? 0);
  if (!accessToken || !expiresIn) throw new Error('gsc_token_refresh_failed');

  const expiryMs = Date.now() + expiresIn * 1000;
  cachedGscAccessToken = accessToken;
  cachedGscAccessTokenExpiryMs = expiryMs;

  return { accessToken, expiryMs };
}

async function getGscAccessToken(): Promise<string> {
  if (cachedGscAccessToken && Date.now() < cachedGscAccessTokenExpiryMs - 60_000) return cachedGscAccessToken;
  const refreshToken = await getGscRefreshToken();
  if (!refreshToken) throw new Error('gsc_refresh_token_missing');
  const { accessToken } = await refreshGscAccessToken(refreshToken);
  return accessToken;
}

async function syncGscPageDate(siteId: string, gscSiteUrl: string, startDate: string, endDate: string, type = 'web') {
  const rowLimit = 25_000;
  let startRow = 0;
  let total = 0;

  while (true) {
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(gscSiteUrl)}/searchAnalytics/query`;
    const body = {
      startDate,
      endDate,
      dimensions: ['date', 'page'],
      type,
      rowLimit,
      startRow,
    };

    const makeRequest = async () => {
      const token = await getGscAccessToken();
      return axios.post(url, body, {
        timeout: 30000,
        headers: { Authorization: `Bearer ${token}` },
      });
    };

    let resp;
    try {
      resp = await makeRequest();
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) {
        cachedGscAccessToken = null;
        cachedGscAccessTokenExpiryMs = 0;
        resp = await makeRequest();
      } else {
        throw err;
      }
    }

    const apiRows = Array.isArray(resp.data?.rows) ? resp.data.rows : [];
    const rows: GscRow[] = apiRows
      .map((r: any) => {
        const date = Array.isArray(r.keys) ? r.keys[0] : null;
        const page = Array.isArray(r.keys) ? r.keys[1] : null;
        if (!date || !page) return null;
        return {
          url: String(page),
          date: String(date),
          clicks: Number(r.clicks ?? 0),
          impressions: Number(r.impressions ?? 0),
          ctr: Number(r.ctr ?? 0),
          position: Number(r.position ?? 0),
        };
      })
      .filter((r: any) => !!r && !!r.url && !!r.date);

    await saveGscRows(siteId, rows);
    total += rows.length;

    if (apiRows.length < rowLimit) break;
    startRow += rowLimit;
    if (startRow >= 250_000) break;
  }

  return total;
}

async function fetchSitemap(url: string, depth = 0): Promise<{ urls: { loc: string; lastmod?: string | null }[] }> {
  if (depth > MAX_SITEMAP_DEPTH) return { urls: [] };
  const resp = await axios.get(url, { timeout: 15000 });

  const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  functions.logger.info('fetchSitemap:response', {
    url,
    depth,
    status: resp.status,
    contentType: resp.headers['content-type'],
    length: raw.length,
    snippet: raw.slice(0, 500),
  });

  const parsed: unknown = parser.parse(raw);

  const sitemap = parseSitemap(parsed);
  if (sitemap.type === 'urlset') return { urls: sitemap.urls };

  const collected: { loc: string; lastmod?: string | null }[] = [];
  for (const sm of sitemap.sitemaps) {
    const child = await fetchSitemap(sm.loc, depth + 1);
    collected.push(...child.urls);
  }
  return { urls: collected };
}

function parseSitemap(data: any): ParsedSitemap {
  if (data?.sitemapindex?.sitemap) {
    const list = Array.isArray(data.sitemapindex.sitemap) ? data.sitemapindex.sitemap : [data.sitemapindex.sitemap];
    return {
      type: 'index',
      sitemaps: list
        .map((entry: any) => ({
          loc: entry.loc,
          lastmod: entry.lastmod ?? null,
        }))
        .filter((e: any) => !!e.loc),
    };
  }
  if (data?.urlset?.url) {
    const list = Array.isArray(data.urlset.url) ? data.urlset.url : [data.urlset.url];
    return {
      type: 'urlset',
      urls: list
        .map((entry: any) => ({
          loc: entry.loc,
          lastmod: entry.lastmod ?? null,
        }))
        .filter((e: any) => !!e.loc),
    };
  }
  functions.logger.warn('parseSitemap:unrecognized-structure', {
    topLevelKeys: Object.keys(data || {}),
  });
  return { type: 'urlset', urls: [] };
}

async function saveUrls(
  siteId: string,
  sitemapUrl: string | null,
  urls: { loc: string; lastmod?: string | null }[],
  source: 'sitemap' | 'direct'
) {
  const siteRef = db.collection('sites').doc(siteId);
  const urlsCol = siteRef.collection('urls');

  const batchSize = 400;
  for (let i = 0; i < urls.length; i += batchSize) {
    const slice = urls.slice(i, i + batchSize);
    const batch = db.batch();
    for (const u of slice) {
      const docId = makeUrlId(u.loc);
      const urlData: { [key: string]: any } = {
        loc: u.loc,
        source,
        fetchedAt: FieldValue.serverTimestamp(),
      };
      if (u.lastmod !== undefined) urlData.lastmod = u.lastmod ?? null;
      if (sitemapUrl) urlData.sitemapUrl = sitemapUrl;

      batch.set(urlsCol.doc(docId), urlData, { merge: true });
    }
    await batch.commit();
  }

  const siteData: any = {
    urlCount: urls.length,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (sitemapUrl) siteData.sitemapUrl = sitemapUrl;

  await siteRef.set(siteData, { merge: true });
}

async function saveGscRows(siteId: string, rows: GscRow[]) {
  if (!rows || rows.length === 0) return;

  const siteRef = db.collection('sites').doc(siteId);
  const urlsCol = siteRef.collection('urls');

  const batchSize = 200;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const batch = db.batch();

    for (const r of slice) {
      if (!r.url || !r.date) continue;
      const urlId = makeUrlId(r.url);
      const urlRef = urlsCol.doc(urlId);

      batch.set(
        urlRef,
        {
          loc: r.url,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const gscRef = urlRef.collection('gsc_daily').doc(r.date);
      batch.set(
        gscRef,
        {
          siteId,
          urlId,
          url: r.url,
          date: r.date,
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    await batch.commit();
  }
}

app.post('/ingest/sitemap', async (req: Request, res: Response) => {
  if (!requireIngestAuth(req, res)) return;
  try {
    const { siteId, sitemapUrl } = req.body || {};
    if (!siteId || !sitemapUrl) return res.status(400).json({ error: 'siteId and sitemapUrl required' });

    const { urls } = await fetchSitemap(sitemapUrl);
    await saveUrls(siteId, sitemapUrl, urls, 'sitemap');

    return res.json({ ok: true, count: urls.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'ingest_sitemap_failed' });
  }
});

app.post('/ingest/urls', async (req: Request, res: Response) => {
  if (!requireIngestAuth(req, res)) return;
  try {
    const { siteId, urls } = req.body || {};
    if (!siteId || !Array.isArray(urls)) return res.status(400).json({ error: 'siteId and urls required' });

    const map = new Map<string, { loc: string; lastmod?: string | null }>();
    for (const item of urls) {
      const loc = typeof item === 'string' ? item : item?.loc;
      if (!loc || typeof loc !== 'string') continue;
      const normalizedLoc = loc.trim();
      if (!normalizedLoc) continue;

      const lastmod =
        typeof item === 'object' && item
          ? item.lastmod !== undefined
            ? (item.lastmod ?? null)
            : undefined
          : undefined;
      map.set(normalizedLoc, { loc: normalizedLoc, lastmod });
    }

    const normalized = Array.from(map.values());
    await saveUrls(siteId, null, normalized, 'direct');

    return res.json({ ok: true, count: normalized.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'ingest_urls_failed' });
  }
});

app.post('/ingest/gsc-mock', async (req: Request, res: Response) => {
  if (!requireIngestAuth(req, res)) return;
  try {
    const { siteId, rows } = req.body || {};
    if (!siteId) return res.status(400).json({ error: 'siteId required' });

    const normalizedRows: GscRow[] = Array.isArray(rows)
      ? rows
          .map((r: any) => ({
            url: r.url,
            date: r.date,
            clicks: Number(r.clicks ?? 0),
            impressions: Number(r.impressions ?? 0),
            ctr: Number(r.ctr ?? 0),
            position: Number(r.position ?? 0),
          }))
          .filter((r) => !!r.url && !!r.date)
      : [];

    await db.collection('ingest_gsc_mock').add({
      siteId,
      rows: normalizedRows,
      createdAt: FieldValue.serverTimestamp(),
    });

    await saveGscRows(siteId, normalizedRows);

    return res.json({ ok: true, count: normalizedRows.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'ingest_gsc_mock_failed' });
  }
});

app.get('/gsc/oauth/start', async (req: Request, res: Response) => {
  if (!requireIngestAuth(req, res)) return;
  try {
    const cfg = getGscOauthConfig();
    if (!cfg) return res.status(500).json({ error: 'gsc_oauth_config_missing' });

    const state = randomBytes(24).toString('base64url');
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : null;

    await db
      .collection('integrations')
      .doc('gsc')
      .collection('oauth_states')
      .doc(state)
      .set({
        createdAtMs: Date.now(),
        returnTo: returnTo ?? null,
      });

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      scope: GSC_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    const mode = typeof req.query.mode === 'string' ? req.query.mode : 'json';
    if (mode === 'redirect') return res.redirect(url);
    return res.json({ ok: true, url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'gsc_oauth_start_failed' });
  }
});

app.get('/gsc/oauth/callback', async (req: Request, res: Response) => {
  try {
    const oauthError = typeof req.query.error === 'string' ? req.query.error : null;
    if (oauthError) return res.status(400).send(oauthError);

    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    if (!code || !state) return res.status(400).send('missing_code_or_state');

    const cfg = getGscOauthConfig();
    if (!cfg) return res.status(500).send('gsc_oauth_config_missing');

    const stateRef = db.collection('integrations').doc('gsc').collection('oauth_states').doc(state);
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists) return res.status(400).send('invalid_state');
    const createdAtMs = stateSnap.data()?.createdAtMs;
    const returnTo = stateSnap.data()?.returnTo;
    await stateRef.delete();

    if (typeof createdAtMs === 'number' && Date.now() - createdAtMs > 20 * 60 * 1000) {
      return res.status(400).send('state_expired');
    }

    const body = new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenResp = await axios.post('https://oauth2.googleapis.com/token', body.toString(), {
      timeout: 20000,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    const refreshToken = tokenResp.data?.refresh_token;
    const integrationRef = db.collection('integrations').doc('gsc');

    if (refreshToken) {
      await integrationRef.set(
        {
          refreshToken,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      const existing = await integrationRef.get();
      const existingToken = existing.data()?.refreshToken;
      if (!existingToken) return res.status(400).send('missing_refresh_token');
      await integrationRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }

    if (typeof returnTo === 'string' && returnTo) return res.redirect(returnTo);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.status(200).send('<html><body>ok</body></html>');
  } catch (err) {
    console.error(err);
    return res.status(500).send('gsc_oauth_callback_failed');
  }
});

app.get('/gsc/status', async (req: Request, res: Response) => {
  if (!requireIngestAuth(req, res)) return;
  try {
    const refreshToken = await getGscRefreshToken();
    return res.json({ ok: true, hasRefreshToken: !!refreshToken });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'gsc_status_failed' });
  }
});

app.get('/gsc/sites', async (req: Request, res: Response) => {
  if (!requireIngestAuth(req, res)) return;
  try {
    const token = await getGscAccessToken();
    const resp = await axios.get('https://www.googleapis.com/webmasters/v3/sites', {
      timeout: 20000,
      headers: { Authorization: `Bearer ${token}` },
    });

    const entries = Array.isArray(resp.data?.siteEntry) ? resp.data.siteEntry : [];
    return res.json({ ok: true, sites: entries });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'gsc_sites_failed' });
  }
});

app.post('/gsc/site', async (req: Request, res: Response) => {
  if (!requireIngestAuth(req, res)) return;
  try {
    const { siteId, gscSiteUrl } = req.body || {};
    if (!siteId || !gscSiteUrl) return res.status(400).json({ error: 'siteId and gscSiteUrl required' });
    if (typeof gscSiteUrl !== 'string') return res.status(400).json({ error: 'gscSiteUrl must be string' });

    await db
      .collection('sites')
      .doc(siteId)
      .set({ gscSiteUrl, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'gsc_site_set_failed' });
  }
});

app.post('/gsc/sync', async (req: Request, res: Response) => {
  if (!requireIngestAuth(req, res)) return;
  try {
    const { siteId } = req.body || {};
    if (!siteId) return res.status(400).json({ error: 'siteId required' });

    let gscSiteUrl = typeof req.body?.gscSiteUrl === 'string' ? req.body.gscSiteUrl : null;
    const siteRef = db.collection('sites').doc(siteId);
    if (!gscSiteUrl) {
      const snap = await siteRef.get();
      const fromDoc = snap.data()?.gscSiteUrl;
      gscSiteUrl = typeof fromDoc === 'string' ? fromDoc : null;
    }
    if (!gscSiteUrl) return res.status(400).json({ error: 'gscSiteUrl required' });

    const daysRaw = Number(req.body?.days ?? 7);
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 7;

    const endDate = isValidIsoDate(req.body?.endDate) ? req.body.endDate : toIsoDate(addDays(new Date(), -3));
    const startDate = isValidIsoDate(req.body?.startDate)
      ? req.body.startDate
      : toIsoDate(addDays(new Date(endDate), -(days - 1)));

    const type = typeof req.body?.type === 'string' ? req.body.type : 'web';
    const count = await syncGscPageDate(siteId, gscSiteUrl, startDate, endDate, type);

    await siteRef.set(
      {
        gscSiteUrl,
        gscLastSyncAt: FieldValue.serverTimestamp(),
        gscLastSyncStartDate: startDate,
        gscLastSyncEndDate: endDate,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, siteId, gscSiteUrl, startDate, endDate, count });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'gsc_sync_failed' });
  }
});

app.post('/actions/apply', async (req: Request, res: Response) => {
  if (!requireIngestAuth(req, res)) return;
  try {
    const { siteId, actionId, payload } = req.body || {};
    if (!siteId || !actionId) {
      return res.status(400).json({ error: 'siteId and actionId required' });
    }

    await db.collection('actions_apply').add({
      siteId,
      actionId,
      payload: payload ?? {},
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'apply_failed' });
  }
});

export const api = functions
  .runWith({ memory: '256MB', timeoutSeconds: 60 })
  .https.onRequest(app);
