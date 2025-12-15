 import express, { Request, Response } from 'express';
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import axios from 'axios';
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

  const batchSize = 400;
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
          source: 'sitemap-or-gsc',
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
