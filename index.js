const { chromium } = require('playwright');
const http = require('http');

const PORT = process.env.PORT || 3000;

const LEAGUES = [
  { id: '7794', name: 'English League' },
  { id: '7795', name: 'Spanish League' },
  { id: '7796', name: 'Italian League' },
  { id: '9184', name: 'German League' },
  { id: '9183', name: 'French League' },
  { id: '13774', name: 'Dutch League' },
  { id: '13773', name: 'Portuguese League' },
];

// ─── CACHE ────────────────────────────────────────────────────
let cache = { updatedAt: null, matchday: null, leagues: [], totalMatches: 0 };
let isScraping = false;

// ─── SCRAPER ──────────────────────────────────────────────────
async function scrapeLeague(page, leagueId, leagueName) {
  await page.goto(
    `https://www.betpawa.mw/virtual-sports?virtualTab=upcoming&leagueId=${leagueId}`,
    { waitUntil: 'networkidle', timeout: 30000 }
  );

  await page.waitForTimeout(2000);

  const data = await page.evaluate(() => {
    const results = [];
    const text = document.body.innerText;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // Extract matchday
    let matchday = null;
    for (const line of lines) {
      const md = line.match(/Matchday\s+(\d+)/i);
      if (md) { matchday = md[1]; break; }
    }

    // Parse match rows: "ARS - MUN" then numbers like "1.84 4.00 4.00"
    for (let i = 0; i < lines.length; i++) {
      if (/^[A-Z]{2,4}\s*[-–]\s*[A-Z]{2,4}$/.test(lines[i])) {
        const name = lines[i].replace('–', '-').replace(/\s+/g, ' ').trim();
        const chunk = lines.slice(i + 1, i + 8).join(' ');
        const nums = chunk.match(/\d+\.\d{2}/g);
        if (nums && nums.length >= 3) {
          results.push({
            match: name,
            home: parseFloat(nums[0]),
            draw: parseFloat(nums[1]),
            away: parseFloat(nums[2]),
          });
        }
      }
    }
    return { matchday, results };
  });

  return { league: leagueName, matchday: data.matchday, matches: data.results };
}

async function runScrape() {
  if (isScraping) return;
  isScraping = true;
  console.log(`[${new Date().toISOString()}] Scraping...`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
      viewport: { width: 390, height: 844 },
    });

    const page = await context.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort());

    let matchday = null;
    const leagues = [];

    for (const league of LEAGUES) {
      try {
        const result = await scrapeLeague(page, league.id, league.name);
        if (result.matchday && !matchday) matchday = result.matchday;
        leagues.push(result);
        console.log(`  ✓ ${league.name}: ${result.matches.length} matches`);
      } catch (err) {
        console.error(`  ✗ ${league.name}: ${err.message}`);
        leagues.push({ league: league.name, matchday: null, matches: [] });
      }
    }

    cache = {
      updatedAt: new Date().toISOString(),
      matchday,
      leagues,
      totalMatches: leagues.reduce((s, l) => s + l.matches.length, 0),
    };

    console.log(`Done. ${cache.totalMatches} matches cached.`);
  } catch (err) {
    console.error('Scrape error:', err.message);
  } finally {
    if (browser) await browser.close();
    isScraping = false;
  }
}

// ─── MODEL ────────────────────────────────────────────────────
function analyze(match) {
  const { home: h, draw: d, away: a } = match;
  const ov = 1/h + 1/d + 1/a;
  const mg = (ov - 1) / 3;
  const pH = 1/h - mg;
  const pA = 1/a - mg;
  const favOdds = pH > pA ? h : a;
  const balance = 1 - Math.abs(pH - pA);
  const fav = Math.max(pH, pA);
  const und = Math.min(pH, pA);
  const xgH = +(fav * 2.6 + und * 0.7).toFixed(2);
  const xgA = +(und * 1.9 + fav * 0.5).toFixed(2);
  const totalXg = +(xgH + xgA).toFixed(2);

  let sig = 0;
  if (favOdds >= 1.33 && favOdds <= 2.20) sig += 2;
  else if (favOdds > 2.20 && favOdds <= 2.70) sig += 1;
  if (d >= 3.40 && d <= 4.80) sig += 1;
  if (balance > 0.50) sig += 1;
  if (totalXg > 2.7) sig += 1;

  let signal, confidence, reason;
  if (sig >= 4) {
    signal = 'OVER 2.5'; confidence = 'strong';
    reason = 'Tight favourite + open draw';
  } else if (sig === 3) {
    signal = 'LEAN OVER'; confidence = 'moderate';
    reason = 'Moderate signal';
  } else {
    signal = 'AVOID'; confidence = 'low';
    reason = 'Weak structure';
  }

  return { ...match, xgH, xgA, totalXg, signal, confidence, reason, score: sig };
}

// ─── SERVER ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url = req.url.split('?')[0];

  // GET /health
  if (url === '/health') {
    return res.end(JSON.stringify({
      status: 'ok',
      updatedAt: cache.updatedAt,
      stale: isStale(),
      totalMatches: cache.totalMatches,
      matchday: cache.matchday,
    }));
  }

  // GET /refresh
  if (url === '/refresh') {
    runScrape().then(() => {
      res.end(JSON.stringify({ status: 'refreshed', updatedAt: cache.updatedAt, totalMatches: cache.totalMatches }));
    });
    return;
  }

  // GET /odds
  if (url === '/odds') {
    return res.end(JSON.stringify(cache));
  }

  // GET /picks
  if (url === '/picks') {
    const allPicks = [];
    cache.leagues.forEach(league => {
      league.matches.forEach(m => {
        const r = analyze(m);
        if (r.score >= 3) allPicks.push({ ...r, league: league.league });
      });
    });
    allPicks.sort((a, b) => b.score - a.score);
    return res.end(JSON.stringify({
      updatedAt: cache.updatedAt,
      matchday: cache.matchday,
      total: allPicks.length,
      strong: allPicks.filter(p => p.confidence === 'strong'),
      moderate: allPicks.filter(p => p.confidence === 'moderate'),
    }));
  }

  // GET /picks/english etc.
  if (url.startsWith('/picks/')) {
    const query = url.replace('/picks/', '').toLowerCase();
    const league = cache.leagues.find(l => l.league.toLowerCase().includes(query));
    if (!league) return res.end(JSON.stringify({ error: 'League not found' }));
    const picks = league.matches.map(analyze).filter(m => m.score >= 3).sort((a,b) => b.score - a.score);
    return res.end(JSON.stringify({ updatedAt: cache.updatedAt, matchday: cache.matchday, league: league.league, picks }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found. Try /health /odds /picks /picks/english' }));
});

function isStale() {
  if (!cache.updatedAt) return true;
  return Date.now() - new Date(cache.updatedAt).getTime() > 4 * 60 * 1000;
}

// Start
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
runScrape();
setInterval(runScrape, 4 * 60 * 1000);
