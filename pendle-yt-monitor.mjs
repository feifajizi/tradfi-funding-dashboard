#!/usr/bin/env node
import { DEFAULT_WATCHLIST, analyzeTargets, parseMarketInput, scanHighYtMarkets, tableRow, formatPercent, formatUsd, formatNum } from './pendle-yt-core.mjs';

function argValue(name, fallback = null) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit === `--${name}`) return true;
  return hit.split('=').slice(1).join('=');
}

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const mode = positional[0] || 'default';
const minLiquidity = Number(argValue('min-liquidity', 100000));
const limit = Number(argValue('limit', 30));
const json = Boolean(argValue('json', false));

async function main() {
  let rows = [];
  if (mode === 'scan') {
    rows = await scanHighYtMarkets({ minLiquidity, limit });
  } else if (parseMarketInput(mode)) {
    rows = await analyzeTargets([parseMarketInput(mode)]);
  } else {
    const focus = await analyzeTargets(DEFAULT_WATCHLIST);
    const scan = await scanHighYtMarkets({ minLiquidity, limit });
    const seen = new Set();
    rows = [...focus, ...scan].filter(m => {
      const k = `${m.chainId}:${m.address}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  rows.sort((a, b) => (b.roi ?? -999) - (a.roi ?? -999));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.table(rows.map(tableRow));
  for (const m of rows) {
    console.log('\n' + '='.repeat(96));
    console.log(`${m.name} | ${m.chain} | ${m.address}`);
    console.log(`Expiry: ${m.expiryDate} (${m.daysToExpiry.toFixed(1)} 天) | Verdict: ${m.verdict}`);
    console.log(`YT cost: ${formatUsd(m.ytCost, 6)} | underlyingOnlyReturn: ${formatUsd(m.underlyingOnlyReturn, 6)} | rewardReturn: ${formatUsd(m.rewardReturn, 6)} | totalExpectedReturn: ${formatUsd(m.totalExpectedReturn, 6)}`);
    console.log(`profit: ${formatUsd(m.profit, 6)} | ROI: ${formatPercent(m.roi)} | breakeven underlying APY: ${formatPercent(m.breakevenUnderlyingApy)}`);
    console.log(`不算奖励: ${m.noRewardProfitable ? '赚钱' : '亏钱'} | 算当前奖励: ${m.withRewardProfitable ? '赚钱' : '亏钱'} | Reward to maturity: ${m.rewardToMaturity ? 'yes' : 'no'}`);
    if (m.rewardApyAtTvlUp) {
      console.log(`TVL 增加、奖励不变后的 reward APY：+25% TVL=${formatPercent(m.rewardApyAtTvlUp.plus25)}, +50% TVL=${formatPercent(m.rewardApyAtTvlUp.plus50)}, +100% TVL=${formatPercent(m.rewardApyAtTvlUp.plus100)}`);
    }
    if (m.rewardItems.length) {
      console.table(m.rewardItems.map(r => ({ token: r.token, apy: formatPercent(r.apy), weeklyAmount: formatNum(r.weeklyAmount, 2), endDate: r.endDate || '-', source: r.source || '-' })));
    }
    console.log('原始 API 关键字段：');
    console.log(JSON.stringify(m.rawKeyFields, null, 2).slice(0, 5000));
    console.log('结论：' + m.conclusion);
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
