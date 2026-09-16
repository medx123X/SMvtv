/**
 * build-seasons.js
 *
 * Looks at every entry in database.json, checks AniList for sequel/prequel
 * relations, and merges entries that belong to the same franchise (e.g.
 * "Naruto" + "Naruto: Shippuden", or "Dragon Ball" + "Dragon Ball Z" +
 * "Dragon Ball Super") into ONE entry with a real seasons structure:
 *
 *   { title, image, rating, description, ..., seasons: [
 *       { season: 1, episodes: [...] },
 *       { season: 2, episodes: [...] }
 *   ]}
 *
 * This matches exactly what public/show.html and public/watch.html already
 * expect (they check `anime.seasons` and fall back to flat `anime.episodes`
 * when there's only one season).
 *
 * Usage:
 *   node build-seasons.js
 *
 * Safe to run multiple times — already-merged entries are left alone, and
 * a backup of database.json is written before any changes are saved.
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
    return null; // give up quietly on real errors — not every title needs to resolve
  }
}

const RELATIONS_QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, sort: [SEARCH_MATCH]) {
    id
    format
    title { romaji english }
    relations {
      edges {
        relationType
        node { id title { romaji english } format }
      }
    }
  }
}`;

async function fetchRelations(title) {
  const res = await fetchWithRetry(() => fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: RELATIONS_QUERY, variables: { search: title } })
  }), title);
  if (!res) return null;
  const json = await res.json();
  return json.data && json.data.Media;
}

function normTitle(t) { return (t || '').toLowerCase().trim(); }

async function main() {
  const db = loadDb();
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(db, null, 2), 'utf8');
  console.log(`Backup written to ${path.basename(BACKUP_PATH)}\n`);

  // Build a lookup of every entry already in database.json, by normalized title
  const byTitle = new Map();
  db.forEach((entry, idx) => byTitle.set(normTitle(entry.title), idx));

  // For each entry, fetch its AniList sequel/prequel relations and try to
  // match those related titles back to OTHER entries already in database.json
  const nextOf = new Map(); // dbIndex -> dbIndex (this entry's sequel, if also in our db)
  const prevOf = new Map(); // dbIndex -> dbIndex (this entry's prequel, if also in our db)

  for (let i = 0; i < db.length; i++) {
    const entry = db[i];
    console.log(`Checking relations for: ${entry.title}`);
    const media = await fetchRelations(entry.title);
    await sleep(DELAY_MS);
    if (!media || !media.relations) continue;

    for (const edge of media.relations.edges) {
      if (edge.node.format !== 'TV') continue; // only chain TV seasons, skip movies/OVAs/specials
      const relTitle = normTitle(edge.node.title.english || edge.node.title.romaji);
      const relIdx = byTitle.get(relTitle);
      if (relIdx === undefined || relIdx === i) continue;

      if (edge.relationType === 'SEQUEL') nextOf.set(i, relIdx);
      if (edge.relationType === 'PREQUEL') prevOf.set(i, relIdx);
    }
  }

  // Walk each chain back to its season-1 entry, then forward to build the
  // full ordered season list. Track visited indices so we don't process a
  // chain more than once.
  const visited = new Set();
  const mergedIndices = new Set(); // indices that got absorbed into another entry, to delete later
  let seasonsBuilt = 0;

  for (let i = 0; i < db.length; i++) {
    if (visited.has(i)) continue;
    if (!nextOf.has(i) && !prevOf.has(i)) { visited.add(i); continue; } // standalone, no chain

    // walk back to season 1
    let start = i;
    while (prevOf.has(start) && !visited.has(start)) start = prevOf.get(start);

    // walk forward from season 1, collecting the chain
    const chain = [start];
    visited.add(start);
    let cur = start;
    while (nextOf.has(cur) && !visited.has(nextOf.get(cur))) {
      cur = nextOf.get(cur);
      chain.push(cur);
      visited.add(cur);
    }

    if (chain.length < 2) continue; // no real multi-season merge needed

    const seasonEntry = db[chain[0]];
    seasonEntry.seasons = chain.map((idx, n) => ({
      season: n + 1,
      episodes: db[idx].episodes || []
    }));
    // Keep top-level episodes as season 1's, for any code path that doesn't check `seasons`
    seasonEntry.episodes = seasonEntry.seasons[0].episodes;
    delete seasonEntry.totalEpisodes;

    for (let n = 1; n < chain.length; n++) mergedIndices.add(chain[n]);

    console.log(`✅ Merged ${chain.length} seasons into: ${seasonEntry.title}`);
    seasonsBuilt++;
  }

  const finalDb = db.filter((_, idx) => !mergedIndices.has(idx));
  saveDb(finalDb);

  console.log(`\nDone. Built seasons for ${seasonsBuilt} franchise(s). Removed ${mergedIndices.size} now-merged duplicate entries.`);
  console.log(`database.json now has ${finalDb.length} entries (was ${db.length}).`);
  console.log(`If anything looks wrong, restore from ${path.basename(BACKUP_PATH)}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
