/**
 * build-seasons.js  (v2 — auto-discovers missing seasons, not just merges duplicates)
 *
 * For every entry in database.json, this finds its FULL season chain on
 * AniList (via SEQUEL/PREQUEL relations, TV format only) and builds a
 * real seasons structure:
 *
 *   { title, image, rating, description, ..., seasons: [
 *       { season: 1, episodes: [...] },
 *       { season: 2, episodes: [...] }
 *   ]}
 *
 * Unlike v1, this does NOT require every season to already exist as its
 * own row in database.json. If your database only has "Tokyo Revengers"
 * (season 1) and not its season 2, this script fetches season 2 directly
 * from AniList and adds it as a new season block — with placeholder
 * episode slots for you to fill video links into, same as add-anime.js.
 *
 * If a later season DOES already exist as its own row (like your Naruto /
 * Naruto: Shippuden case), it's merged in using its EXISTING episodes
 * (so any video links you already added aren't lost), and the now-
 * redundant duplicate row is removed — same behavior as before.
 *
 * Usage:
 *   node build-seasons.js
 *
 * Safe to run multiple times — entries that already have a `seasons`
 * array are skipped. A backup of database.json is written first.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.json');
const BACKUP_PATH = path.join(__dirname, `database.backup.${Date.now()}.json`);
const ANILIST_URL = 'https://graphql.anilist.co';
const DELAY_MS = 1400;
const MAX_RETRIES = 4;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function loadDb() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
function saveDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }
function normTitle(t) { return (t || '').toLowerCase().trim(); }

function buildEpisodePlaceholders(count) {
  const n = count || 12;
  return Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Episode ${i + 1}`, video: '' }));
}

async function fetchWithRetry(fetchFn, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetchFn();
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      const backoff = DELAY_MS * attempt * 2;
      if (attempt < MAX_RETRIES) {
        console.log(`   ↻ HTTP ${res.status} for "${label}", retrying in ${(backoff/1000).toFixed(1)}s...`);
        await sleep(backoff);
        continue;
      }
    }
    return null;
  }
}

const MEDIA_QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, sort: [SEARCH_MATCH]) {
    id
    format
    episodes
    title { romaji english }
    relations {
      edges {
        relationType
        node { id title { romaji english } format episodes }
      }
    }
  }
}`;

async function fetchMedia(searchTitle) {
  const res = await fetchWithRetry(() => fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: MEDIA_QUERY, variables: { search: searchTitle } })
  }), searchTitle);
  if (!res) return null;
  const json = await res.json();
  return json.data && json.data.Media;
}

function pickTitle(t) { return t.english || t.romaji; }

async function main() {
  const db = loadDb();
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log(`Backup written to ${path.basename(BACKUP_PATH)}\n`);

  const byTitle = new Map();
  db.forEach((entry, idx) => byTitle.set(normTitle(entry.title), idx));

  const mergedAway = new Set(); // db indices absorbed into another entry's seasons
  let seasonsBuilt = 0, seasonsFetchedFresh = 0;

  for (let i = 0; i < db.length; i++) {
    const entry = db[i];
    if (mergedAway.has(i)) continue;
    if (entry.seasons && entry.seasons.length > 1) continue; // already processed

    console.log(`Checking: ${entry.title}`);
    const media = await fetchMedia(entry.title);
    await sleep(DELAY_MS);
    if (!media) { console.log(`   ⚠️  Not found on AniList, skipping`); continue; }

    // If this entry itself has a TV PREQUEL, it's a later season, not season 1 —
    // skip it here; it'll be picked up when we process its season-1 entry.
    const hasTvPrequel = (media.relations?.edges || []).some(
      e => e.relationType === 'PREQUEL' && e.node.format === 'TV'
    );
    if (hasTvPrequel) continue;

    // Walk forward through TV-format SEQUEL relations to build the full chain
    const chainTitles = [pickTitle(media.title)];
    const chainEpisodeSources = [{ dbIdx: i, aniEpisodes: media.episodes }];
    let currentEdges = media.relations?.edges || [];
    let guard = 0;

    while (guard++ < 15) { // safety cap against any relation loops
      const seq = currentEdges.find(e => e.relationType === 'SEQUEL' && e.node.format === 'TV');
      if (!seq) break;

      const seqTitle = normTitle(pickTitle(seq.node.title));
      const existingIdx = byTitle.get(seqTitle);

      if (existingIdx !== undefined) {
        // This season already exists as its own row — reuse its episodes
        // (preserves any video links already filled in) and remove the duplicate row later
        chainTitles.push(pickTitle(seq.node.title));
        chainEpisodeSources.push({ dbIdx: existingIdx, aniEpisodes: seq.node.episodes });
        mergedAway.add(existingIdx);
        // fetch ITS relations to keep walking the chain forward
        const nextMedia = await fetchMedia(seqTitle);
        await sleep(DELAY_MS);
        currentEdges = nextMedia?.relations?.edges || [];
      } else {
        // Season not in our database at all — fetch it fresh from AniList
        console.log(`   ➕ Found missing season not in database: ${pickTitle(seq.node.title)}`);
        chainTitles.push(pickTitle(seq.node.title));
        chainEpisodeSources.push({ dbIdx: null, aniEpisodes: seq.node.episodes });
        seasonsFetchedFresh++;
        const nextMedia = await fetchMedia(seqTitle);
        await sleep(DELAY_MS);
        currentEdges = nextMedia?.relations?.edges || [];
      }
    }

    if (chainTitles.length < 2) continue; // truly a single-season show, leave as-is

    entry.seasons = chainEpisodeSources.map((src, n) => ({
      season: n + 1,
      episodes: src.dbIdx !== null
        ? (db[src.dbIdx].episodes && db[src.dbIdx].episodes.length ? db[src.dbIdx].episodes : buildEpisodePlaceholders(src.aniEpisodes))
        : buildEpisodePlaceholders(src.aniEpisodes)
    }));
    entry.episodes = entry.seasons[0].episodes;
    delete entry.totalEpisodes;

    console.log(`✅ Built ${entry.seasons.length} seasons for: ${entry.title}`);
    seasonsBuilt++;
  }

  const finalDb = db.filter((_, idx) => !mergedAway.has(idx));
  saveDb(finalDb);

  console.log(`\nDone. Built seasons for ${seasonsBuilt} anime (${seasonsFetchedFresh} seasons fetched fresh from AniList that weren't in your database before).`);
  console.log(`Removed ${mergedAway.size} now-redundant duplicate rows. database.json now has ${finalDb.length} entries (was ${db.length}).`);
  console.log(`If anything looks wrong, restore from ${path.basename(BACKUP_PATH)}.`);
}

main().catch(err => { console.error(err); process.exit(1); });

