const http = require('http');
const https = require('https');

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

let cache = { updatedAt: null, matchday: null, leagues: [], totalMatches: 0 };
let isScraping = false;

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.5',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseMatches(html) {
  const matches = [];
  let matchday = null;

  const mdMatch = html.match(/Matchday\s*<[^>]*>(\d+)|Matchday\s+(\d+)/i);
  if (mdMatch) matchday = mdMatch[1] || mdMatch[2];

  const lines = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .split(/[\n\r]+/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Z]{2,4}\s*[-]\s*[A-Z]{2,4}$/.test(line)) {
      const name = line.trim();
      const chunk = lines.slice(i + 1, i + 10).join(' ');
      const nums = chunk.match(/\b\d+\.\d{2}\b/g);
      if (nums && nums.length >= 3) {
        const h = parseFloat(nums[0]);
        const d = parseFloat(nums[1]);
        const a = parseFloat(nums[2]);
        if (h >= 1.01 && h <= 30 && d >= 1.01 && d <= 30 && a >= 1.01 && a <= 30) {
          matches.push({ match: name, home: h, draw: d, away: a });
        }
      }
    }
  }

  return { matchday, matches };
}

async function runScrape() {
  if (isScraping) return;
  isScraping = true;
  console.log(`[${new Date().toISOString()}] Scraping...`);

  let matchday = null;
  const leagues = [];

  for (const league of LEAGUES) {
    try {
      const url = `https://www.betpawa.mw/virtual-sports?virtualTab=upcoming&leagueId=${league.id}`;
      const html = await fetchPage(url);
      const { matchday: md, matches } = parseMatches(html);
      if (md && !matchday) matchday = md;
      leagues.push({ league: league.name, matchday: md, matches });
      console.log(`  ✓ ${league.name}: ${matches.length} matches`);
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

  console.log(`Done. ${cache.totalMatches} total matches cached.`);
  isScraping = false;
}

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

function isStale() {
  if (!cache.updatedAt) return true;
  return Date.now() - new Date(cache.updatedAt).getTime() > 4 * 60 * 1000;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  const url = req.url.split('?')[0];

  if (url === '/health') {
    return res.end(JSON.stringify({ status: 'ok', updatedAt: cache.updatedAt, stale: isStale(), totalMatches: cache.totalMatches, matchday: cache.matchday }));
  }

  if (url === '/refresh') {
    runScrape().then(() => res.end(JSON.stringify({ status: 'refreshed', updatedAt: cache.updatedAt, totalMatches: cache.totalMatches })));
    return;
  }

  if (url === '/odds') return res.end(JSON.stringify(cache));

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
      updatedAt: cache.updatedAt, matchday: cache.matchday, total: allPicks.length,
      strong: allPicks.filter(p => p.confidence === 'strong'),
      moderate: allPicks.filter(p => p.confidence === 'moderate'),
    }));
  }

  if (url.startsWith('/picks/')) {
    const query = url.replace('/picks/', '').toLowerCase();
    const league = cache.leagues.find(l => l.league.toLowerCase().includes(query));
    if (!league) return res.end(JSON.stringify({ error: 'League not found' }));
    const picks = league.matches.map(analyze).filter(m => m.score >= 3).sort((a, b) => b.score - a.score);
    return res.end(JSON.stringify({ updatedAt: cache.updatedAt, matchday: cache.matchday, league: league.league, picks, all: league.matches.map(analyze) }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Try /health /odds /picks /picks/english' }));
});

server.listen(PORT, () => console.log(`Server on port ${PORT}`));
runScrape();
setInterval(runScrape, 4 * 60 * 1000);
