import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATA_PATH = fileURLToPath(new URL("../data/national-open-years.json", import.meta.url));
const NEW_WITHIN_YEARS = 6; // Configured to 6 years in 2026 context

let _map = null;

const ALIASES = {
  화천숲속야영장: "화천야영장",
};

// Mapped from make_excel.py ADDITIONAL_OPEN_YEARS
const ADDITIONAL_OPEN_YEARS = {
  // Gyeonggi/Incheon
  '강씨봉': 2011, '칼봉산': 2008, '석모도': 2011, '축령산': 1995,
  '수락산동막골': 2025, '동두천': 2020, '서운산': 2018, '신암저수지': 2024,
  '양평백운봉': 2017, '양평쉬자': 2018, '쉬자파크': 2018, '고대산': 2017,
  '덕적도': 2025, '용인': 2009, '바라산': 2014, '천보산': 2012,
  '무봉산': 2023, '청평': 2001, '강화': 2011, '양평설매재': 1999, '설매재': 1999,
  '양평': 2018, '의왕바라산': 2014,
  // Gangwon
  '진부령': 2026, '임해': 2009, '광치': 2006, '송이밸리': 2012,
  '망경대산': 2012, '치악산': 1994, '갯골': 2023, '하추': 2008,
  '두루웰': 2017, '강원숲체험장': 1997, '집다리골': 1994, '춘천숲': 2008,
  '태백고원': 2005, '평창': 2012, '가리산': 1998, '삼척활기': 2020,
  '피노키오': 2005, '횡성': 2002, '철원두루웰': 2017,
  // Chungbuk
  '성불산': 2016, '조령산': 1995, '소백산': 2017, '소선암': 2005,
  '속리산숲체험': 2017, '충북알프스': 2010, '민주지산': 2004, '장령산': 1994,
  '백야': 2011, '수레의산': 2007, '박달재': 1992, '옥전': 2022,
  '좌구산': 2009, '생거진천': 2014, '미원별빛': 2026, '옥화': 1999,
  '계명산': 1997, '문성': 2008, '봉황': 1996, '속리산숲체험휴양마을': 2017,
  // Daejeon/Chungnam
  '공주산림휴양': 2016, '금산산림문화': 2008, '양촌': 2013, '만인산': 1990,
  '장태산': 1991, '성주산': 1993, '원산도': 2026, '만수산': 1992,
  '영인산': 1997, '봉수산': 2007, '태학산': 2001, '칠갑산': 1993,
  '안면도': 1992, '용봉산': 1993, '희리산': 1999, '공주': 2016, '금산': 2008,
  // Jeonbuk
  '선암': 2023, '김제선암': 2023, '무주향로산': 2018, '고산': 1998,
  '성수산왕의숲': 2024, '방화동': 2003, '와룡': 1996, '내장산': 2026,
  '데미샘': 2012, '남원': 1995,
  // Jeonnam/Gwangju
  '주작산': 2007, '팔영산': 1998, '산수유': 2015, '제암산': 1996,
  '순천': 2011, '봉황산': 2012, '기찬': 2023, '완도': 2018,
  '흑석산': 1999, '백아산': 1996, '한천': 2003, '무등산편백': 1997,
  // Daegu/Gyeongbuk
  '토함산': 1997, '미숭산': 2012, '옥성': 2007, '군위장곡': 1997,
  '수도산': 2014, '비슬산': 1998, '화원': 2010, '문수산': 2020,
  '성주봉': 2001, '독용산성': 2014, '안동호반': 2010, '영양에코둥지': 2014,
  '보현산': 2022, '운주산승마': 2009, '구수곡': 2001, '금봉': 2004,
  '청도': 2022, '청송': 1997, '송정': 2006, '팔공산금화': 2016,
  '비학산': 2015, '학가산우래': 2000, '신불산': 1989,
  // Busan/Gyeongnam
  '거제': 1993, '거창산림레포츠': 2025, '금원산': 1993, '항노화힐링': 2021,
  '갈모봉': 2024, '도래재': 2022, '사천케이블카': 2021, '산청한방': 2014,
  '대운산': 2009, '자굴산': 2022, '진주월아산': 2022, '화왕산': 2014,
  '구재봉': 2016, '하동편백': 2020, '대봉산': 2021, '대봉캠핑': 2021,
  '산삼': 2012, '용추': 1993, '오도산': 2002, '중산': 1997,
  '덕원': 2019, '거창': 2025, '항노화힐링랜드': 2021, '대봉': 2021,
  // Jeju
  '붉은오름': 2012, '서귀포': 1995, '교래': 2011, '제주절물': 1997
};

export function normalizeKey(name) {
  let cleanName = String(name)
    .replace(/^\([^)]*\)/, "")   // Remove prefix like (가평군)
    .replace(/\s+/g, "");        // Remove spaces
  
  const suffixes = [
    '자연휴양림', '휴양림', '숲속야영장', '캠핑랜드', '휴양랜드', 
    '산림휴양마을', '산림문화타운', '숲속문화촌', '산림레포츠파크', 
    '항노화힐링랜드', '쉬자파크', '해송', '폭포'
  ];
  for (const suffix of suffixes) {
    if (cleanName.endsWith(suffix)) {
      if (cleanName.length > suffix.length) {
        cleanName = cleanName.slice(0, -suffix.length);
      }
    }
  }
  return cleanName;
}

function getMap() {
  if (_map) return _map;
  _map = new Map();
  if (existsSync(DATA_PATH)) {
    try {
      const json = JSON.parse(readFileSync(DATA_PATH, "utf8"));
      for (const f of json.forests) _map.set(f.key, f);
    } catch (e) {
      console.error("Error reading national-open-years.json:", e);
    }
  }
  return _map;
}

export function lookupOpenYear(name) {
  const key = normalizeKey(name);
  // 1. Look up in ADDITIONAL_OPEN_YEARS first
  if (ADDITIONAL_OPEN_YEARS[key]) {
    return { opened: ADDITIONAL_OPEN_YEARS[key] };
  }
  if (ADDITIONAL_OPEN_YEARS[ALIASES[key]]) {
    return { opened: ADDITIONAL_OPEN_YEARS[ALIASES[key]] };
  }
  // 2. Fall back to national-open-years.json
  const map = getMap();
  return map.get(key) ?? map.get(ALIASES[key]) ?? null;
}

export function withOpenYear(forest) {
  const hit = lookupOpenYear(forest.name || forest.insttNm);
  const thisYear = 2026; // Setting year as 2026
  const openYear = hit?.opened ?? null;
  return {
    ...forest,
    openYear,
    isNew: openYear != null ? (thisYear - openYear <= NEW_WITHIN_YEARS) : false,
  };
}
