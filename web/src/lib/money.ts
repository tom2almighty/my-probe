//! 金额显示。币种只决定符号与小数位，不做汇率换算，所以不引入任何外部依赖。

/** 下拉里给的常用币种。后端只校验「三位字母」，直接改库塞别的码一样能正常显示。 */
export const CURRENCIES = [
  "CNY",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "HKD",
  "TWD",
  "SGD",
  "RUB",
  "AUD",
  "CAD",
  "KRW",
] as const;

export const DEFAULT_CURRENCY = "CNY";

// Intl.NumberFormat 构造不便宜，表格里每行都调一次会明显掉帧，按币种缓存住
const formatters = new Map<string, Intl.NumberFormat | null>();

/**
 * 固定用 zh-CN 排版：界面本来就是中文，显示不该跟着浏览器语言漂。
 *
 * 用默认的 `symbol` 而不是 `narrowSymbol`——同一屏经常混着多种币种，USD 显示成
 * `US$` 才不会和人民币的 `¥` 混作一团。不认识的币种返回 null，由调用方退回纯代码。
 */
function formatterFor(code: string): Intl.NumberFormat | null {
  const key = code.toUpperCase();
  if (!formatters.has(key)) {
    try {
      formatters.set(key, new Intl.NumberFormat("zh-CN", { style: "currency", currency: key }));
    } catch {
      formatters.set(key, null);
    }
  }
  return formatters.get(key) ?? null;
}

/** 金额 + 币种符号，例：`¥12.00`、`US$12.00`。 */
export function fmtMoney(amount: number, currency: string): string {
  const code = (currency || DEFAULT_CURRENCY).toUpperCase();
  const f = formatterFor(code);
  return f ? f.format(amount) : `${amount.toFixed(2)} ${code}`;
}
