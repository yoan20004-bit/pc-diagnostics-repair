import type { ScannerFilters } from '../config.js';
import type { MintInfo } from '../rpc.js';
import type { ShieldWarning } from '../market/jupiter.js';
import type { PairInfo, SafetyResult, TokenMeta } from '../types.js';

const DANGEROUS_2022_EXTENSIONS = new Set(['transferFeeConfig', 'permanentDelegate', 'transferHook', 'defaultAccountState', 'nonTransferable']);

export interface SafetyInput {
  mint: string;
  token?: TokenMeta;
  pair?: PairInfo;
  mintInfo?: MintInfo;
  holderShare?: { topPct: number; largestPct: number };
  shieldWarnings?: ShieldWarning[];
}

/**
 * Scores how safe a token looks to trade. Hard fails block trading regardless of score.
 * This is a heuristic rug/honeypot filter, not a guarantee.
 */
export function assessSafety(input: SafetyInput, f: ScannerFilters): SafetyResult {
  const reasons: string[] = [];
  const hardFail: string[] = [];
  let score = 100;
  const { token, pair, mintInfo, holderShare, shieldWarnings } = input;

  // --- on-chain authorities -------------------------------------------------
  const mintAuthOn = mintInfo ? mintInfo.mintAuthority !== null : token?.audit?.mintAuthorityDisabled === false;
  const freezeAuthOn = mintInfo ? mintInfo.freezeAuthority !== null : token?.audit?.freezeAuthorityDisabled === false;
  if (mintAuthOn) {
    if (f.requireMintAuthorityDisabled) hardFail.push('mint authority still enabled (supply can be inflated)');
    else {
      score -= 25;
      reasons.push('mint authority enabled');
    }
  }
  if (freezeAuthOn) {
    if (f.requireFreezeAuthorityDisabled) hardFail.push('freeze authority still enabled (your tokens can be frozen)');
    else {
      score -= 25;
      reasons.push('freeze authority enabled');
    }
  }
  if (mintInfo?.program === 'token2022') {
    const bad = (mintInfo.extensions ?? []).filter((e) => DANGEROUS_2022_EXTENSIONS.has(e));
    if (bad.length) hardFail.push(`Token-2022 with risky extensions: ${bad.join(', ')}`);
    else if (!f.allowToken2022) hardFail.push('Token-2022 mint (allowToken2022=false)');
    else {
      score -= 10;
      reasons.push('Token-2022 mint');
    }
  }
  if (mintInfo?.program === 'unknown') hardFail.push('mint is not owned by a known token program');

  // --- Jupiter Shield -------------------------------------------------------
  for (const w of shieldWarnings ?? []) {
    const type = (w.type || '').toUpperCase();
    if (f.rejectShieldWarnings.map((x) => x.toUpperCase()).includes(type)) hardFail.push(`shield: ${type}`);
    else if (w.severity === 'critical') hardFail.push(`shield critical: ${type}`);
    else if (w.severity === 'warning') {
      score -= 10;
      reasons.push(`shield: ${type}`);
    } else {
      score -= 3;
      reasons.push(`shield info: ${type}`);
    }
  }
  if (token?.audit?.isSus) hardFail.push('Jupiter flags token as suspicious');

  // --- liquidity / activity -------------------------------------------------
  const liq = pair?.liquidityUsd ?? token?.liquidityUsd ?? 0;
  if (liq < f.minLiquidityUsd) hardFail.push(`liquidity $${Math.round(liq)} < min $${f.minLiquidityUsd}`);
  else if (liq < f.minLiquidityUsd * 2) {
    score -= 8;
    reasons.push('thin liquidity');
  }

  const vol24 = pair?.volume.h24 ?? sumVol(token?.stats?.['24h']);
  if (vol24 < f.minVolume24hUsd) {
    score -= 15;
    reasons.push(`24h volume $${Math.round(vol24)} below target`);
  }
  if (liq > 0 && vol24 / liq > 25) {
    score -= 10;
    reasons.push('volume/liquidity ratio extreme (possible wash trading)');
  }

  const mcap = token?.mcapUsd ?? pair?.marketCap ?? pair?.fdv ?? 0;
  if (mcap && mcap < f.minMarketCapUsd) {
    score -= 15;
    reasons.push(`market cap $${Math.round(mcap)} below min`);
  }
  if (mcap && mcap > f.maxMarketCapUsd) {
    score -= 5;
    reasons.push('market cap above max (low volatility target)');
  }

  // --- age ------------------------------------------------------------------
  const createdMs = pair?.pairCreatedAt ?? (token?.firstPoolCreatedAt ? Date.parse(token.firstPoolCreatedAt) : undefined);
  if (createdMs) {
    const ageH = (Date.now() - createdMs) / 3_600_000;
    if (ageH < f.minAgeHours) hardFail.push(`token age ${ageH.toFixed(1)}h < min ${f.minAgeHours}h`);
    else if (ageH < f.minAgeHours * 3) {
      score -= 5;
      reasons.push('young token');
    }
  } else {
    score -= 5;
    reasons.push('unknown age');
  }

  // --- holders / distribution ----------------------------------------------
  if (token?.holderCount !== undefined) {
    if (token.holderCount < f.minHolders) {
      score -= 15;
      reasons.push(`${token.holderCount} holders < min ${f.minHolders}`);
    }
  }
  const topPct = holderShare?.topPct ?? token?.audit?.topHoldersPercentage;
  if (topPct !== undefined && topPct > f.maxTopHoldersPct) {
    score -= 20;
    reasons.push(`top holders own ${topPct.toFixed(1)}% (> ${f.maxTopHoldersPct}%)`);
  }
  if (holderShare && holderShare.largestPct > 30) {
    score -= 15;
    reasons.push(`single account holds ${holderShare.largestPct.toFixed(1)}%`);
  }
  if (token?.audit?.devBalancePercentage !== undefined && token.audit.devBalancePercentage > 15) {
    score -= 10;
    reasons.push(`dev holds ${token.audit.devBalancePercentage.toFixed(1)}%`);
  }

  // --- organic activity -----------------------------------------------------
  if (token?.organicScore !== undefined) {
    if (token.organicScore < f.minOrganicScore) {
      score -= 15;
      reasons.push(`organic score ${token.organicScore.toFixed(0)} < ${f.minOrganicScore}`);
    } else if (token.organicScore > 70) score += 5;
  }
  if (token?.isVerified) score += 5;

  // --- momentum sanity ------------------------------------------------------
  const h1 = pair?.priceChange.h1 ?? token?.stats?.['1h']?.priceChange;
  if (h1 !== undefined && h1 > f.maxPriceChange1hPct) {
    score -= 15;
    reasons.push(`already up ${h1.toFixed(0)}% in 1h (chasing risk)`);
  }
  const buys = pair?.txns.h1.buys ?? token?.stats?.['1h']?.numBuys;
  const sells = pair?.txns.h1.sells ?? token?.stats?.['1h']?.numSells;
  if (buys !== undefined && sells !== undefined) {
    if (sells === 0 && buys > 20) hardFail.push('buys but zero sells in 1h (possible honeypot)');
    else if (sells > 0 && buys / sells < f.minBuySellRatio1h) {
      score -= 10;
      reasons.push(`buy/sell ratio 1h ${(buys / sells).toFixed(2)} < ${f.minBuySellRatio1h}`);
    }
  }

  score = Math.max(0, Math.min(100, score));
  return { ok: hardFail.length === 0 && score >= 50, score, reasons, hardFail };
}

function sumVol(s?: { buyVolume?: number; sellVolume?: number }) {
  return (s?.buyVolume ?? 0) + (s?.sellVolume ?? 0);
}
