# 격자예보

기상청은 대한민국을 5km 격자로 나눠 예보합니다. 이 서비스는 그 격자를
블록으로 쌓아 보여주고, 블록 하나를 고르면 그 칸의 예보를 보여줍니다.

## 실행

```sh
node server.js          # http://localhost:3000
PORT=3900 node server.js
```

의존성 없음. Node 18 이상(내장 `fetch` 사용).

인증키는 `.env` 에서 읽습니다. 없으면 예시 데이터로 화면만 돌아갑니다.

```
KMA_SERVICE_KEY=공공데이터포털에서_발급받은_인코딩_인증키
```

## 격자 데이터 다시 만들기

기상청 엑셀이 바뀌면:

```sh
python scripts/build-data.py
```

`data/places.json`(읍면동 3,564곳)과 `data/cells.json`(격자 4,083칸)을 새로 씁니다.

## 구조

```
server.js              기상청 API 프록시 + 정적 서버. 예보 병합이 여기 있다.
scripts/build-data.py  기상청 엑셀 → 격자·읍면동 JSON
data/                  위 스크립트가 만든 결과물
public/                화면 (index.html · styles.css · app.js)
docs/design-spec.md    디자인과 API 정리
```

## 예보를 어떻게 합치는가

기상청은 오퍼레이션 세 개를 따로 줍니다. 시간별 슬롯 하나로 겹쳐 쓰되,
정확도 순서를 지킵니다.

| 순서 | 오퍼레이션 | 범위 | 발표 |
|---|---|---|---|
| 1 | `getVilageFcst` 단기예보 | 최대 5일 | 하루 8번 (02·05·08·11·14·17·20·23시), +10분 |
| 2 | `getUltraSrtFcst` 초단기예보 | 앞 6시간 | 매시 30분, +45분 |
| 3 | `getUltraSrtNcst` 초단기실황 | 지금 | 매시, +40분 |

뒤 항목이 앞 항목을 덮어씁니다. 발표 시각 계산은 `server.js` 의
`vilageBase` / `ultraFcstBase` / `ncstBase` 에 있습니다.

## 한도

오퍼레이션당 하루 10,000회. 화면 한 번 여는 데 3회 쓰므로 하루 약 3,300회
열람까지 견딥니다. 더 필요하면 `getFcstVersion` 으로 갱신 시점만 확인하고
같은 발표분은 캐시하면 됩니다.
