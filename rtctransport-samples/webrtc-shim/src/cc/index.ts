// Congestion Control (CC) entry point.
//
// Public surface: the CongestionController contract, the algorithm identifier,
// and a factory that builds the selected controller. Algorithm implementations
// are isolated in sub-folders:
//   aimd/ - delay + loss based AIMD (the "simple" reference algorithm)
//   gcc/  - Google Congestion Control (trendline + loss based)

import {
  type CongestionController,
  type CongestionControlAlgorithm,
  type CongestionControllerOptions,
} from './congestion-controller';
import { AimdCongestionController } from './aimd';
import { GccCongestionController, type GccEstimate } from './gcc';

/**
 * Creates a congestion controller for the selected algorithm.
 */
export function createCongestionController(
    algorithm: CongestionControlAlgorithm,
    options: CongestionControllerOptions = {}): CongestionController {
  switch (algorithm) {
    case 'aimd':
      return new AimdCongestionController(options);
    case 'gcc':
      return new GccCongestionController(options);
  }
}

export type {
  CongestionController,
  CongestionControlAlgorithm,
  CongestionControllerOptions,
  GccEstimate,
};
