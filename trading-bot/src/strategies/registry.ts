import type { BotConfig } from '../config.js';
import { BreakoutStrategy } from './breakout.js';
import { CompositeStrategy } from './composite.js';
import { MeanReversionStrategy } from './meanReversion.js';
import { MomentumStrategy } from './momentum.js';
import type { Strategy } from './base.js';

export function createStrategy(name: BotConfig['strategy']['name']): Strategy {
  switch (name) {
    case 'momentum':
      return new MomentumStrategy();
    case 'meanReversion':
      return new MeanReversionStrategy();
    case 'breakout':
      return new BreakoutStrategy();
    case 'composite':
    default:
      return new CompositeStrategy();
  }
}

export type { Strategy, StrategyContext } from './base.js';
