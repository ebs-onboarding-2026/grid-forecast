// 격자예보 — 화면
// 지도, 검색, 시간별 리본, 일별 목록을 한 곳에서 그린다.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_NY = 147; // 격자 ny 는 북쪽이 큰 값이라 화면에서는 뒤집는다

const $ = (id) => document.getElementById(id);

const el = {
  body: document.body,
  q: $('q'),
  results: $('results'),
  locate: $('locate'),
  mapCells: $('map-cells'),
  mapMark: $('map-mark'),
  map: $('map'),
  mapHint: $('map-hint'),
  place: $('now-place'),
  temp: $('temp'),
  state: $('state'),
  humidity: $('v-humidity'),
  wind: $('v-wind'),
  rain: $('v-rain'),
  range: $('v-range'),
  stamp: $('stamp'),
  ribbon: $('ribbon'),
  ribbonScroll: $('ribbon-scroll'),
  ribbonAlt: $('ribbon-alt'),
  aheadNote: $('ahead-note'),
  daylist: $('daylist'),
  notice: $('notice'),
};

let places = [];   // { dong, sigungu, sido, nx, ny, lat, lon, label, search }
let cells = [];    // { nx, ny, count, rep }
let current = null;
let requestToken = 0;

// ── 기상청 코드 읽기 ─────────────────────────────────────────────────

const SKY_WORD = { 1: '맑음', 3: '구름많음', 4: '흐림' };
const PTY_WORD = {
  1: '비', 2: '비와 눈', 3: '눈', 4: '소나기',
  5: '빗방울', 6: '빗방울과 눈날림', 7: '눈날림',
};
const WIND_WORD = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];

// 하늘 상태를 팔레트 이름으로. 강수가 있으면 강수가 이긴다.
function skyTheme(sky, pty) {
  if (pty === 3 || pty === 7) return 'snow';
  if (pty === 2 || pty === 6) return 'snow';
  if (pty) return 'rain';
  if (sky === 4) return 'overcast';
  if (sky === 3) return 'cloudy';
  return 'clear';
}

function conditionWord(sky, pty) {
  return PTY_WORD[pty] ?? SKY_WORD[sky] ?? '흐림';
}

function windWord(deg) {
  if (deg === undefined || deg === null) return '';
  return WIND_WORD[Math.round(deg / 45) % 8] + '풍';
}

// PCP/RN1 은 "강수없음" 같은 문자열로도, 숫자로도 온다
function rainText(v) {
  if (v === undefined || v === null || v === '') return '없음';
  if (typeof v === 'string' && /없음/.test(v)) return '없음';
  const n = Number(v);
  if (Number.isFinite(n)) return n === 0 ? '없음' : `${n}mm`;
  return v;
}

function hasRain(v) {
  return rainText(v) !== '없음';
}

// 지금 날씨를 한 문장으로. 사람이 읽을 말로 쓴다.
function describe(now) {
  const parts = [];
  const cond = conditionWord(now.sky, now.pty);

  if (now.pty) parts.push(`${cond}가 내리고 있습니다`.replace('비가 내리고', '비가 내리고'));
  else parts.push(`하늘은 ${cond}입니다`);

  if (now.wind >= 9) parts.push('바람이 매우 셉니다');
  else if (now.wind >= 4) parts.push('바람이 제법 붑니다');

  if (now.humidity !== undefined) {
    if (now.humidity <= 30) parts.push('공기가 메마릅니다');
    else if (now.humidity >= 80) parts.push('눅눅합니다');
  }
  return parts.join('. ') + '.';
}

// ── 데이터 불러오기 ──────────────────────────────────────────────────

async function loadData() {
  const [p, c] = await Promise.all([
    fetch('/data/places.json').then((r) => r.json()),
    fetch('/data/cells.json').then((r) => r.json()),
  ]);

  places = p.rows.map(([dong, sigungu, sido, nx, ny, lat, lon]) => {
    const sidoName = p.sidos[sido];
    const label = [sidoName, sigungu, dong].filter(Boolean).join(' ');
    return { dong, sigungu, sido: sidoName, nx, ny, lat, lon, label, search: label.replace(/\s/g, '') };
  });

  cells = c.rows.map(([nx, ny, count, rep]) => ({ nx, ny, count, rep }));
}

// ── 지도: 격자 한 칸을 블록 하나로 쌓는다 ────────────────────────────
//
// 45° 아이소메트릭은 긴 반도를 대각선으로 눕혀버린다. 그래서 가로는 그대로
// 두고 세로만 눌러 기울인 정면 투영을 쓴다. 한반도는 똑바로 서 있고,
// 블록은 윗면과 앞면이 보인다. 한 칸에 읍면동이 많을수록 높이 솟고
// 잔디에서 돌로 바뀌므로, 서울과 부산이 저절로 도시처럼 자란다.

const ISO = { tw: 1, th: 0.66, zh: 1.3, maxLift: 5.5 };
const OVERLAP = 0.12; // 블록끼리 겹치는 양

function isoX(nx) { return (nx - 21) * ISO.tw; }
function isoY(row) { return row * ISO.th; }
function rowOf(ny) { return MAX_NY - ny; }

// 시골이 평평한 판으로 보이지 않게, 칸마다 정해진 만큼 살짝 울퉁불퉁하게 둔다.
function jitter(nx, ny) {
  const h = Math.sin(nx * 12.9898 + ny * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

function liftOf(count, nx = 0, ny = 0) {
  return 1 + (Math.min(count, 16) / 16) ** 1.35 * ISO.maxLift + jitter(nx, ny) * 0.45;
}

// 잔디 마을에서 돌로 덮인 도심까지 네 단계. 앞면은 윗면보다 어둡다.
const BLOCKS = [
  { at: 0.00, top: '#7cb24f', face: '#55772f' }, // 잔디
  { at: 0.30, top: '#a3ad5c', face: '#6e7538' }, // 마른 풀
  { at: 0.55, top: '#9e9e9e', face: '#6b6b6b' }, // 돌
  { at: 0.80, top: '#c2c2c2', face: '#878787' }, // 콘크리트
];

function blockOf(density) {
  let pick = BLOCKS[0];
  for (const b of BLOCKS) if (density >= b.at) pick = b;
  return pick;
}

let mapBounds = null;

function drawMap() {
  const peak = cells.reduce((m, c) => Math.max(m, c.count), 1);

  // 북쪽부터 칠해야 남쪽 블록이 앞을 가린다.
  const ordered = [...cells]
    .map((c) => ({ ...c, row: rowOf(c.ny), lift: liftOf(c.count, c.nx, c.ny), density: Math.min(c.count, 16) / Math.min(peak, 16) }))
    .sort((a, b) => a.row - b.row);

  const parts = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (const c of ordered) {
    const x = isoX(c.nx);
    const y = isoY(c.row);
    const z = c.lift * ISO.zh;
    const skin = blockOf(c.density);

    // crispEdges 는 사각형마다 따로 반올림해서 블록 사이에 1px 틈을 남긴다.
    // 아주 조금 겹쳐 그려 틈을 없앤다.
    const w = ISO.tw + OVERLAP;
    parts.push(`<rect fill="${skin.face}" x="${x}" y="${(y - z + ISO.th).toFixed(2)}" width="${w}" height="${(z + OVERLAP).toFixed(2)}"/>`);
    parts.push(`<rect fill="${skin.top}" x="${x}" y="${(y - z).toFixed(2)}" width="${w}" height="${(ISO.th + OVERLAP).toFixed(2)}"/>`);

    minX = Math.min(minX, x); maxX = Math.max(maxX, x + ISO.tw);
    minY = Math.min(minY, y - z); maxY = Math.max(maxY, y + ISO.th);
  }

  const pad = 1.5;
  const headroom = 5; // 비컨이 솟을 하늘
  mapBounds = {
    minX: minX - pad, minY: minY - pad - headroom,
    w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 + headroom,
  };
  el.map.setAttribute('viewBox', `${mapBounds.minX} ${mapBounds.minY} ${mapBounds.w} ${mapBounds.h}`);
  el.mapCells.innerHTML = parts.join('');
}

function markMap(place) {
  const row = rowOf(place.ny);
  const x = isoX(place.nx);
  const y = isoY(row);
  const cell = cells.find((c) => c.nx === place.nx && c.ny === place.ny);
  const z = liftOf(cell?.count ?? 1, place.nx, place.ny) * ISO.zh;
  const capTop = y - z - 1.2;
  const beamTop = mapBounds.minY + 1;

  el.mapMark.innerHTML = [
    // 비컨 빔 — 블록 꼭대기에서 하늘 끝까지
    `<rect class="beam" x="${x - ISO.tw * 0.35}" y="${beamTop}" width="${ISO.tw * 1.7}" height="${capTop - beamTop}"/>`,
    `<rect class="beam-core" x="${x + ISO.tw * 0.25}" y="${beamTop}" width="${ISO.tw * 0.5}" height="${capTop - beamTop}"/>`,
    // 금블록
    `<rect class="pin-left" x="${x}" y="${capTop + ISO.th}" width="${ISO.tw}" height="${z + 1.2}"/>`,
    `<rect class="pin-top" x="${x}" y="${capTop}" width="${ISO.tw}" height="${ISO.th}"/>`,
  ].join('');
}

// 화면 좌표를 격자로 되돌린다. 블록 높이 때문에 정확한 역변환은 없으니,
// 윗면 중심과의 거리로 가장 가까운 칸을 고른다.
function cellAt(event) {
  const pt = el.map.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const p = pt.matrixTransform(el.map.getScreenCTM().inverse());

  let best = null;
  let bestDist = 5; // 이만큼 벗어나면 바다를 누른 것으로 본다
  for (const c of cells) {
    const dx = isoX(c.nx) + ISO.tw / 2 - p.x;
    const dy = isoY(rowOf(c.ny)) - liftOf(c.count, c.nx, c.ny) * ISO.zh + ISO.th / 2 - p.y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

function bindMap() {
  el.map.addEventListener('pointermove', (e) => {
    const c = cellAt(e);
    if (!c) { el.mapHint.textContent = '칸을 눌러 그곳 예보를 봅니다'; return; }
    const rep = places[c.rep];
    if (!c.count) { el.mapHint.textContent = `${rep.label} 근처 · 격자 ${c.nx},${c.ny}`; return; }
    const more = c.count > 1 ? ` 외 ${c.count - 1}곳` : '';
    el.mapHint.textContent = `${rep.label}${more} · 격자 ${c.nx},${c.ny}`;
  });

  el.map.addEventListener('pointerleave', () => {
    el.mapHint.textContent = current ? current.label : '칸을 눌러 그곳 예보를 봅니다';
  });

  el.map.addEventListener('click', (e) => {
    const c = cellAt(e);
    if (c) select(places[c.rep]);
  });
}

// ── 동네 찾기 ────────────────────────────────────────────────────────

let activeResult = -1;

function search(term) {
  const needle = term.trim().replace(/\s/g, '');
  if (!needle) return [];
  const starts = [];
  const contains = [];
  for (const p of places) {
    if (p.dong.startsWith(needle) || p.sigungu.startsWith(needle)) starts.push(p);
    else if (p.search.includes(needle)) contains.push(p);
    if (starts.length >= 40) break;
  }
  return [...starts, ...contains].slice(0, 40);
}

function renderResults(list) {
  activeResult = -1;
  if (!list.length) {
    el.results.innerHTML = '<li class="r-empty">그런 이름의 동네가 없습니다</li>';
    openResults(true);
    return;
  }
  el.results.replaceChildren(...list.map((p, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.index = String(i);
    li.innerHTML = `<span class="r-dong"></span><span class="r-up"></span><span class="r-cell"></span>`;
    li.querySelector('.r-dong').textContent = p.dong;
    li.querySelector('.r-up').textContent = `${p.sido} ${p.sigungu}`;
    li.querySelector('.r-cell').textContent = `${p.nx},${p.ny}`;
    li.addEventListener('mousedown', (e) => { e.preventDefault(); select(p); });
    return li;
  }));
  openResults(true);
}

function openResults(open) {
  el.results.hidden = !open;
  el.q.setAttribute('aria-expanded', String(open));
}

function moveActive(delta, list) {
  const items = [...el.results.querySelectorAll('li[role="option"]')];
  if (!items.length) return;
  items[activeResult]?.setAttribute('aria-selected', 'false');
  activeResult = (activeResult + delta + items.length) % items.length;
  const item = items[activeResult];
  item.setAttribute('aria-selected', 'true');
  item.scrollIntoView({ block: 'nearest' });
}

function bindFinder() {
  let list = [];

  el.q.addEventListener('input', () => {
    list = search(el.q.value);
    if (!el.q.value.trim()) { openResults(false); return; }
    renderResults(list);
  });

  el.q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1, list); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1, list); }
    else if (e.key === 'Enter') {
      const pick = list[activeResult] ?? list[0];
      if (pick) { e.preventDefault(); select(pick); }
    } else if (e.key === 'Escape') { openResults(false); el.q.blur(); }
  });

  el.q.addEventListener('focus', () => { if (el.q.value.trim()) openResults(true); });
  el.q.addEventListener('blur', () => setTimeout(() => openResults(false), 120));

  el.locate.addEventListener('click', () => {
    if (!navigator.geolocation) {
      el.mapHint.textContent = '이 브라우저는 위치를 알려주지 않습니다';
      return;
    }
    el.locate.disabled = true;
    el.locate.textContent = '찾는 중';
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        el.locate.disabled = false;
        el.locate.textContent = '현재 위치';
        select(nearest(coords.latitude, coords.longitude));
      },
      () => {
        el.locate.disabled = false;
        el.locate.textContent = '현재 위치';
        el.mapHint.textContent = '위치를 쓸 수 없습니다. 동네 이름으로 찾아보세요.';
      },
      { timeout: 8000, maximumAge: 300000 },
    );
  });
}

function nearest(lat, lon) {
  let best = places[0];
  let bestD = Infinity;
  for (const p of places) {
    if (p.lat == null) continue;
    const dy = p.lat - lat;
    const dx = (p.lon - lon) * Math.cos((lat * Math.PI) / 180);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// ── 예보 그리기 ──────────────────────────────────────────────────────

async function select(place) {
  current = place;
  const token = ++requestToken;

  el.q.value = '';
  openResults(false);
  el.place.textContent = place.label;
  el.mapHint.textContent = place.label;
  markMap(place);

  try { localStorage.setItem('격자예보:마지막', JSON.stringify([place.nx, place.ny])); } catch { /* 무시 */ }
  const url = new URL(location.href);
  url.searchParams.set('nx', place.nx);
  url.searchParams.set('ny', place.ny);
  history.replaceState(null, '', url);

  const res = await fetch(`/api/forecast?nx=${place.nx}&ny=${place.ny}`);
  const data = await res.json();
  if (token !== requestToken) return; // 그 사이 다른 동네를 골랐다

  paint(place, data);
}

function paint(place, data) {
  const now = data.observed ?? {};
  const series = data.series ?? [];
  const head = series[0] ?? {};

  const sky = now.sky ?? head.sky;
  const pty = now.pty ?? head.pty ?? 0;
  const hour = Number(String(now.baseTime ?? '1200').slice(0, 2));

  el.body.dataset.sky = skyTheme(sky, pty);
  el.body.dataset.phase = hour >= 19 || hour < 6 ? 'night' : 'day';

  const temp = now.temp ?? head.temp;
  el.temp.textContent = temp === undefined ? '--' : temp.toFixed(1).replace(/\.0$/, '');
  el.state.textContent = describe({ sky, pty, wind: now.wind, humidity: now.humidity });

  el.humidity.innerHTML = now.humidity === undefined ? '—'
    : `${now.humidity}<span class="unit">%</span>`;
  el.wind.innerHTML = now.wind === undefined ? '—'
    : `${now.wind}<span class="unit">m/s ${windWord(now.windDir)}</span>`;
  el.rain.innerHTML = `${rainText(now.rain)}`;

  const today = todayRange(data, series);
  el.range.innerHTML = today
    ? `${today.tmn}<span class="unit">↓</span> ${today.tmx}<span class="unit">↑</span>`
    : '—';

  const at = `${String(now.baseDate ?? '').slice(4, 6)}월 ${String(now.baseDate ?? '').slice(6, 8)}일 ${String(now.baseTime ?? '').slice(0, 2)}시`;
  el.stamp.innerHTML = '';
  el.stamp.append(
    Object.assign(document.createElement('span'), { className: 'grid-id', textContent: `격자 ${place.nx}, ${place.ny}` }),
    document.createTextNode(`　${at} 실황`),
  );

  el.aheadNote.textContent = series.length
    ? `${series.length}시간치. 앞 여섯 시간은 초단기예보가 덮었습니다.`
    : '예보가 없습니다.';

  el.notice.hidden = !data.notice;
  if (data.notice) el.notice.textContent = data.notice;

  drawRibbon(series);
  drawDays(data, series);
}

function todayRange(data, series) {
  const today = series[0]?.date;
  if (!today) return null;
  const listed = data.days?.find((d) => d.date === today);
  const mine = series.filter((s) => s.date === today).map((s) => s.temp);
  if (listed?.tmn !== undefined && listed?.tmx !== undefined) return listed;
  if (!mine.length) return null;
  return { tmn: Math.round(Math.min(...mine)), tmx: Math.round(Math.max(...mine)) };
}

// ── 시간별 리본 ──────────────────────────────────────────────────────

const RB = {
  col: 46, padX: 10,
  dayNameY: 14,
  skyY: 26, skySize: 11,
  tempTop: 64, tempBottom: 140,
  axisY: 152, popMax: 46,
};

function drawRibbon(series) {
  el.ribbon.replaceChildren();
  if (!series.length) return;

  const n = series.length;
  const width = RB.padX * 2 + n * RB.col;

  // 강수가 한 번도 없는 기간이면 강수 띠를 통째로 접는다. 빈 칸은 정보가 아니다.
  const peakPop = Math.max(0, ...series.map((s) => s.pop ?? 0));
  const popBand = peakPop > 0 ? RB.popMax + 20 : 8;
  const hourY = RB.axisY + popBand + 16;
  const height = hourY + 12;

  el.ribbon.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el.ribbon.setAttribute('width', width);
  el.ribbon.setAttribute('height', height);
  el.ribbon.style.height = `${height}px`;

  const temps = series.map((s) => s.temp);
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  const span = Math.max(hi - lo, 4);
  const x = (i) => RB.padX + i * RB.col + RB.col / 2;
  const y = (t) => RB.tempBottom - ((t - lo) / span) * (RB.tempBottom - RB.tempTop);

  const add = (tag, attrs, text) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    el.ribbon.appendChild(node);
    return node;
  };

  // 초단기예보가 덮은 구간을 옅게 표시
  const nowcastCount = series.filter((s) => s.nowcast).length;
  if (nowcastCount) {
    add('rect', {
      x: RB.padX, y: RB.dayNameY + 4, width: nowcastCount * RB.col,
      height: RB.axisY - RB.dayNameY - 4, class: 'rb-nowcast',
    });
  }

  // 날 경계와 이름
  let lastDate = null;
  series.forEach((s, i) => {
    if (s.date === lastDate) return;
    lastDate = s.date;
    const left = RB.padX + i * RB.col;
    if (i > 0) add('rect', { x: left - 1, y: 20, width: 2, height: hourY - 14, class: 'rb-daybreak' });
    add('text', { x: left + (i > 0 ? 6 : 2), y: RB.dayNameY, class: 'rb-dayname' }, dayLabel(s.date, i === 0));
  });

  // 땅바닥
  add('rect', { x: RB.padX, y: RB.axisY, width: width - RB.padX * 2, height: 4, class: 'rb-ground' });

  const CW = 30; // 기둥 한 칸 너비

  series.forEach((s, i) => {
    const cx = x(i);
    const night = s.hour >= 19 || s.hour < 6;

    // 하늘 상태 한 칸. 맑으면 테두리만, 흐려질수록 차오르고, 강수면 꽉 찬다.
    add('rect', {
      x: cx - RB.skySize / 2, y: RB.skyY, width: RB.skySize, height: RB.skySize,
      class: s.pty > 0 ? 'rb-wet' : `rb-sky-${s.sky ?? 1}`,
    });

    // 기온은 땅에서 솟은 블록 기둥. 밤 시간대는 색이 다르다.
    const top = y(s.temp);
    add('rect', {
      x: cx - CW / 2, y: top, width: CW, height: RB.axisY - top,
      class: night ? 'rb-col-night' : 'rb-col',
    });
    add('rect', {
      x: cx - CW / 2, y: top, width: CW, height: 4,
      class: night ? 'rb-col-night-cap' : 'rb-col-cap',
    });
    for (let seam = top + 14; seam < RB.axisY - 2; seam += 14) {
      add('rect', { x: cx - CW / 2, y: seam, width: CW, height: 1.5, class: 'rb-seam' });
    }
    add('text', { x: cx, y: top - 7, class: 'rb-temp-label' }, Math.round(s.temp));

    // 강수확률은 땅 아래로 매달린다
    if (s.pop > 0) {
      const h = Math.max((s.pop / 100) * RB.popMax, 7);
      add('rect', { x: cx - 9, y: RB.axisY + 4, width: 18, height: h, class: 'rb-pop' });
      add('rect', { x: cx - 9, y: RB.axisY + 4, width: 18, height: 3, class: 'rb-pop-cap' });
      if (s.pop >= 30) add('text', { x: cx, y: RB.axisY + h + 17, class: 'rb-pop-label' }, `${s.pop}%`);
    }

    const label = i === 0 ? '지금' : String(s.hour);
    add('text', {
      x: cx, y: hourY,
      class: i === 0 || s.hour === 0 ? 'rb-hour rb-hour-mark' : 'rb-hour',
    }, label);
  });

  el.ribbonAlt.textContent = series.slice(0, 12)
    .map((s) => `${s.hour}시 ${s.temp}도, 강수확률 ${s.pop ?? 0}퍼센트`)
    .join('. ');

  el.ribbonScroll.scrollLeft = 0;
}

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

function toDate(ymd) {
  return new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
}

function dayLabel(ymd, first) {
  const d = toDate(ymd);
  const day = WEEKDAY[d.getDay()];
  return first ? `오늘 ${day}요일` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${day}`;
}

// ── 날마다 ───────────────────────────────────────────────────────────

function drawDays(data, series) {
  const byDate = new Map();
  for (const s of series) {
    const d = byDate.get(s.date) ?? { temps: [], pops: [], skies: [], ptys: [] };
    d.temps.push(s.temp);
    d.pops.push(s.pop ?? 0);
    d.skies.push(s.sky ?? 1);
    d.ptys.push(s.pty ?? 0);
    byDate.set(s.date, d);
  }

  const rows = [...byDate.entries()]
    .filter(([, d]) => d.temps.length >= 4)
    .map(([date, d]) => {
    const listed = data.days?.find((x) => x.date === date);
    return {
      date,
      tmn: listed?.tmn ?? Math.round(Math.min(...d.temps)),
      tmx: listed?.tmx ?? Math.round(Math.max(...d.temps)),
      pop: Math.max(...d.pops),
      sky: mode(d.ptys.some(Boolean) ? d.ptys.filter(Boolean) : d.skies),
      wet: d.ptys.some(Boolean),
    };
  });

  const lo = Math.min(...rows.map((r) => r.tmn));
  const hi = Math.max(...rows.map((r) => r.tmx));
  const span = Math.max(hi - lo, 1);

  el.daylist.replaceChildren(...rows.map((r, i) => {
    const li = document.createElement('li');
    const d = toDate(r.date);

    const name = document.createElement('span');
    name.className = 'd-name';
    name.innerHTML = `${i === 0 ? '오늘' : WEEKDAY[d.getDay()] + '요일'}<span class="d-date">${d.getMonth() + 1}.${d.getDate()}</span>`;

    const cond = document.createElement('span');
    cond.className = 'd-sky';
    cond.textContent = r.wet ? (PTY_WORD[r.sky] ?? '비') : (SKY_WORD[r.sky] ?? '맑음');

    const bar = document.createElement('span');
    bar.className = 'd-range';
    const fill = document.createElement('span');
    fill.className = 'd-fill';
    fill.style.left = `${((r.tmn - lo) / span) * 100}%`;
    fill.style.width = `${Math.max(((r.tmx - r.tmn) / span) * 100, 2)}%`;
    bar.appendChild(fill);

    const temps = document.createElement('span');
    temps.className = 'd-temps';
    temps.innerHTML = `<span class="d-low">${r.tmn}</span><span class="d-slash">/</span>${r.tmx}`;

    li.append(name, cond, bar, temps);
    li.title = `강수확률 최고 ${r.pop}%`;
    return li;
  }));
}

function mode(list) {
  const count = new Map();
  for (const v of list) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ── 시작 ─────────────────────────────────────────────────────────────

function openingPlace() {
  const url = new URL(location.href);
  const nx = Number(url.searchParams.get('nx'));
  const ny = Number(url.searchParams.get('ny'));
  if (nx && ny) {
    const hit = places.find((p) => p.nx === nx && p.ny === ny);
    if (hit) return hit;
  }
  try {
    const saved = JSON.parse(localStorage.getItem('격자예보:마지막') ?? 'null');
    if (saved) {
      const hit = places.find((p) => p.nx === saved[0] && p.ny === saved[1]);
      if (hit) return hit;
    }
  } catch { /* 무시 */ }
  return places.find((p) => p.dong === '청운효자동') ?? places[0];
}

async function start() {
  await loadData();
  drawMap();
  bindMap();
  bindFinder();
  select(openingPlace());
}

start().catch((err) => {
  el.state.textContent = `화면을 여는 데 실패했습니다 — ${err.message}`;
});
