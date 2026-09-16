/**
 * add-anime.js
 *
 * Bulk-adds anime entries to database.json by fetching poster, rating,
 * and description from the free AniList GraphQL API (https://anilist.co),
 * no API key needed.
 *
 * Usage:
 *   node add-anime.js                  → adds the DEFAULT_TITLES list below
 *   node add-anime.js "Title 1" "T 2"  → adds only the titles you pass in
 *   node add-anime.js --file list.txt  → adds titles from a text file (one per line)
 *
 * Notes:
 *   - Skips any title already in database.json (case-insensitive match).
 *   - AniList's free tier allows ~90 requests/minute; this script paces
 *     itself well under that automatically.
 *   - Each entry gets placeholder episode slots ({number, title, video: ""})
 *     matching your existing schema, sized to the real episode count —
 *     you just need to paste video embed links in afterward. No public
 *     API provides actual streaming links, so that part stays manual.
 *   - Also auto-backfills episode placeholders for any entries already in
 *     database.json that are missing them (e.g. from an earlier run).
 *   - anigoSlug is generated from the resolved English/Romaji title —
 *     it's just a URL-safe slug, separate from your scrape-anigo.js workflow.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.json');
const ANILIST_URL = 'https://graphql.anilist.co';
const DELAY_MS = 1400; // bumped up slightly — AniList throttled us at 800ms on a long run
const MAX_RETRIES = 4;

// A solid default list of ~100 iconic / famous anime, in roughly
// most-famous-first order. Feel free to edit this list directly,
// or pass your own titles as CLI args / a --file instead.
const DEFAULT_TITLES = [
  "One Piece","Naruto","Naruto Shippuden","Death Note","Fullmetal Alchemist: Brotherhood",
  "Dragon Ball Z","Dragon Ball","Bleach","One Punch Man","Hunter x Hunter (2011)",
  "My Hero Academia","Attack on Titan","Demon Slayer: Kimetsu no Yaiba","Jujutsu Kaisen",
  "Chainsaw Man","Spy x Family","Tokyo Ghoul","Sword Art Online","Fairy Tail","Black Clover",
  "Cowboy Bebop","Neon Genesis Evangelion","Code Geass: Lelouch of the Rebellion","Steins;Gate",
  "Fullmetal Alchemist","Vinland Saga","Mob Psycho 100","Erased","Violet Evergarden",
  "Your Lie in April","Haikyuu!!","Kuroko's Basketball","Assassination Classroom",
  "The Promised Neverland","Re:Zero − Starting Life in Another World","Overlord","Konosuba",
  "That Time I Got Reincarnated as a Slime","No Game No Life","Made in Abyss","Dr. Stone",
  "Fire Force","Seven Deadly Sins","Parasyte -the maxim-","Tokyo Revengers",
  "Jojo's Bizarre Adventure","Berserk","Ghost in the Shell","Akira","Spirited Away",
  "My Neighbor Totoro","Princess Mononoke","Your Name","A Silent Voice","Weathering With You",
  "Grave of the Fireflies","Howl's Moving Castle","Perfect Blue","Paprika","Toradora!",
  "Clannad","Angel Beats!","Anohana: The Flower We Saw That Day","K-On!","Lucky Star",
  "Ouran High School Host Club","Fruits Basket","Inuyasha","Rurouni Kenshin",
  "Yu Yu Hakusho","Dragon Ball Super","Gintama","Slam Dunk","Captain Tsubasa",
  "Initial D","Great Teacher Onizuka","School Rumble","Nichijou","Mushoku Tensei",
  "The Rising of the Shield Hero","Log Horizon","Sword Art Online: Alicization",
  "Tokyo Avengers","Blue Lock","Hell's Paradise","Solo Leveling","Frieren: Beyond Journey's End",
  "Oshi no Ko","Kaguya-sama: Love is War","Horimiya","Classroom of the Elite","Kimi ga Shine",
  "Devilman Crybaby","Death Parade","Monster","Psycho-Pass","Baccano!","Durarara!!",
  "Trigun","Samurai Champloo","Serial Experiments Lain","Elfen Lied","Hellsing Ultimate",
  "Claymore","Soul Eater","D.Gray-man","Black Butler","The Seven Deadly Sins",
  "Sailor Moon","Cardcaptor Sakura","Pokemon","Digimon Adventure","Doraemon",
  "The First Slam Dunk","Kaiji","Akudama Drive","Baki","Vagabond"
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadDb() {
  if (!fs.existsSync(DB_PATH)) return [];
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function slugify(str) {
  return str.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function fetchWithRetry(fetchFn, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetchFn();
    if (res.ok) return res;

    // 429 (rate limited) or 5xx (server overloaded/down) → back off and retry
    if (res.status === 429 || res.status >= 500) {
      const backoff = DELAY_MS * attempt * 2;
      if (attempt < MAX_RETRIES) {
        console.log(`   ↻ HTTP ${res.status} for "${label}", retrying in ${(backoff/1000).toFixed(1)}s (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(backoff);
        continue;
      }
    }
    let detail = '';
    try { const body = await res.json(); detail = JSON.stringify(body.errors || body); } catch {}
    throw new Error(`AniList HTTP ${res.status} for "${label}" (after ${attempt} attempt(s))${detail ? ' — ' + detail : ''}`);
  }
}

const ANILIST_QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, sort: [SEARCH_MATCH]) {
    title { romaji english }
    coverImage { extraLarge large }
    averageScore
    description(asHtml: false)
    episodes
    trailer { id site }
    siteUrl
  }
}`;

async function fetchAnimeData(title) {
  const res = await fetchWithRetry(() => fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: title } })
  }), title);

  const json = await res.json();
  const result = json.data && json.data.Media;
  if (!result) return null;

  const resolvedTitle = result.title.english || result.title.romaji;
  const trailerUrl = (result.trailer && result.trailer.site === 'youtube')
    ? `https://www.youtube.com/embed/${result.trailer.id}`
    : '';

  const totalEpisodes = result.episodes || null;
  const episodes = buildEpisodePlaceholders(totalEpisodes);

  return {
    title: resolvedTitle,
    image: (result.coverImage && (result.coverImage.extraLarge || result.coverImage.large)) || '',
    rating: result.averageScore ? Math.round(result.averageScore / 10) : null, // AniList is 0-100, convert to 0-10
    description: (result.description || '').replace(/<[^>]+>/g, '').split('\n')[0].slice(0, 500) || 'No description available.',
    trailer: trailerUrl,
    anigoSlug: slugify(resolvedTitle),
    totalEpisodes,
    episodes
  };
}

function buildEpisodePlaceholders(count) {
  const n = count || 12;
  return Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    title: `Episode ${i + 1}`,
    video: ''
  }));
}

async function main() {
  const args = process.argv.slice(2);
  let titles = DEFAULT_TITLES;

  if (args[0] === '--file' && args[1]) {
    titles = fs.readFileSync(args[1], 'utf8').split('\n').map(t => t.trim()).filter(Boolean);
  } else if (args.length > 0) {
    titles = args;
  }

  const db = loadDb();

  // Backfill: any entry already in database.json with an empty episodes
  // array (e.g. from an earlier run of this script) gets placeholder
  // episode slots built from its saved totalEpisodes — no API calls needed.
  let backfilled = 0;
  for (const entry of db) {
    if ((!entry.episodes || entry.episodes.length === 0)) {
      entry.episodes = buildEpisodePlaceholders(entry.totalEpisodes);
      backfilled++;
    }
  }
  if (backfilled > 0) {
    saveDb(db);
    console.log(`Backfilled episode placeholders for ${backfilled} existing entries.\n`);
  }

  const existingTitles = new Set(db.map(a => (a.title || '').toLowerCase().trim()));

  console.log(`Starting: ${titles.length} titles requested, ${db.length} already in database.json\n`);

  let added = 0, skipped = 0, failed = 0;

  for (const title of titles) {
    if (existingTitles.has(title.toLowerCase().trim())) {
      console.log(`⏭️  Skipping (already exists): ${title}`);
      skipped++;
      continue;
    }

    try {
      const data = await fetchAnimeData(title);
      if (!data) {
        console.log(`⚠️  Not found on Jikan: ${title}`);
        failed++;
      } else if (existingTitles.has(data.title.toLowerCase().trim())) {
        console.log(`⏭️  Skipping (resolved title already exists): ${data.title}`);
        skipped++;
      } else {
        db.push(data);
        existingTitles.add(data.title.toLowerCase().trim());
        saveDb(db); // save immediately so progress isn't lost if it crashes/gets interrupted later
        console.log(`✅ Added: ${data.title} (rating: ${data.rating ?? 'N/A'})`);
        added++;
      }
    } catch (err) {
      console.log(`❌ Error fetching "${title}": ${err.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nDone. Added ${added}, skipped ${skipped}, failed ${failed}. database.json now has ${db.length} entries.`);
  if (failed > 0) console.log(`Tip: just run "node add-anime.js" again — it'll skip everything already added and only retry the ones that failed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
