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

function makeUrlId(loc: string): string {
  return Buffer.from(loc).toString('base64url');
}

async function fetchSitemap(url: string, depth = 0): Promise<{ urls: { loc: string; lastmod?: string | null }[] }> {
  if (depth > MAX_SITEMAP_DEPTH) return { urls: [] };
  const resp = await axios.get(url, { timeout: 15000 });
  const parsed: unknown = parser.parse(resp.data);

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
  return { type: 'urlset', urls: [] };
}

async function saveUrls(siteId: string, sitemapUrl: string | null, urls: { loc: string; lastmod?: string | null }[]) {
  const siteRef = db.collection('sites').doc(siteId);
  const urlsCol = siteRef.collection('urls');

  const batchSize = 400;
  for (let i = 0; i < urls.length; i += batchSize) {
    const slice = urls.slice(i, i + batchSize);
    const batch = db.batch();
    for (const u of slice) {
      const docId = makeUrlId(u.loc);
      batch.set(urlsCol.doc(docId), {
        loc: u.loc,
        lastmod: u.lastmod ?? null,
        source: 'sitemap',
        sitemapUrl: sitemapUrl ?? null,
        fetchedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }

  await siteRef.set(
    {
      sitemapUrl: sitemapUrl ?? null,
      urlCount: urls.length,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

app.post('/ingest/sitemap', async (req: Request, res: Response) => {
  try {
    const { siteId, sitemapUrl } = req.body || {};
    if (!siteId || !sitemapUrl) return res.status(400).json({ error: 'siteId and sitemapUrl required' });

    const { urls } = await fetchSitemap(sitemapUrl);
    await saveUrls(siteId, sitemapUrl, urls);

    return res.json({ ok: true, count: urls.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'ingest_sitemap_failed' });
  }
});

app.post('/ingest/gsc-mock', async (req: Request, res: Response) => {
  try {
    const { siteId, rows } = req.body || {};
    if (!siteId) return res.status(400).json({ error: 'siteId required' });

    await db.collection('ingest_gsc_mock').add({
      siteId,
      rows: rows ?? [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'ingest_gsc_mock_failed' });
  }
});

app.post('/actions/apply', async (req: Request, res: Response) => {
  try {
    const { siteId, actionId, payload } = req.body || {};
    if (!siteId || !actionId) {
      return res.status(400).json({ error: 'siteId and actionId required' });
    }

    await db.collection('actions_apply').add({
      siteId,
      actionId,
      payload: payload ?? {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
