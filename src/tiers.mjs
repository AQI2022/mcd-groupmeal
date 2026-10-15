/**
 * 官方人均预算搭配分档 → 可执行约束。
 *
 * `query-meals` 的官方 Description 为**团餐场景**给出了搭配建议（原文）：
 *   < 20 元      → 小食
 *   20–30 元     → 汉堡 + 小食 或 汉堡 + 饮料
 *   30–40 元     → 汉堡 + 薯条/小食 + 饮料
 *   40–50 元     → 汉堡 + 薯条 + 小食 + 饮料
 *   > 50 元      → 丰富组合，优先不重复小食
 *
 * 本项目把这段自然语言变成可求解的约束表：分档决定「每人必须有哪些品类」，
 * 求解器在满足约束的前提下最小化人均实付。这样产出的方案既合法又「专业」，
 * 而不是随便凑一堆最便宜的东西。
 */
import { yuanToCents } from './money.mjs';

export const CATEGORY = {
  BURGER: 'burger',
  FRIES: 'fries',
  SNACK: 'snack',
  DRINK: 'drink',
  DESSERT: 'dessert',
  OTHER: 'other',
};

/** 官方分档表（上界为开区间，单位：分）。 */
export const BUDGET_TIERS = [
  {
    id: 'lt20',
    label: '< ¥20',
    maxExclusive: yuanToCents(20),
    perPerson: { [CATEGORY.SNACK]: 1 },
    official: '小食',
  },
  {
    id: '20-30',
    label: '¥20–30',
    maxExclusive: yuanToCents(30),
    perPerson: { [CATEGORY.BURGER]: 1 },
    oneOf: [[CATEGORY.SNACK], [CATEGORY.DRINK]],
    official: '汉堡 + 小食 或 汉堡 + 饮料',
  },
  {
    id: '30-40',
    label: '¥30–40',
    maxExclusive: yuanToCents(40),
    perPerson: { [CATEGORY.BURGER]: 1, [CATEGORY.DRINK]: 1 },
    oneOf: [[CATEGORY.FRIES], [CATEGORY.SNACK]],
    official: '汉堡 + 薯条/小食 + 饮料',
  },
  {
    id: '40-50',
    label: '¥40–50',
    maxExclusive: yuanToCents(50),
    perPerson: { [CATEGORY.BURGER]: 1, [CATEGORY.FRIES]: 1, [CATEGORY.SNACK]: 1, [CATEGORY.DRINK]: 1 },
    official: '汉堡 + 薯条 + 小食 + 饮料',
  },
  {
    id: 'gt50',
    label: '> ¥50',
    maxExclusive: Infinity,
    perPerson: { [CATEGORY.BURGER]: 1, [CATEGORY.FRIES]: 1, [CATEGORY.DRINK]: 1 },
    minDistinctSnacks: 2,
    official: '丰富组合，优先不重复小食',
  },
];

export function tierFor(budgetPerPersonCents) {
  for (const t of BUDGET_TIERS) if (budgetPerPersonCents < t.maxExclusive) return t;
  return BUDGET_TIERS[BUDGET_TIERS.length - 1];
}

const RULES = [
  [CATEGORY.FRIES, ['薯条', '薯饼', '薯格']],
  [CATEGORY.DRINK, ['可乐', '雪碧', '芬达', '咖啡', '奶铁', '美式', '拿铁', '卡布', '奶茶', '茶', '果汁', '橙汁', '牛奶', '矿泉水', '饮用水', '气泡', '阳光橙', '柠檬']],
  [CATEGORY.DESSERT, ['冰淇淋', '新地', '麦旋风', '圣代', '甜筒', '派', '蛋糕', '曲奇']],
  [CATEGORY.BURGER, ['汉堡', '巨无霸', '板烧', '麦辣鸡腿', '麦香鸡', '吉士', '双层', '堡', '卷']],
  [CATEGORY.SNACK, ['麦乐鸡', '鸡块', '鸡翅', '鸡排', '那么大', '沙拉', '玉米', '苹果', '香肠', '蛋', '鸡柳', '鸡腿', '小食', '薯角', '鳕鱼']],
];

/**
 * 按餐品名称给品类打标。
 * @param {{name:string}} meal
 * @returns {Set<string>} 可能命中多个品类（例如「薯条」只命中 FRIES）
 */
export function classify(meal) {
  const name = String(meal?.name ?? '');
  const tags = new Set();
  for (const [cat, keywords] of RULES) {
    if (keywords.some((k) => name.includes(k))) tags.add(cat);
  }
  if (tags.has(CATEGORY.FRIES)) tags.delete(CATEGORY.SNACK); // 薯条是薯条，不是泛小食
  if (!tags.size) tags.add(CATEGORY.OTHER);
  return tags;
}

/** 判断该餐品是否命中某个品类。 */
export function isCategory(meal, category) {
  return classify(meal).has(category);
}

/**
 * 描述一个分档对「每人份」的要求，用于渲染与自检。
 * @returns {string} 例如 `汉堡×1 + 饮料×1 + （薯条 或 小食）×1`
 */
export function describeTier(tier) {
  const parts = Object.entries(tier.perPerson).map(([cat, n]) => `${cnName(cat)}×${n}`);
  if (tier.oneOf) parts.push(`（${tier.oneOf.map((g) => g.map(cnName).join(' 或 ')).join(' 或 ')}）×1`);
  if (tier.minDistinctSnacks) parts.push(`不重复小食 ≥ ${tier.minDistinctSnacks}`);
  return parts.join(' + ');
}

export function cnName(category) {
  return (
    {
      [CATEGORY.BURGER]: '汉堡',
      [CATEGORY.FRIES]: '薯条',
      [CATEGORY.SNACK]: '小食',
      [CATEGORY.DRINK]: '饮料',
      [CATEGORY.DESSERT]: '甜品',
      [CATEGORY.OTHER]: '其他',
    }[category] ?? category
  );
}
