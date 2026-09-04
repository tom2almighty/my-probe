//! 常用国家 / 地区列表（ISO 3166-1 alpha-2，小写），用于服务器归属地选择与旗帜展示。

export interface Country {
  code: string;
  name: string;
}

export const COUNTRIES: Country[] = [
  { code: "cn", name: "中国大陆" },
  { code: "hk", name: "中国香港" },
  { code: "tw", name: "中国台湾" },
  { code: "mo", name: "中国澳门" },
  { code: "jp", name: "日本" },
  { code: "kr", name: "韩国" },
  { code: "sg", name: "新加坡" },
  { code: "my", name: "马来西亚" },
  { code: "th", name: "泰国" },
  { code: "vn", name: "越南" },
  { code: "ph", name: "菲律宾" },
  { code: "id", name: "印度尼西亚" },
  { code: "in", name: "印度" },
  { code: "pk", name: "巴基斯坦" },
  { code: "ae", name: "阿联酋" },
  { code: "il", name: "以色列" },
  { code: "tr", name: "土耳其" },
  { code: "ru", name: "俄罗斯" },
  { code: "kz", name: "哈萨克斯坦" },
  { code: "au", name: "澳大利亚" },
  { code: "nz", name: "新西兰" },
  { code: "us", name: "美国" },
  { code: "ca", name: "加拿大" },
  { code: "mx", name: "墨西哥" },
  { code: "br", name: "巴西" },
  { code: "ar", name: "阿根廷" },
  { code: "cl", name: "智利" },
  { code: "gb", name: "英国" },
  { code: "ie", name: "爱尔兰" },
  { code: "de", name: "德国" },
  { code: "fr", name: "法国" },
  { code: "nl", name: "荷兰" },
  { code: "be", name: "比利时" },
  { code: "lu", name: "卢森堡" },
  { code: "ch", name: "瑞士" },
  { code: "at", name: "奥地利" },
  { code: "it", name: "意大利" },
  { code: "es", name: "西班牙" },
  { code: "pt", name: "葡萄牙" },
  { code: "se", name: "瑞典" },
  { code: "no", name: "挪威" },
  { code: "dk", name: "丹麦" },
  { code: "fi", name: "芬兰" },
  { code: "is", name: "冰岛" },
  { code: "pl", name: "波兰" },
  { code: "cz", name: "捷克" },
  { code: "sk", name: "斯洛伐克" },
  { code: "hu", name: "匈牙利" },
  { code: "ro", name: "罗马尼亚" },
  { code: "bg", name: "保加利亚" },
  { code: "gr", name: "希腊" },
  { code: "ua", name: "乌克兰" },
  { code: "md", name: "摩尔多瓦" },
  { code: "lt", name: "立陶宛" },
  { code: "lv", name: "拉脱维亚" },
  { code: "ee", name: "爱沙尼亚" },
  { code: "rs", name: "塞尔维亚" },
  { code: "za", name: "南非" },
  { code: "eg", name: "埃及" },
  { code: "ng", name: "尼日利亚" },
  { code: "ke", name: "肯尼亚" },
];

const NAME_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]));

/** 国家代码 → 中文名，未收录时原样返回大写代码 */
export function countryName(code?: string | null): string {
  if (!code) return "未设置";
  const c = code.toLowerCase().trim();
  return NAME_BY_CODE.get(c) ?? c.toUpperCase();
}
