import { createLogger } from '../logger.js';
import type { TokenMeta, TokenWindowStats } from '../types.js';
import { RateLimiter, fetchJson } from '../utils.js';

const log = createLogger('jupiter');

/* ---------- Jupiter API response shapes (Ultra v1, Swap v1, Price v3, Tokens v2) ---------- */

export interface JupPrice {
  usdPrice: number;
  blockId?: number;
  decimals: number;
  liquidity?: number;
  priceChange24h?: number;
}

export interface JupTokenV2 {
  id: string;
  name: string;
  symbol: string;
  icon?: string | null;
  decimals: number;
  isVerified?: boolean | null;
  organicScore?: number;
  organicScoreLabel?: 'high' | 'medium' | 'low';
  usdPrice?: number | null;
  mcap?: number | null;
  fdv?: number | null;
  holderCount?: number | null;
  liquidity?: number | null;
  circSupply?: number | null;
  tags?: string[] | null;
  tokenProgram?: string;
  firstPool?: { id?: string; createdAt?: string } | null;
  audit?: {
    isSus?: boolean;
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
    devMints?: number;
  } | null;
  stats5m?: TokenWindowStats;
  stats1h?: TokenWindowStats;
  stats6h?: TokenWindowStats;
  stats24h?: TokenWindowStats;
}

export interface ShieldWarning {
  type: string;
  message?: string;
  severity?: 'info' | 'warning' | 'critical' | string;
}

export interface UltraOrderResponse {
  requestId: string;
  transaction: string | null;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps: number;
  priceImpactPct?: string | number;
  routePlan?: unknown[];
  router?: string;
  gasless?: boolean;
  feeBps?: number;
  errorCode?: number;
  errorMessage?: string;
  mode?: string;
}

export interface UltraExecuteResponse {
  status: 'Success' | 'Failed' | string;
  signature?: string;
  slot?: string | number;
  code?: number;
  error?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  swapEvents?: unknown[];
}

export interface SwapQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { swapInfo?: { label?: string } ; percent?: number }[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface SwapBuildResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  simulationError?: { error?: string; errorCode?: string } | null;
}

export type JupCategory = 'toptrending' | 'toporganicscore' | 'toptraded';

export class JupiterClient {
  readonly baseUrl: string;
  private headers: Record<string, string>;
  private limiter: RateLimiter;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.baseUrl = 'https://api.jup.ag';
      this.headers = { 'x-api-key': apiKey, accept: 'application/json' };
      this.limiter = new RateLimiter(55); // free tier: 60 rpm
    } else {
      this.baseUrl = 'https://lite-api.jup.ag';
      this.headers = { accept: 'application/json' };
      this.limiter = new RateLimiter(30);
      log.warn('No JUPITER_API_KEY set: using lite-api.jup.ag (being sunset, heavily rate limited). Get a free key at https://portal.jup.ag');
    }
  }

  private get<T>(path: string, timeoutMs = 15000): Promise<T> {
    return fetchJson<T>(`${this.baseUrl}${path}`, { headers: this.headers, limiter: this.limiter, timeoutMs });
  }

  private post<T>(path: string, body: unknown, timeoutMs = 30000): Promise<T> {
    return fetchJson<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      limiter: this.limiter,
      timeoutMs,
      retries: 0,
    });
  }

  /* ---------------- Price API v3 ---------------- */

  async getPrices(mints: string[]): Promise<Record<string, JupPrice>> {
    const out: Record<string, JupPrice> = {};
    for (let i = 0; i < mints.length; i += 50) {
      const batch = mints.slice(i, i + 50);
      const res = await this.get<Record<string, JupPrice | null>>(`/price/v3?ids=${batch.join(',')}`);
      for (const [k, v] of Object.entries(res)) if (v && typeof v.usdPrice === 'number') out[k] = v;
    }
    return out;
  }

  /* ---------------- Tokens API v2 ---------------- */

  async searchTokens(query: string): Promise<JupTokenV2[]> {
    return this.get<JupTokenV2[]>(`/tokens/v2/search?query=${encodeURIComponent(query)}`);
  }

  async getTokens(mints: string[]): Promise<JupTokenV2[]> {
    const out: JupTokenV2[] = [];
    for (let i = 0; i < mints.length; i += 100) {
      out.push(...(await this.searchTokens(mints.slice(i, i + 100).join(','))));
    }
    return out;
  }

  async getCategory(category: JupCategory, interval: '5m' | '1h' | '6h' | '24h', limit = 50): Promise<JupTokenV2[]> {
    return this.get<JupTokenV2[]>(`/tokens/v2/${category}/${interval}?limit=${Math.min(limit, 100)}`);
  }

  async getRecentTokens(): Promise<JupTokenV2[]> {
    return this.get<JupTokenV2[]>('/tokens/v2/recent');
  }

  /* ---------------- Ultra: Shield ---------------- */

  async shield(mints: string[]): Promise<Record<string, ShieldWarning[]>> {
    const out: Record<string, ShieldWarning[]> = {};
    for (let i = 0; i < mints.length; i += 50) {
      const batch = mints.slice(i, i + 50);
      const res = await this.get<{ warnings?: Record<string, ShieldWarning[]> }>(`/ultra/v1/shield?mints=${batch.join(',')}`);
      Object.assign(out, res.warnings ?? {});
    }
    return out;
  }

  /* ---------------- Ultra: order / execute ---------------- */

  async ultraOrder(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    taker: string;
    slippageBps?: number;
  }): Promise<UltraOrderResponse> {
    const q = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      taker: params.taker,
    });
    if (params.slippageBps && params.slippageBps > 0) q.set('slippageBps', String(params.slippageBps));
    const res = await this.get<UltraOrderResponse>(`/ultra/v1/order?${q.toString()}`, 20000);
    if (res.errorMessage || (res.errorCode && res.errorCode !== 0)) {
      throw new Error(`Ultra order error ${res.errorCode ?? ''}: ${res.errorMessage ?? 'unknown'}`);
    }
    if (!res.transaction) throw new Error('Ultra order returned no transaction (insufficient balance or unroutable)');
    return res;
  }

  async ultraExecute(signedTransactionBase64: string, requestId: string): Promise<UltraExecuteResponse> {
    return this.post<UltraExecuteResponse>('/ultra/v1/execute', { signedTransaction: signedTransactionBase64, requestId }, 90000);
  }

  async ultraBalances(address: string): Promise<Record<string, { amount: string; uiAmount: number; slot: number; isFrozen: boolean }>> {
    return this.get(`/ultra/v1/balances/${address}`);
  }

  /* ---------------- Swap API v1 (fallback engine) ---------------- */

  async swapQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    dynamicSlippage?: boolean;
  }): Promise<SwapQuoteResponse> {
    const q = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      slippageBps: String(params.slippageBps),
      swapMode: 'ExactIn',
      restrictIntermediateTokens: 'true',
    });
    if (params.dynamicSlippage) q.set('dynamicSlippage', 'true');
    return this.get<SwapQuoteResponse>(`/swap/v1/quote?${q.toString()}`);
  }

  async swapBuild(params: {
    quoteResponse: SwapQuoteResponse;
    userPublicKey: string;
    priorityLevel: 'medium' | 'high' | 'veryHigh';
    maxLamports: number;
    dynamicSlippage?: boolean;
  }): Promise<SwapBuildResponse> {
    return this.post<SwapBuildResponse>('/swap/v1/swap', {
      quoteResponse: params.quoteResponse,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: params.dynamicSlippage ?? false,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: params.priorityLevel,
          maxLamports: params.maxLamports,
          global: false,
        },
      },
    });
  }
}

export function toTokenMeta(t: JupTokenV2): TokenMeta {
  return {
    mint: t.id,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    isVerified: t.isVerified ?? undefined,
    organicScore: t.organicScore,
    organicScoreLabel: t.organicScoreLabel,
    holderCount: t.holderCount ?? undefined,
    liquidityUsd: t.liquidity ?? undefined,
    mcapUsd: t.mcap ?? undefined,
    fdvUsd: t.fdv ?? undefined,
    usdPrice: t.usdPrice ?? undefined,
    tags: t.tags ?? undefined,
    audit: t.audit ?? undefined,
    firstPoolCreatedAt: t.firstPool?.createdAt,
    stats: { '5m': t.stats5m, '1h': t.stats1h, '6h': t.stats6h, '24h': t.stats24h },
  };
}
