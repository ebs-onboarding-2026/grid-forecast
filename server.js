// 격자예보 — 기상청 단기예보 조회서비스(VilageFcstInfoService_2.0) 프록시 + 정적 서버
// 의존성 없음. node server.js 로 실행.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const SERVICE_KEY = readServiceKey();

// ---------------------------------------------------------------- 키 읽기

function readServiceKey() {
  if (process.env.KMA_SERVICE_KEY) return process.env.KMA_SERVICE_KEY.trim();
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const hit = env.match(/^KMA_SERVICE_KEY\s*=\s*(.+)$/m);
    if (hit) return hit[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* .env 없으면 무시 */ }
  return null;
}

// 포털이 주는 키는 인코딩본/디코딩본 두 가지다. %가 있으면 이미 인코딩된 것으로 본다.
function encodedKey() {
  return SERVICE_KEY.includes('%') ? SERVICE_KEY : encodeURIComponent(SERVICE_KEY);
}

// ---------------------------------------------------------------- 시각 계산

const KST = 9 * 60 * 60 * 1000;

function kstNow() {
  return new Date(Date.now() + KST); // getUTC* 로 읽으면 KST 벽시계가 된다
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

function shiftHours(d, h) {
  return new Date(d.getTime() + h * 3600 * 1000);
}

// 초단기실황: 매시 발표, 40분 이후 제공
function ncstBase(now) {
  const d = now.getUTCMinutes() < 40 ? shiftHours(now, -1) : now;
  return { base_date: ymd(d), base_time: `${pad(d.getUTCHours())}00` };
}

// 초단기예보: 매시 30분 발표, 45분 이후 제공
function ultraFcstBase(now) {
  const d = now.getUTCMinutes() < 45 ? shiftHours(now, -1) : now;
  return { base_date: ymd(d), base_time: `${pad(d.getUTCHours())}30` };
}

// 단기예보: 02·05·08·11·14·17·20·23시 발표, 10분 이후 제공
const VILAGE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];

function vilageBase(now) {
  let d = now;
  for (let back = 0; back < 30; back++) {
    const probe = shiftHours(now, -back);
    const h = probe.getUTCHours();
    if (!VILAGE_HOURS.includes(h)) continue;
    // 같은 시각이면 10분은 지나야 자료가 올라온다
    if (back === 0 && now.getUTCMinutes() < 10) continue;
    d = probe;
    return { base_date: ymd(d), base_time: `${pad(h)}00` };
  }
  const y = shiftHours(now, -24);
  return { base_date: ymd(y), base_time: '2300' };
}

// ---------------------------------------------------------------- API 호출

async function callKma(op, params) {
  const qs = new URLSearchParams({ dataType: 'JSON', pageNo: '1', ...params });
  const url = `${BASE}/${op}?serviceKey=${encodedKey()}&${qs}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 인증 실패 등은 XML 에러 문서로 돌아온다
    const msg = text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/)?.[1]
      || text.match(/<errMsg>(.*?)<\/errMsg>/)?.[1]
      || '기상청 응답을 해석하지 못했습니다';
    throw new Error(`${op}: ${msg}`);
  }

  const header = json.response?.header;
  if (header && header.resultCode !== '00' && header.resultCode !== '0') {
    throw new Error(`${op}: ${header.resultMsg} (${header.resultCode})`);
  }
  return json.response?.body?.items?.item ?? [];
}

// ---------------------------------------------------------------- 예보 병합

// 시간별 슬롯 하나로 합친다. 정확도 순서: 초단기실황 > 초단기예보 > 단기예보
function mergeForecast({ ncst, ultra, vilage }) {
  const hours = new Map(); // "YYYYMMDDHH00" -> { ...values }
  const daily = new Map(); // "YYYYMMDD" -> { tmn, tmx }

  const slot = (date, time) => {
    const key = `${date}${time.slice(0, 2)}00`;
    if (!hours.has(key)) hours.set(key, { date, hour: Number(time.slice(0, 2)), key });
    return hours.get(key);
  };

  // 1) 단기예보 — 최대 5일치 바탕
  for (const it of vilage) {
    const v = it.fcstValue;
    const s = slot(it.fcstDate, it.fcstTime);
    switch (it.category) {
      case 'TMP': s.temp = num(v); break;
      case 'POP': s.pop = num(v); break;
      case 'PTY': s.pty = num(v); break;
      case 'SKY': s.sky = num(v); break;
      case 'REH': s.humidity = num(v); break;
      case 'WSD': s.wind = num(v); break;
      case 'VEC': s.windDir = num(v); break;
      case 'PCP': s.rain = v; break;
      case 'SNO': s.snow = v; break;
      case 'TMN': setDaily(daily, it.fcstDate, 'tmn', num(v)); break;
      case 'TMX': setDaily(daily, it.fcstDate, 'tmx', num(v)); break;
    }
  }

  // 2) 초단기예보 — 앞 6시간을 덮어쓴다
  for (const it of ultra) {
    const v = it.fcstValue;
    const s = slot(it.fcstDate, it.fcstTime);
    s.nowcast = true;
    switch (it.category) {
      case 'T1H': s.temp = num(v); break;
      case 'SKY': s.sky = num(v); break;
      case 'PTY': s.pty = num(v); break;
      case 'POP': s.pop = num(v); break;
      case 'REH': s.humidity = num(v); break;
      case 'WSD': s.wind = num(v); break;
      case 'VEC': s.windDir = num(v); break;
      case 'RN1': s.rain = v; break;
      case 'LGT': s.lightning = num(v); break;
    }
  }

  // 3) 초단기실황 — 지금
  const observed = {};
  for (const it of ncst) {
    const v = num(it.obsrValue);
    switch (it.category) {
      case 'T1H': observed.temp = v; break;
      case 'RN1': observed.rain = it.obsrValue; break;
      case 'REH': observed.humidity = v; break;
      case 'PTY': observed.pty = v; break;
      case 'WSD': observed.wind = v; break;
      case 'VEC': observed.windDir = v; break;
    }
    observed.baseDate = it.baseDate;
    observed.baseTime = it.baseTime;
  }

  const series = [...hours.values()]
    .filter((s) => s.temp !== undefined)
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  // 실황에는 하늘상태가 없다. 가장 가까운 예보 슬롯에서 빌려온다.
  if (observed.temp !== undefined && series.length) {
    observed.sky = series[0].sky;
  }

  const days = [...daily.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return { observed, series, days };
}

function setDaily(map, date, key, value) {
  if (!map.has(date)) map.set(date, {});
  map.get(date)[key] = value;
}

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n <= -900 || n >= 900 ? undefined : n; // ±900 은 결측
}

// ---------------------------------------------------------------- 대체 데이터

// 인증키가 없어도 화면은 돌아가야 한다. 격자와 날짜로 결정되는 그럴듯한 값을 만든다.
function syntheticForecast(nx, ny, now) {
  let seed = nx * 7919 + ny * 104729 + Number(ymd(now));
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const month = now.getUTCMonth() + 1;
  const seasonal = 14 - 13 * Math.cos(((month - 1) / 12) * 2 * Math.PI); // 1월 1˚ ~ 7월 27˚
  const northness = (140 - ny) * 0.035; // 남쪽이 따뜻하게
  const wetness = rnd();

  const series = [];
  const daily = new Map();
  const start = shiftHours(now, 1);

  for (let i = 0; i < 72; i++) {
    const t = shiftHours(start, i);
    const hour = t.getUTCHours();
    const date = ymd(t);
    const diurnal = -5.5 * Math.cos(((hour - 3) / 24) * 2 * Math.PI);
    const drift = Math.sin((i / 72) * Math.PI * 1.3) * 2.4;
    const temp = Math.round((seasonal + northness + diurnal + drift + (rnd() - 0.5) * 1.2) * 10) / 10;

    const rainy = wetness > 0.62 && i > 8 + wetness * 20 && i < 34 + wetness * 22;
    const pop = rainy ? 30 + Math.round(rnd() * 60) : Math.round(rnd() * 25);
    const pty = rainy && pop > 55 ? (temp < 1 ? 3 : 1) : 0;
    const sky = pty ? 4 : pop > 40 ? 3 : rnd() > 0.65 ? 3 : 1;

    series.push({
      key: `${date}${pad(hour)}00`,
      date, hour, temp,
      pop, pty, sky,
      humidity: 45 + Math.round(pop * 0.45 + rnd() * 12),
      wind: Math.round((1 + rnd() * 4.5 + (pty ? 1.8 : 0)) * 10) / 10,
      windDir: Math.round(rnd() * 360),
      rain: pty ? `${(rnd() * 6).toFixed(1)}mm` : '강수없음',
      nowcast: i < 6,
    });

    const d = daily.get(date) ?? { tmn: temp, tmx: temp };
    daily.set(date, { tmn: Math.min(d.tmn, temp), tmx: Math.max(d.tmx, temp) });
  }

  const first = series[0];
  return {
    observed: {
      temp: Math.round((first.temp - 0.4) * 10) / 10,
      humidity: first.humidity,
      pty: first.pty,
      sky: first.sky,
      wind: first.wind,
      windDir: first.windDir,
      rain: first.rain,
      baseDate: ymd(now),
      baseTime: `${pad(now.getUTCHours())}00`,
    },
    series,
    days: [...daily.entries()]
      .map(([date, v]) => ({ date, tmn: Math.round(v.tmn), tmx: Math.round(v.tmx) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

// ---------------------------------------------------------------- 라우트

async function handleForecast(req, res, url) {
  const nx = Number(url.searchParams.get('nx'));
  const ny = Number(url.searchParams.get('ny'));
  if (!Number.isInteger(nx) || !Number.isInteger(ny)) {
    return send(res, 400, { error: '격자 좌표 nx, ny 가 필요합니다' });
  }

  const now = kstNow();
  const bases = {
    ncst: ncstBase(now),
    ultra: ultraFcstBase(now),
    vilage: vilageBase(now),
  };

  if (!SERVICE_KEY) {
    return send(res, 200, {
      ...syntheticForecast(nx, ny, now),
      nx, ny, bases,
      source: 'sample',
      notice: '공공데이터포털 인증키가 없어 예시 데이터를 보여주는 중입니다.',
    });
  }

  try {
    const [ncst, ultra, vilage] = await Promise.all([
      callKma('getUltraSrtNcst', { numOfRows: '20', ...bases.ncst, nx, ny }),
      callKma('getUltraSrtFcst', { numOfRows: '300', ...bases.ultra, nx, ny }),
      callKma('getVilageFcst', { numOfRows: '1200', ...bases.vilage, nx, ny }),
    ]);
    const merged = mergeForecast({ ncst, ultra, vilage });
    if (!merged.series.length) throw new Error('기상청이 이 격자의 예보를 주지 않았습니다');
    send(res, 200, { ...merged, nx, ny, bases, source: 'kma' });
  } catch (err) {
    send(res, 200, {
      ...syntheticForecast(nx, ny, now),
      nx, ny, bases,
      source: 'sample',
      notice: `기상청 호출에 실패해 예시 데이터를 보여주는 중입니다 — ${err.message}`,
    });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(payload);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const roots = { '/data/': __dirname, default: path.join(__dirname, 'public') };
  const root = rel.startsWith('/data/') ? roots['/data/'] : roots.default;
  const file = path.join(root, path.normalize(rel).replace(/^([/\\])+/, ''));

  if (!file.startsWith(__dirname)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('없는 주소입니다');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/forecast') return handleForecast(req, res, url);
  serveStatic(res, url.pathname);
}).listen(PORT, () => {
  console.log(`격자예보  http://localhost:${PORT}`);
  console.log(SERVICE_KEY
    ? '기상청 인증키를 찾았습니다. 실제 예보를 불러옵니다.'
    : '인증키가 없어 예시 데이터로 실행합니다. .env 에 KMA_SERVICE_KEY=... 를 넣으면 실제 예보를 씁니다.');
});
