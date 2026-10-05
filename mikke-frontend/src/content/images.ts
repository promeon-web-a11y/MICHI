// サイトで使う写真の一覧。写真を差し替えるときは、public/images/ にファイルを置き、このファイルの該当行だけを直す。
// 現在の写真は Wikimedia Commons の公開素材（ライセンスは credit のとおり。フッターの「写真クレジット」に表示している）。
// 自前の写真に差し替えたら credit を null にすれば、クレジット欄から消える。

export type ImageCredit = { author: string; license: string; licenseUrl: string; source: string };

export type SiteImage = {
  src: string;
  alt: string;
  /** 切り抜くときに残したい位置（CSS の object-position）。mobile は縦長の画面用 */
  position?: { desktop: string; mobile: string };
  credit: ImageCredit | null;
};

const CC_BY_SA_4 = { license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" };
const CC_BY_25 = { license: "CC BY 2.5", licenseUrl: "https://creativecommons.org/licenses/by/2.5/" };
const CC_BY_4 = { license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" };
const CC_BY_2 = { license: "CC BY 2.0", licenseUrl: "https://creativecommons.org/licenses/by/2.0/" };
const CC_BY_SA_2 = { license: "CC BY-SA 2.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/" };
const CC0 = { license: "CC0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" };
const commons = (file: string) => `https://commons.wikimedia.org/wiki/File:${file}`;

export const IMAGES = {
  hero: {
    src: "/images/hero-otaru-canal.jpg",
    alt: "夕暮れの小樽運河と石造りの倉庫",
    position: { desktop: "center 62%", mobile: "64% center" },
    credit: { author: "Tan Wei Liang Byorn", ...CC_BY_SA_4, source: commons("Otaru_Canal_HDR1.jpg") },
  },
  nightView: {
    src: "/images/sapporo-night-view.jpg",
    alt: "藻岩山から見た札幌の夜景",
    credit: { author: "掬茶", ...CC_BY_SA_4, source: commons("City_nightscape_of_Sapporo_from_Mt._Moiwa_20260703a.jpg") },
  },
  ramen: {
    src: "/images/sapporo-ramen.jpg",
    alt: "札幌の味噌ラーメン",
    credit: { author: "663highland", ...CC_BY_25, source: commons("151010_Sapporo_ramen_at_Susukino_Sapporo_Hokkaido_Japan01s.jpg") },
  },
  bluePond: {
    src: "/images/blue-pond.jpg",
    alt: "美瑛・白金の青い池",
    credit: { author: "AndyLeungHK", ...CC0, source: commons("Shirogane_Blue_Pond,_Biei,_Hokkaido_Japan.jpg") },
  },
  road: {
    src: "/images/hokkaido-road.jpg",
    alt: "緑の中を抜ける北海道の道",
    credit: {
      author: "IRishikawa521",
      ...CC_BY_SA_4,
      source: commons("Hokkaido_Prefectural_road_Route_302_(Onobunai_Station_line)_in_Yuko,_Horonobe.jpg"),
    },
  },
  lakeToya: {
    src: "/images/lake-toya-sunset.jpg",
    alt: "洞爺湖に沈む夕日",
    credit: { author: "663highland", ...CC_BY_25, source: commons("130922_Lake_Toya_Toyako_Hokkaido_Japan01s5.jpg") },
  },
  flowerHill: {
    src: "/images/biei-flower-hill.jpg",
    alt: "美瑛・四季彩の丘の花畑",
    credit: { author: "663highland", ...CC_BY_25, source: commons("140726_Shikisai-no-oka_Biei_Hokkaido_Japan02n.jpg") },
  },
  patchwork: {
    src: "/images/biei-patchwork.jpg",
    alt: "空から見た美瑛の畑",
    credit: { author: "663highland", ...CC_BY_25, source: commons("140724_Biei_Hokkaido_Japan01s8.jpg") },
  },
  otaruWinter: {
    src: "/images/otaru-canal-winter.jpg",
    alt: "冬の夜の小樽運河",
    credit: { author: "663highland", ...CC_BY_25, source: commons("Otaru_Canal01s3.jpg") },
  },
  tvTower: {
    src: "/images/sapporo-tv-tower.jpg",
    alt: "大通公園から見た夜のさっぽろテレビ塔",
    credit: { author: "掬茶", ...CC_BY_SA_4, source: commons("Sapporo_TV_Tower_at_night_20250725.jpg") },
  },
  // ---- ここから下は MICHI で追加した全国の写真（みんなのプラン・ルート詳細で使う） ----
  kyotoYasaka: {
    src: "/images/kyoto-yasaka-pagoda.jpg",
    alt: "京都・八坂通から見上げる八坂の塔",
    credit: {
      author: "Basile Morin",
      ...CC_BY_SA_4,
      source: commons("Yasaka-dori_early_morning_with_street_lanterns_and_the_Tower_of_Yasaka_(Hokan-ji_Temple),_Kyoto,_Japan.jpg"),
    },
  },
  kyotoStation: {
    src: "/images/kyoto-station.jpg",
    alt: "京都駅の中央口",
    credit: { author: "MaedaAkihiko", ...CC0, source: commons("Kyoto-STA_Central.jpg") },
  },
  arashiyamaBamboo: {
    src: "/images/kyoto-arashiyama-bamboo.jpg",
    alt: "嵐山の竹林の小径",
    credit: { author: "Mitchwandrew", ...CC_BY_4, source: commons("Arashiyama_Bamboo_Grove.jpg") },
  },
  teishoku: {
    src: "/images/washoku-teishoku.jpg",
    alt: "和食の定食",
    credit: { author: "ノボホショコロトソ", ...CC_BY_4, source: commons("Karaage_teishoku_in_Kochi.jpg") },
  },
  kinkakuji: {
    src: "/images/kyoto-kinkakuji.jpg",
    alt: "鏡湖池に映る金閣寺",
    credit: { author: "Basile Morin", ...CC_BY_SA_4, source: commons("Water_reflection_of_Kinkaku-ji_Temple_a_sunny_day,_Kyoto,_Japan.jpg") },
  },
  tokyoAsakusa: {
    src: "/images/tokyo-asakusa-nakamise.jpg",
    alt: "浅草・仲見世通りと浅草寺の宝蔵門",
    credit: { author: "663highland", ...CC_BY_25, source: commons("Asakusa_sensoji07s3200.jpg") },
  },
  osakaDotonbori: {
    src: "/images/osaka-dotonbori.jpg",
    alt: "夜の大阪・道頓堀",
    credit: { author: "Sakai Yayoi", ...CC0, source: commons("Osaka_Dotonbori_yoru.jpg") },
  },
  kaisendon: {
    src: "/images/kaisendon.jpg",
    alt: "まぐろやたこがのった海鮮丼",
    credit: { author: "Ocdp", ...CC0, source: commons("Kaisen-don_001.jpg") },
  },
  okinawaBeach: {
    src: "/images/okinawa-kabira-beach.jpg",
    alt: "石垣島・川平湾の白い砂浜",
    credit: { author: "663highland", ...CC_BY_25, source: commons("Kabira_Bay_Ishigaki_Island21bs5s4410.jpg") },
  },
  kamikochi: {
    src: "/images/nagano-kamikochi.jpg",
    alt: "上高地の河童橋と、雪をかぶった穂高連峰",
    credit: { author: "lumoplank", ...CC0, source: commons("Kamikochi_-_Kamikochi6538.jpg") },
  },
  dazaifu: {
    src: "/images/fukuoka-dazaifu.jpg",
    alt: "太宰府天満宮の本殿",
    credit: { author: "Jakub Hałun", ...CC_BY_SA_4, source: commons("20100719_Dazaifu_Tenmangu_Shrine_3328.jpg") },
  },
  yufuin: {
    src: "/images/oita-yufuin.jpg",
    alt: "由布院の温泉街と由布岳",
    credit: {
      author: "そらみみ",
      ...CC_BY_SA_4,
      source: commons("View_of_Mount_Yufudake_and_Yufuin_Onsen_Street_in_front_of_Yufuin_Station.JPG"),
    },
  },
  ginzanOnsen: {
    src: "/images/yamagata-ginzan-onsen.jpg",
    alt: "銀山温泉の木造旅館と赤い橋",
    credit: { author: "掬茶", ...CC_BY_SA_4, source: commons("Takimi-tei_in_Ginzan_Onsen_20181006.jpg") },
  },
  kanazawaChaya: {
    src: "/images/kanazawa-higashi-chaya.jpg",
    alt: "金沢・ひがし茶屋街の石畳と町家",
    credit: { author: "Andrea Schaffer", ...CC_BY_2, source: commons("Higashi_Chaya_district,_Kanazawa_(3810704024).jpg") },
  },
  furanoLavender: {
    src: "/images/furano-lavender.jpg",
    alt: "富良野のラベンダー畑",
    credit: { author: "titanium22", ...CC_BY_SA_2, source: commons("JP_Hokkaido_Furano_lavender.jpg") },
  },
} satisfies Record<string, SiteImage>;

export type ImageKey = keyof typeof IMAGES;
