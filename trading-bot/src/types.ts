export interface Candle {
  /** open time in ms */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // volume in USD when known, else 0
}

export interface TokenMeta {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  isVerified?: boolean;
  organicScore?: number;
  organicScoreLabel?: string;
  holderCount?: number;
  liquidityUsd?: number;
  mcapUsd?: number;
  fdvUsd?: number;
  usdPrice?: number;
  tags?: string[];
  audit?: {
    isSus?: boolean;
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
  };
  firstPoolCreatedAt?: string;
  stats?: Partial<Record<'5m' | '1h' | '6h' | '24h', TokenWindowStats>>;
}

export interface TokenWindowStats {
  priceChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  liquidityChange?: number;
  holderChange?: number;
}

export interface PairInfo {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url?: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd: number;
  priceNative: number;
  liquidityUsd: number;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  volume: { m5: number; h1: number; h6: number; h24: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  boosted?: boolean;
  boostsActive?: number;
  socials?: number;
  hasWebsite?: boolean;
}

export type SignalAction = 'buy' | 'sell' | 'hold';

export interface Signal {
  action: SignalAction;
  /** 0..1 confidence */
  score: number;
  reasons: string[];
  strategy: string;
  indicators?: Record<string, number | undefined>;
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  decimals: number;
  /** raw token units held (bigint as string for storage) */
  amountRaw: string;
  /** SOL spent to open (net of fees) */
  costSol: number;
  /** average entry price in SOL per token */
  entryPriceSol: number;
  entryPriceUsd: number;
  openedAt: number;
  highWaterMarkSol: number;
  /** take profit rungs already executed */
  ladderDone: number;
  /** SOL realised from partial exits */
  realisedSol: number;
  strategy: string;
  status: 'open' | 'closed';
  closedAt?: number;
  closeReason?: string;
  /** stop distance in % chosen at entry (ATR-scaled); falls back to risk.stopLossPct */
  stopPct?: number;
  /** which rule set manages the exit */
  lane?: 'core' | 'launch';
}

export interface Trade {
  id?: number;
  positionId: string;
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  amountRaw: string;
  sol: number;
  priceSol: number;
  priceUsd: number;
  feeSol: number;
  signature?: string;
  reason: string;
  mode: 'paper' | 'live';
  ts: number;
  pnlSol?: number;
  /** price the quote promised (SOL per raw unit) */
  expectedPriceSol?: number;
  /** execution shortfall vs the quote in % (positive = worse than quoted) */
  slippagePct?: number;
  exitKind?: string;
}

export interface Fill {
  signature?: string;
  inputAmountRaw: bigint;
  outputAmountRaw: bigint;
  /** effective price in SOL per token */
  priceSol: number;
  feeSol: number;
  slippageBps?: number;
  priceImpactPct?: number;
  route?: string;
}

export interface RegimeStatus {
  ok: boolean;
  reason: string;
  solPrice?: number;
  solEma?: number;
  solChange1hPct?: number;
  checkedAt: number;
}

export interface HolderQuality {
  /** share of supply held by the top wallets, pools and program accounts excluded */
  topPctExPools: number;
  largestWalletPct: number;
  poolAccounts: number;
  /** wallets in the top list holding near-identical amounts (bundle signature) */
  bundled: number;
  /** top wallets with almost no SOL (throwaway / airdrop-farm wallets) */
  freshWallets: number;
  walletsAnalysed: number;
}

export interface LaunchCandidate {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  ageMinutes: number;
  score: number;
  reasons: string[];
  pair: PairInfo;
  token?: TokenMeta;
  holders?: HolderQuality;
  safetyScore: number;
  rejected?: string;
  discoveredAt: number;
}

export interface Candidate {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  source: string[];
  token?: TokenMeta;
  pair?: PairInfo;
  safetyScore: number;
  safetyReasons: string[];
  discoveredAt: number;
}

export interface SafetyResult {
  ok: boolean;
  score: number; // 0..100
  reasons: string[];
  hardFail: string[];
}
