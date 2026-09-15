import type { BotConfig } from '../config.js';
import { holderPenalties } from '../analysis/holders.js';
import type { HolderQuality, PairInfo, TokenMeta } from '../types.js';

export interface LaunchScore {
  ok: boolean;
  score: number;
  reasons: string[];
  rejected?: string;
}

/**
 * Scores a brand-new token for the launch lane. There is no candle history yet, so this
 * reads the first minutes of tape: buyer pressure, liquidity depth, holder growth, holder
 * quality and whether the price has already run. Hard rejections come first.
 */
export function scoreLaunch(input: { pair: PairInfo; token?: TokenMeta; holders?: HolderQuality; ageMinutes: number; mintAuthorityOn?: boolean; freezeAuthorityOn?: boolean; shieldReject?: string }, cfg: BotConfig['launch']): LaunchScore {
  const { pair, token, holders, ageMinutes } = input;
  const reasons: string[] = [];
  const reject = (why: string): LaunchScore => ({ ok: false, score: 0, reasons, rejected: why });

  if (input.shieldReject) return reject(`shield: ${input.shieldReject}`);
  if (input.mintAuthorityOn) return reject('mint authority enabled');
  if (input.freezeAuthorityOn) return reject('freeze authority enabled');
  if (ageMinutes < cfg.minAgeMinutes) return reject(`too new (${ageMinutes.toFixed(1)}m < ${cfg.minAgeMinutes}m)`);
  if (ageMinutes > cfg.maxAgeMinutes) return reject(`too old for launch lane (${ageMinutes.toFixed(0)}m)`);
  if (pair.liquidityUsd < cfg.minLiquidityUsd) return reject(`liquidity $${Math.round(pair.liquidityUsd)} < $${cfg.minLiquidityUsd}`);
  if (pair.liquidityUsd > cfg.maxLiquidityUsd) return reject(`liquidity $${Math.round(pair.liquidityUsd)} above launch range`);
  const buys = pair.txns.m5.buys;
  const sells = pair.txns.m5.sells;
  if (buys < cfg.minBuys5m) return reject(`${buys} buys in 5m < ${cfg.minBuys5m}`);
  if (sells === 0 && buys >= 10) return reject('buys but zero sells (honeypot pattern)');
  const ratio = sells ? buys / sells : buys;
  if (ratio < cfg.minBuySellRatio5m) return reject(`buy/sell 5m ${ratio.toFixed(2)} < ${cfg.minBuySellRatio5m}`);
  if (pair.volume.m5 < cfg.minVolume5mUsd) return reject(`5m volume $${Math.round(pair.volume.m5)} < $${cfg.minVolume5mUsd}`);
  if (pair.priceChange.m5 > cfg.maxPriceChange5mPct) return reject(`already up ${pair.priceChange.m5.toFixed(0)}% in 5m`);
  const holderCount = token?.holderCount ?? 0;
  if (token?.holderCount !== undefined && holderCount < cfg.minHolders) return reject(`${holderCount} holders < ${cfg.minHolders}`);
  if (cfg.requireSocials && !(pair.socials || pair.hasWebsite)) return reject('no socials or website');
  let holderPenalty = 0;
  if (holders) {
    const hp = holderPenalties(holders, { maxTopHoldersPct: cfg.maxTopHoldersPct, maxBundledHolders: cfg.maxBundledHolders, maxFreshWallets: cfg.maxFreshWallets });
    if (hp.hardFail.length) return reject(hp.hardFail[0]);
    holderPenalty = hp.penalty / 100;
    reasons.push(...hp.reasons);
  }

  // --- scoring (0..1) ---
  const parts: { w: number; v: number; why: string }[] = [
    { w: 3, v: Math.min(1, (ratio - 1) / 1.5), why: `buy/sell 5m ${ratio.toFixed(2)}` },
    { w: 2, v: Math.min(1, buys / (cfg.minBuys5m * 3)), why: `${buys} buys in 5m` },
    { w: 2, v: Math.min(1, pair.volume.m5 / (cfg.minVolume5mUsd * 4)), why: `5m volume $${Math.round(pair.volume.m5)}` },
    { w: 1.5, v: Math.min(1, pair.liquidityUsd / (cfg.minLiquidityUsd * 4)), why: `liquidity $${Math.round(pair.liquidityUsd)}` },
    { w: 1.5, v: pair.priceChange.m5 > 0 && pair.priceChange.m5 < cfg.maxPriceChange5mPct / 2 ? 1 : pair.priceChange.m5 > 0 ? 0.4 : 0, why: `5m ${pair.priceChange.m5.toFixed(1)}%` },
    { w: 1, v: holderCount ? Math.min(1, holderCount / (cfg.minHolders * 5)) : 0.4, why: `${holderCount || '?'} holders` },
    { w: 1, v: (pair.socials ?? 0) > 0 || pair.hasWebsite ? 1 : 0, why: 'has socials' },
    { w: 1, v: pair.boostsActive ? Math.min(1, pair.boostsActive / 20) : 0, why: 'DexScreener boosts' },
    { w: 1, v: token?.organicScore !== undefined ? Math.min(1, token.organicScore / 60) : 0.3, why: `organic ${token?.organicScore?.toFixed(0) ?? '?'}` },
  ];
  let total = 0;
  let got = 0;
  for (const p of parts) {
    total += p.w;
    got += p.w * Math.max(0, Math.min(1, p.v));
    if (p.v >= 0.5) reasons.push(p.why);
  }
  const score = Math.max(0, got / total - holderPenalty);
  return { ok: score >= cfg.minScore, score, reasons };
}
