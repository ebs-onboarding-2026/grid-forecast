"""기상청 격자 엑셀 -> 웹에서 쓰는 JSON 두 개를 만든다.

  data/cells.json   격자 지도용. [nx, ny, 이 칸에 속한 읍면동 수, 대표 읍면동 인덱스].
                    동 수가 곧 도시 밀도라서, 그대로 지도의 밝기가 된다.
  data/places.json  검색용. 읍면동 -> 격자 + 위경도.

xlsx를 파이썬 표준 라이브러리만으로 읽는다 (openpyxl 불필요).
"""

import json
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / "기상청41_단기예보 조회서비스_오픈API활용가이드_격자_위경도(2607).xlsx"
OUT = ROOT / "data"


def column_index(ref):
    """'E3369' -> 4. 셀 주소에서 열 번호를 뽑는다."""
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def read_sheet(path, width=16):
    z = zipfile.ZipFile(path)
    shared = [
        "".join(t.text or "" for t in si.iter(NS + "t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml"))
    ]
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    for row in sheet.iter(NS + "row"):
        # 빈 셀은 <c> 자체가 없다. 순서대로 담으면 열이 밀리므로 주소로 꽂는다.
        values = [""] * width
        for cell in row:
            i = column_index(cell.get("r", ""))
            if not 0 <= i < width:
                continue
            v = cell.find(NS + "v")
            if v is None:
                continue
            values[i] = shared[int(v.text)] if cell.get("t") == "s" else v.text
        yield values


def disk(radius):
    return [(dx, dy)
            for dx in range(-radius, radius + 1)
            for dy in range(-radius, radius + 1)
            if dx * dx + dy * dy <= radius * radius]


def closing(grid, radius):
    """팽창 뒤 침식. 육지 안쪽 구멍을 메우고 해안선을 다듬되 영역을 넓히진 않는다."""
    stamp = disk(radius)

    grown = set()
    for nx, ny in grid:
        for dx, dy in stamp:
            grown.add((nx + dx, ny + dy))

    # 침식: 확장된 집합 안에서, 주변이 전부 육지인 칸만 남긴다
    return {c for c in grown
            if all((c[0] + dx, c[1] + dy) in grown for dx, dy in stamp)}


def fill_interior(known):
    """읍면동 중심점이 없어 비어 있는 칸을 메워 한반도를 빽빽하게 만든다.

    먼저 클로징으로 섬과 내륙의 구멍을 닫고, 그 뒤 동서남북 네 방향이 모두
    육지로 막힌 칸을 한 번 더 채운다. 바다와 큰 만은 네 방향이 뚫려 있어 남는다.
    """
    grid = closing(set(known), 3) | set(known)

    for reach in (7, 5):
        xs = [c[0] for c in grid]
        ys = [c[1] for c in grid]
        wave = set()
        for nx in range(min(xs), max(xs) + 1):
            for ny in range(min(ys), max(ys) + 1):
                if (nx, ny) in grid:
                    continue
                blocked = all(
                    any((nx + dx * s, ny + dy * s) in grid for s in range(1, reach + 1))
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
                if blocked:
                    wave.add((nx, ny))
        grid |= wave

    return grid - set(known)


def nearest_known(nx, ny, by_cell):
    return min(by_cell, key=lambda c: (c[0] - nx) ** 2 + (c[1] - ny) ** 2)


def main():
    rows = list(read_sheet(XLSX))[1:]  # 헤더 버림

    places = []
    for r in rows:
        if len(r) < 15 or not r[5] or not r[6] or not r[4]:
            continue  # 시/도, 시군구 단위 행은 검색 대상에서 제외
        lat = round(float(r[14]), 4) if r[14] else None
        lon = round(float(r[13]), 4) if r[13] else None
        places.append([r[4], r[3], r[2], int(r[5]), int(r[6]), lat, lon])

    places.sort(key=lambda p: (p[2], p[1], p[0]))

    # 시도 이름은 반복이 심해서 사전으로 접어둔다
    sidos = sorted({p[2] for p in places})
    sido_index = {name: i for i, name in enumerate(sidos)}
    for p in places:
        p[2] = sido_index[p[2]]

    # 격자별로 동을 모은다. 대표 동은 그 칸에서 가장 이름이 앞서는 것.
    by_cell = {}
    for i, p in enumerate(places):
        by_cell.setdefault((p[3], p[4]), []).append(i)

    filled = fill_interior(set(by_cell))

    cells = [[nx, ny, len(members), members[0]]
             for (nx, ny), members in by_cell.items()]
    for nx, ny in filled:
        near = nearest_known(nx, ny, by_cell)
        cells.append([nx, ny, 0, by_cell[near][0]])  # 동 0개 = 메운 칸
    cells.sort()

    OUT.mkdir(exist_ok=True)
    (OUT / "places.json").write_text(
        json.dumps(
            {"fields": ["dong", "sigungu", "sido", "nx", "ny", "lat", "lon"],
             "sidos": sidos,
             "rows": places},
            ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")

    (OUT / "cells.json").write_text(
        json.dumps({"fields": ["nx", "ny", "dongCount", "representative"], "rows": cells},
                   separators=(",", ":")),
        encoding="utf-8")

    busiest = max(cells, key=lambda c: c[2])
    print(f"읍면동 {len(places)}개 -> places.json")
    print(f"격자 {len(cells)}칸 -> cells.json (가장 붐비는 칸 {busiest[0]},{busiest[1]}: 동 {busiest[2]}개)")


if __name__ == "__main__":
    main()
