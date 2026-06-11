const API = 'https://api-v2.pendle.finance/core';

export const CHAIN_NAMES = {
  1: 'ethereum', 10: 'optimism', 56: 'bsc', 100: 'gnosis', 137: 'polygon', 146: 'sonic',
  42161: 'arbitrum', 43114: 'avalanche', 8453: 'base', 5000: 'mantle', 80094: 'berachain',
};

export const DEFAULT_WATCHLIST = [
  { chainId: 1, address: '0x45252f9a932910abc436644f0b29f5531f0eb4cc', label: 'sUSDD' },
  { chainId: 1, address: '0x9c560ebaf78e596cbcc27411d633a74d628dd7dc', label: 'Sky sUSDS' },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pctRaw = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const isoDay = d => d ? new Date(d).toISOString().slice(0, 10) : null;
const nowMs = () => Date.now();
const daysBetween = (a, b) => (new Date(a).getTime() - new Date(b).getTime()) / 86400000;

export function parseMarketInput(input, fallbackChainId = 1) {
  if (!input) return null;
  const value = String(input).trim();
  const addr = value.match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase();
  if (!addr) return null;
  const chainText = value.match(/[?&]chain=([^&]+)/i)?.[1]?.toLowerCase();
  const chainIdText = value.match(/[?&]chainId=(\d+)/i)?.[1];
  const chainId = chainIdText ? Number(chainIdText) : chainNameToId(chainText) || fallbackChainId;
  return { address: addr, chainId };
}

export function chainNameToId(name) {
  if (!name) return null;
  const found = Object.entries(CHAIN_NAMES).find(([, v]) => v.toLowerCase() === String(name).toLowerCase());
  return found ? Number(found[0]) : null;
}

async function fetchJson(path, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Pendle API ${res.status}: ${url}`);
  return res.json();
}

export async function fetchMarketsAll({ chainId = null, limit = 100, includeExpired = true } = {}) {
  const out = [];
  let skip = 0;
  while (true) {
    const data = await fetchJson('/v2/markets/all', { chainId, limit, skip });
    out.push(...(data.results || []));
    skip += data.limit || limit;
    if (skip >= (data.total || 0) || !(data.results || []).length) break;
    await sleep(80);
  }
  return includeExpired ? out : out.filter(m => new Date(m.expiry).getTime() > nowMs());
}

export async function fetchMarketV1(chainId, address) {
  return fetchJson(`/v1/${chainId}/markets/${address.toLowerCase()}`);
}

function shortId(id) {
  if (!id) return '-';
  const s = String(id);
  const addr = s.match(/0x[a-fA-F0-9]{40}/)?.[0];
  if (addr) return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return s;
}

function tokenSymbolFromId(id, detail) {
  const all = [detail?.accountingAsset, detail?.underlyingAsset, detail?.basePricingAsset, ...(detail?.rewardTokens || []), ...(detail?.inputTokens || []), ...(detail?.outputTokens || [])].filter(Boolean);
  const token = all.find(t => t.id === id || t.address?.toLowerCase?.() === String(id).split('-').pop()?.toLowerCase?.());
  return token?.symbol || shortId(id);
}

function breakdownCategories(v2) {
  return v2?.ytApyBreakdown?.categories || [];
}

function sumCategory(v2, matcher) {
  return breakdownCategories(v2).filter(c => matcher(c.label || '')).reduce((a, c) => a + pctRaw(c.apy), 0);
}

function flattenRewardItems(v2, detail) {
  const items = [];
  for (const cat of breakdownCategories(v2)) {
    const isRewardCat = /reward|bonus|extra/i.test(cat.label || '');
    for (const item of (cat.items || [])) {
      const isRewardItem = isRewardCat || (item.tags || []).some(t => /reward|incentive/i.test(t));
      if (!isRewardItem) continue;
      const campaign = item.campaignDetail || item.portalExtData || {};
      const start = campaign.startTimestamp || campaign.start || null;
      const end = campaign.endTimestamp || campaign.end || null;
      const amount = Number(campaign.amount);
      const durDays = start && end ? Math.max(daysBetween(end, start), 0) : null;
      items.push({
        token: tokenSymbolFromId(item.id, detail),
        tokenId: item.id,
        apy: pctRaw(item.apy),
        source: item.source || '',
        amount: Number.isFinite(amount) ? amount : null,
        weeklyAmount: Number.isFinite(amount) && durDays ? amount / durDays * 7 : null,
        startDate: isoDay(start),
        endDate: isoDay(end),
        raw: item,
      });
    }
  }
  // v2 sometimes exposes reward dates only here
  for (const r of (v2?.underlyingRewardApyBreakdown || [])) {
    const ext = r.portalExtData || {};
    if (!ext.endTimestamp) continue;
    if (items.some(x => x.tokenId === r.asset && x.endDate === isoDay(ext.endTimestamp))) continue;
    const durDays = ext.startTimestamp && ext.endTimestamp ? Math.max(daysBetween(ext.endTimestamp, ext.startTimestamp), 0) : null;
    items.push({
      token: tokenSymbolFromId(r.asset, detail), tokenId: r.asset, apy: pctRaw(r.absoluteApy), source: r.source || '',
      amount: Number.isFinite(Number(ext.amount)) ? Number(ext.amount) : null,
      weeklyAmount: Number.isFinite(Number(ext.amount)) && durDays ? Number(ext.amount) / durDays * 7 : null,
      startDate: isoDay(ext.startTimestamp), endDate: isoDay(ext.endTimestamp), raw: r,
    });
  }
  return items;
}

function fixedApy(v2) {
  const cats = v2?.lpApyBreakdown?.categories || [];
  const found = cats.find(c => /fixed|pt/i.test(c.label || ''));
  return pctRaw(found?.apy ?? v2?.details?.impliedApy);
}

function rawKeyFields(v2, detail) {
  return {
    v2: {
      name: v2?.name, address: v2?.address, chainId: v2?.chainId, expiry: v2?.expiry,
      rewardTokens: v2?.rewardTokens, details: v2?.details,
      underlyingRewardApyBreakdown: v2?.underlyingRewardApyBreakdown,
      ytApyBreakdown: v2?.ytApyBreakdown,
      lpApyBreakdown: v2?.lpApyBreakdown,
    },
    v1: {
      name: detail?.name, address: detail?.address, chainId: detail?.chainId, expiry: detail?.expiry,
      ptPriceUsd: detail?.pt?.price?.usd, ytPriceUsd: detail?.yt?.price?.usd,
      accountingAsset: detail?.accountingAsset,
      underlyingAsset: detail?.underlyingAsset,
      rewardTokens: detail?.rewardTokens,
      liquidity: detail?.liquidity,
      ytRoi: detail?.ytRoi,
      ytFloatingApy: detail?.ytFloatingApy,
      impliedApy: detail?.impliedApy,
      underlyingApy: detail?.underlyingApy,
    }
  };
}

export function analyzeMarket(v2, detail, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const expiry = new Date(v2?.expiry || detail?.expiry);
  const daysToExpiry = Math.max((expiry.getTime() - now.getTime()) / 86400000, 0);
  const d = v2?.details || {};
  const rewardItems = flattenRewardItems(v2, detail);
  const rewardApy = rewardItems.reduce((a, x) => a + pctRaw(x.apy), 0);
  const protocolYieldApy = sumCategory(v2, label => /protocol|underlying/i.test(label)) || pctRaw(d.underlyingApy ?? detail?.underlyingApy);
  const underlyingApy = pctRaw(d.underlyingApy ?? detail?.underlyingApy ?? protocolYieldApy);
  const ytCost = pctRaw(detail?.yt?.price?.usd) || Math.max(0, pctRaw(detail?.underlyingAsset?.price?.usd) - pctRaw(detail?.pt?.price?.usd));
  const accountingUsd = pctRaw(detail?.accountingAsset?.price?.usd) || 1;
  const underlyingOnlyReturn = underlyingApy * daysToExpiry / 365 * accountingUsd;
  const rewardReturn = rewardItems.reduce((sum, item) => {
    const endMs = item.endDate ? new Date(item.endDate).getTime() : expiry.getTime();
    const effectiveDays = Math.max(Math.min(expiry.getTime(), endMs) - now.getTime(), 0) / 86400000;
    return sum + pctRaw(item.apy) * effectiveDays / 365 * accountingUsd;
  }, 0);
  const totalExpectedReturn = underlyingOnlyReturn + rewardReturn;
  const profit = totalExpectedReturn - ytCost;
  const roi = ytCost > 0 ? profit / ytCost : null;
  const breakevenUnderlyingApy = daysToExpiry > 0 ? ytCost / accountingUsd / daysToExpiry * 365 : null;
  const rewardEndDates = rewardItems.map(x => x.endDate).filter(Boolean).sort();
  const rewardEndDate = rewardEndDates[0] || null;
  const rewardToMaturity = rewardItems.length > 0 && rewardItems.every(x => !x.endDate || new Date(x.endDate).getTime() >= expiry.getTime());
  const activeReward = rewardItems.some(x => !x.endDate || new Date(x.endDate).getTime() >= now.getTime());
  const noRewardProfit = underlyingOnlyReturn - ytCost;
  const rewardApyAtTvlUp = pctRaw(d.totalTvl) > 0 ? {
    plus25: rewardApy / 1.25,
    plus50: rewardApy / 1.5,
    plus100: rewardApy / 2,
  } : null;
  const market = {
    name: v2?.name || detail?.underlyingAsset?.symbol || detail?.name || 'Unknown',
    chain: CHAIN_NAMES[v2?.chainId || detail?.chainId] || `chain-${v2?.chainId || detail?.chainId}`,
    chainId: v2?.chainId || detail?.chainId,
    address: (v2?.address || detail?.address || '').toLowerCase(),
    expiryDate: isoDay(expiry),
    daysToExpiry,
    tvl: pctRaw(d.totalTvl ?? detail?.liquidity),
    liquidity: pctRaw(d.liquidity ?? detail?.liquidity),
    ptPrice: pctRaw(detail?.pt?.price?.usd),
    ytPrice: pctRaw(detail?.yt?.price?.usd),
    impliedApy: pctRaw(d.impliedApy ?? detail?.impliedApy),
    underlyingApy,
    fixedApy: fixedApy(v2),
    ytFloatingApy: pctRaw(d.ytFloatingApy ?? detail?.ytFloatingApy),
    pendleYtRoi: pctRaw(d.ytRoi ?? detail?.ytRoi),
    rewardApy,
    rewardItems,
    hasYtRewards: rewardItems.length > 0,
    rewardTokens: [...new Set(rewardItems.map(x => x.token))],
    rewardEndDate,
    rewardToMaturity,
    activeReward,
    ytCost,
    underlyingOnlyReturn,
    rewardReturn,
    totalExpectedReturn,
    profit,
    roi,
    breakevenUnderlyingApy,
    noRewardProfit,
    noRewardProfitable: noRewardProfit >= 0,
    withRewardProfitable: profit >= 0,
    rewardApyAtTvlUp,
    rawKeyFields: rawKeyFields(v2, detail),
  };
  market.verdict = verdict(market);
  market.conclusion = conclusion(market);
  return market;
}

function verdict(m) {
  if (m.daysToExpiry <= 7 || m.liquidity < 10000 || m.roi === null) return '不建议';
  if (!m.withRewardProfitable) return '不建议';
  if (m.hasYtRewards && !m.rewardToMaturity) return '靠奖励';
  if (m.rewardApy > m.underlyingApy * 0.8) return '靠奖励';
  if (m.roi >= 0.3 && m.liquidity >= 100000) return '划算';
  return '风险高';
}

function conclusion(m) {
  const a = m.noRewardProfitable ? '不算奖励也有正收益' : '不算奖励会亏';
  const b = m.withRewardProfitable ? '按当前奖励估算为正收益' : '按当前奖励估算仍亏';
  const c = m.rewardToMaturity ? '奖励覆盖到期' : '奖励早于到期结束';
  return `这个 YT ${a}，${b}；当前主要${m.rewardApy > 0 ? '需要拆开看底层收益和奖励' : '看底层收益'}，${c}，如果奖励提前结束或 TVL 继续涨，实际 ROI 会明显下降。`;
}

export async function analyzeTargets(targets = DEFAULT_WATCHLIST) {
  const all = await fetchMarketsAll({ includeExpired: false });
  const byKey = new Map(all.map(m => [`${m.chainId}:${m.address.toLowerCase()}`, m]));
  const out = [];
  for (const t of targets) {
    const parsed = typeof t === 'string' ? parseMarketInput(t) : t;
    if (!parsed) continue;
    const key = `${parsed.chainId || 1}:${parsed.address.toLowerCase()}`;
    const v2 = byKey.get(key) || (await fetchMarketsAll({ chainId: parsed.chainId || 1, includeExpired: false })).find(m => m.address.toLowerCase() === parsed.address.toLowerCase());
    if (!v2) continue;
    const detail = await fetchMarketV1(v2.chainId, v2.address);
    out.push(analyzeMarket(v2, detail));
    await sleep(120);
  }
  return out;
}

export async function scanHighYtMarkets(options = {}) {
  const minLiquidity = Number(options.minLiquidity ?? 100000);
  const minDays = Number(options.minDays ?? 7);
  const minYtRoi = Number(options.minYtRoi ?? 0.30);
  const minFloatingApy = Number(options.minFloatingApy ?? 1.00);
  const now = new Date();
  const all = await fetchMarketsAll({ includeExpired: false });
  const candidates = all.filter(m => {
    const d = m.details || {};
    const days = daysBetween(m.expiry, now);
    const rewards = flattenRewardItems(m, {});
    const activeReward = rewards.some(x => !x.endDate || new Date(x.endDate).getTime() >= now.getTime());
    return days > minDays && pctRaw(d.liquidity) >= minLiquidity && pctRaw(d.ytRoi) > minYtRoi && pctRaw(d.ytFloatingApy) > minFloatingApy && activeReward;
  }).sort((a, b) => pctRaw(b.details?.ytRoi) - pctRaw(a.details?.ytRoi));
  const limit = Number(options.limit ?? 30);
  const out = [];
  for (const m of candidates.slice(0, limit)) {
    try {
      const detail = await fetchMarketV1(m.chainId, m.address);
      out.push(analyzeMarket(m, detail));
      await sleep(120);
    } catch (e) {
      console.warn(`skip ${m.chainId}:${m.address} ${e.message}`);
    }
  }
  return out;
}

export function formatPercent(v, digits = 2) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '-' : `${(Number(v) * 100).toFixed(digits)}%`;
}

export function formatUsd(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  return `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}

export function formatNum(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function tableRow(m) {
  return {
    Market: `${m.name} (${m.chain})`,
    Expiry: m.expiryDate,
    'Days left': Number(m.daysToExpiry.toFixed(1)),
    TVL: formatUsd(m.tvl, 0),
    Liquidity: formatUsd(m.liquidity, 0),
    'YT price': formatUsd(m.ytPrice, 4),
    'Underlying APY': formatPercent(m.underlyingApy),
    'Implied APY': formatPercent(m.impliedApy),
    'YT Rewards APY': formatPercent(m.rewardApy),
    'YT ROI': formatPercent(m.roi),
    'Pendle ROI': formatPercent(m.pendleYtRoi),
    'Reward end': m.rewardEndDate || '-',
    'Reward to maturity': m.rewardToMaturity ? 'yes' : 'no',
    'Breakeven APY': formatPercent(m.breakevenUnderlyingApy),
    Verdict: m.verdict,
  };
}
