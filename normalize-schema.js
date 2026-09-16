/**
 * normalize-schema.js
 *
 * Reshapes EVERY entry in database.json to match your target structure:
 *
 *   {
 *     title, image, rating (decimal, e.g. 8.7), description, trailer,
 *     episodes: [{ number, title, video: "" }, ...]   // season 1, flat, for back-compat
 *     genres: ["Action", "Fantasy", ...],
 *     seasons: [
 *       { season: 1, title: "Season 1", episodes: [{ number, title }] },
 *       { season: 2, title: "Season 2", episodes: [{ number, title }] }
 *     ],
 *     imdbId: "tt1234567" | null,
 *     autoembedSlug: "demon-slayer",
 *     tmdbId: 85937 | null
 *   }
 *
 * Note the asymmetry (matches your reference example exactly): the
 * top-level `episodes` array keeps a `video` field per episode; the
 * episodes NESTED inside `seasons[].episodes` do not — your player
 * apparently streams those via tmdbId + autoembedSlug instead of a
 * per-episode pasted link.
 *
 * Every anime gets a `seasons` array, even single-season shows (as a
 * single { season: 1, ... } block), so the shape is fully consistent
 * across your whole database.
 *
 * TMDB (tmdbId / imdbId):
 *   These aren't available from AniList, so this script only fills them
 *   in if you provide a free TMDB API key. Get one at:
 *   https://www.themoviedb.org/settings/api (takes ~2 min, no cost).
 *   Then run either:
 *     TMDB_API_KEY=your_key_here node normalize-schema.js      (Mac/Linux)
 *     set TMDB_API_KEY=your_key_here && node normalize-schema.js   (Windows cmd)
 *     $env:TMDB_API_KEY="your_key_here"; node normalize-schema.js  (PowerShell)
 *   Without a key, tmdbId/imdbId are left as null — everything else
 *   (seasons, genres, rating, episodes) still gets filled in normally.
 *
 * Usage:
 *   node normalize-schema.js
 *
 * A timestamped backup of database.json is written before any changes.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.json');
const BACKUP_PATH = path.join(__dirname, `database.backup.${Date.now()}.json`);
const ANILIST_URL = 'https://graphql.anilist.co';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const DELAY_MS = 1400;
const MAX_RETRIES = 4;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function loadDb() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
function saveDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }

function slugify(str) {
  return (str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
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

const ANILIST_QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, sort: [SEARCH_MATCH]) {
    averageScore
    genres
  }
}`;

async function fetchAniListExtras(title) {
  const res = await fetchWithRetry(() => fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: title } })
  }), title);
  if (!res) return null;
  const json = await res.json();
  return json.data && json.data.Media;
}

async function fetchTmdb(title) {
  if (!TMDB_API_KEY) return { tmdbId: null, imdbId: null };
  try {
    const searchRes = await fetch(
      `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`
    );
    const searchJson = await searchRes.json();
    const best = searchJson.results && searchJson.results[0];
    if (!best) return { tmdbId: null, imdbId: null };

    const extRes = await fetch(
      `https://api.themoviedb.org/3/tv/${best.id}/external_ids?api_key=${TMDB_API_KEY}`
    );
    const extJson = await extRes.json();
    return { tmdbId: best.id, imdbId: extJson.imdb_id || null };
  } catch {
    return { tmdbId: null, imdbId: null };
  }
}

// Strips the `video` field, matching how seasons[].episodes look in your target schema
function stripVideoField(episodes) {
  return (episodes || []).map(ep => ({ number: ep.number, title: ep.title }));
}

// Adds a `video: ""` field back, for the top-level flat `episodes` (back-compat) array
function addVideoField(episodes) {
  return (episodes || []).map(ep => ({ number: ep.number, title: ep.title, video: ep.video ?? '' }));
}

async function main() {
  const db = loadDb();
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log(`Backup written to ${path.basename(BACKUP_PATH)}\n`);
  if (!TMDB_API_KEY) {
    console.log(`⚠️  No TMDB_API_KEY set — tmdbId/imdbId will be left as null for now.\n`);
  }

  for (let i = 0; i < db.length; i++) {
    const entry = db[i];
    console.log(`Normalizing: ${entry.title}`);

    // 1. Build the seasons array (wrap single-season shows too, for a consistent shape)
    let rawSeasons;
    if (entry.seasons && entry.seasons.length > 0) {
      rawSeasons = entry.seasons;
    } else {
      rawSeasons = [{ season: 1, episodes: entry.episodes || [] }];
    }
    entry.seasons = rawSeasons.map((s, idx) => ({
      season: s.season || idx + 1,
      title: s.title || `Season ${s.season || idx + 1}`,
      episodes: stripVideoField(s.episodes),
      ...(s.anigoSlug ? { anigoSlug: s.anigoSlug } : {})
    }));

    // 2. Top-level flat `episodes` mirrors season 1, WITH video field (back-compat)
    entry.episodes = addVideoField(entry.seasons[0].episodes.map((ep, idx) => {
      // preserve any video links already saved on the old flat episodes array, matched by number
      const oldMatch = (entry.episodes || []).find(o => o.number === ep.number);
      return { ...ep, video: oldMatch ? (oldMatch.video || '') : '' };
    }));

    // 3. Fill genres + precise decimal rating if missing
    if (!entry.genres || !entry.genres.length || typeof entry.rating !== 'number' || Number.isInteger(entry.rating)) {
      const extra = await fetchAniListExtras(entry.title);
      await sleep(DELAY_MS);
      if (extra) {
        if (!entry.genres || !entry.genres.length) entry.genres = extra.genres || [];
        if (extra.averageScore) entry.rating = Math.round(extra.averageScore) / 10; // e.g. 87 -> 8.7
      }
    }

    // 4. autoembedSlug — cheap, no API needed
    if (!entry.autoembedSlug) entry.autoembedSlug = slugify(entry.title);

    // 5. tmdbId / imdbId — only if a TMDB key is available
    if (TMDB_API_KEY && (!entry.tmdbId || !entry.imdbId)) {
      const tmdb = await fetchTmdb(entry.title);
      entry.tmdbId = entry.tmdbId || tmdb.tmdbId;
      entry.imdbId = entry.imdbId || tmdb.imdbId;
      await sleep(300); // TMDB's own limit is generous, light pacing is enough
    } else if (!('tmdbId' in entry)) {
      entry.tmdbId = null;
      entry.imdbId = null;
    }

    // Reorder keys to match your reference structure exactly
    db[i] = {
      title: entry.title,
      image: entry.image,
      rating: entry.rating,
      description: entry.description,
      trailer: entry.trailer,
      episodes: entry.episodes,
      genres: entry.genres || [],
      seasons: entry.seasons,
      imdbId: entry.imdbId ?? null,
      autoembedSlug: entry.autoembedSlug,
      tmdbId: entry.tmdbId ?? null,
      ...(entry.anigoSlug ? { anigoSlug: entry.anigoSlug } : {})
    };

    saveDb(db); // save incrementally so progress isn't lost on interruption
  }

  console.log(`\nDone. Normalized ${db.length} entries to the target schema.`);
  console.log(`If anything looks wrong, restore from ${path.basename(BACKUP_PATH)}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
