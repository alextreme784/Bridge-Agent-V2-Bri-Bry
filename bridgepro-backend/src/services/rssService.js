'use strict';

const db = require('../db');

async function fetchFeed(feedUrl) {
  const res = await fetch(feedUrl, { 
    headers: { 'User-Agent': 'BridgeNews/1.0' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + feedUrl);
  const xml = await res.text();
  // Parse XML
  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const item = match[1];
    const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/)?.[1] || item.match(/<title>(.*?)<\/title>/)?.[1] || '';
    const link = item.match(/<link>(.*?)<\/link>/)?.[1] || item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] || '';
    const desc = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/)?.[1] || '';
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
    const enclosure = item.match(/<enclosure[^>]*url=["'](.*?)["']/)?.[1] || null;
    if (title && link) {
      items.push({
        title: title.trim(),
        url: link.trim(),
        excerpt: desc.replace(/<[^>]*>/g, '').slice(0, 200).trim(),
        image_url: enclosure,
        published_at: pubDate ? new Date(pubDate) : new Date()
      });
    }
  }
  return items;
}

/* ─── Refresh one feed into DB ──────────────────────────────── */
async function refreshFeed(feed) {
  try {
    const articles = await fetchFeed(feed.url);
    let inserted = 0;
    for (const article of articles) {
      try {
        await db.query(
          'INSERT INTO rss_articles (feed_id, title, url, excerpt, image_url, published_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, excerpt = COALESCE(EXCLUDED.excerpt, rss_articles.excerpt), image_url = COALESCE(EXCLUDED.image_url, rss_articles.image_url), fetched_at = NOW()',
          [feed.id, article.title, article.url, article.excerpt, article.image_url, article.published_at]
        );
        inserted++;
      } catch (_) { }
    }
    await db.query('UPDATE rss_feeds SET last_fetched = NOW() WHERE id = $1', [feed.id]);
    console.log('[rssService] ' + feed.name + ': fetched ' + articles.length + ', upserted ' + inserted);
    return inserted;
  } catch (e) {
    console.error('[rssService] Error fetching ' + feed.name + ':', e.message);
    return 0;
  }
}

/* ─── Refresh all active feeds (staggered to be polite) ─────── */
async function refreshAllFeeds() {
  const { rows: feeds } = await db.query(
    'SELECT * FROM rss_feeds WHERE is_active = true ORDER BY id'
  );
  let total = 0;
  for (const feed of feeds) {
    try {
      total += await refreshFeed(feed);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error('[rssService] Error refreshing ' + feed.name + ':', e.message);
    }
  }
  console.log('[rssService] Cycle complete — ' + total + ' articles upserted across ' + feeds.length + ' feeds');
}

setTimeout(refreshAllFeeds, 5000);
setInterval(refreshAllFeeds, 6 * 60 * 60 * 1000);

module.exports = { fetchFeed, refreshFeed, refreshAllFeeds };