import winston from "winston";
import { assert, ethers, isDefined } from "../utils";
import * as Constants from "./Constants";

export interface ProcessEnv {
  [key: string]: string | undefined;
}

export class CommonConfig {
  readonly hubPoolChainId: number;
  readonly pollingDelay: number;
  readonly ignoredAddresses: string[];
  readonly maxBlockLookBack: { [key: number]: number };
  readonly maxTxWait: number;
  readonly spokePoolChainsOverride: number[];
  readonly sendingTransactionsEnabled: boolean;
  readonly maxRelayerLookBack: number;
  readonly version: string;
  readonly blockRangeEndBlockBuffer: { [chainId: number]: number };
  readonly timeToCache: number;
  readonly spokePoolConfig: { [chainId: number]: {} };
  readonly fillTokens: { [chainId: number]: {} };
  readonly hubpoolTokens: { [chainId: number]: [] };
  readonly refundRecipient: string;
  readonly l2Recipient: string;
  readonly repaymentChainId: { [chainId: number]: number }; 

  // State we'll load after we update the config store client and fetch all chains we want to support.
  public multiCallChunkSize: { [chainId: number]: number } = {};
  public toBlockOverride: Record<number, number> = {};

  constructor(env: ProcessEnv) {
    const {
      MAX_RELAYER_DEPOSIT_LOOK_BACK,
      BLOCK_RANGE_END_BLOCK_BUFFER,
      IGNORED_ADDRESSES,
      HUB_CHAIN_ID,
      POLLING_DELAY,
      MAX_BLOCK_LOOK_BACK,
      MAX_TX_WAIT_DURATION,
      SEND_TRANSACTIONS,
      ACROSS_BOT_VERSION,
      HUB_POOL_TIME_TO_CACHE,
      SPOKE_POOL_CONFIG,
      FILL_TOKENS,
      REFUND_RECIPIENT,
      REPAYMENT_RECIPIENT,
      REPAYMENT_CHAINID
    } = env;

    this.version = ACROSS_BOT_VERSION ?? "unknown";

    this.timeToCache = Number(HUB_POOL_TIME_TO_CACHE ?? 60 * 60); // 1 hour by default.
    if (Number.isNaN(this.timeToCache) || this.timeToCache < 0) {
      throw new Error("Invalid default caching safe lag");
    }

    this.blockRangeEndBlockBuffer = BLOCK_RANGE_END_BLOCK_BUFFER
      ? JSON.parse(BLOCK_RANGE_END_BLOCK_BUFFER)
      : Constants.BUNDLE_END_BLOCK_BUFFERS;

    this.ignoredAddresses = JSON.parse(IGNORED_ADDRESSES ?? "[]").map((address) => ethers.utils.getAddress(address));

    // `maxRelayerLookBack` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxRelayerLookBack = Number(MAX_RELAYER_DEPOSIT_LOOK_BACK ?? Constants.MAX_RELAYER_DEPOSIT_LOOK_BACK);
    this.pollingDelay = Number(POLLING_DELAY ?? 60);
    this.maxBlockLookBack = MAX_BLOCK_LOOK_BACK ? JSON.parse(MAX_BLOCK_LOOK_BACK) : {};
    if (Object.keys(this.maxBlockLookBack).length === 0) {
      this.maxBlockLookBack = Constants.CHAIN_MAX_BLOCK_LOOKBACK;
    }
    this.maxTxWait = Number(MAX_TX_WAIT_DURATION ?? 180); // 3 minutes
    this.sendingTransactionsEnabled = SEND_TRANSACTIONS === "true";

    this.spokePoolConfig = JSON.parse(SPOKE_POOL_CONFIG);
    this.hubPoolChainId = Number(HUB_CHAIN_ID ?? (810180 in Object.keys(this.spokePoolConfig) ? 810180 : 810181));
    this.fillTokens = JSON.parse(FILL_TOKENS);
    this.hubpoolTokens = Object.keys(this.fillTokens).reduce(
      (hubpoolTokens, chainId) => {
        hubpoolTokens[chainId] = Object.keys(this.fillTokens[chainId]).reduce(
          (chainTokens, token) => {
            chainTokens.push({
              'address': token,
              'symbol': this.fillTokens[chainId][token]['symbol'],
              'decimals': this.fillTokens[chainId][token]['decimals']
            });
            return chainTokens;
          }, []
        );
        return hubpoolTokens;
      }, {}
    );
    this.spokePoolChainsOverride = Object.keys(this.spokePoolConfig).map(Number);
    
    this.refundRecipient = REFUND_RECIPIENT;
    this.l2Recipient = REPAYMENT_RECIPIENT;
    this.repaymentChainId = Object.keys(this.fillTokens).reduce(
      (repaymentChainId, chainId) => {
        let _repaymentChainId = process.env[`REPAYMENT_CHAINID_${chainId}`] ?? REPAYMENT_CHAINID;
        repaymentChainId[chainId] = Number(_repaymentChainId);
        if (isNaN(repaymentChainId[chainId])) {
          repaymentChainId[chainId] = (_repaymentChainId === "destination") ? Number(chainId) : 0;
        }
        if (repaymentChainId[chainId] != 0 && !(repaymentChainId[chainId] in this.fillTokens)) {
          throw new Error(`repayment chainid ${repaymentChainId[chainId]} is not supported`);
        }
        return repaymentChainId;
      }, {}
    );
  }

  /**
   * @notice Loads additional configuration state that can only be known after we know all chains that we're going to
   * support. Throws an error if any of the configurations are not valid.
   * @dev This should be called by passing in the latest chain ID indices from an updated ConfigStoreClient.
   * @throws If blockRangeEndBuffer doesn't include a key for each chain ID
   * @throws If maxBlockLookBack doesn't include a key for each chain ID
   * @throws If overridden MULTICALL_CHUNK_SIZE_CHAIN_${chainId} isn't greater than 0
   * @throws If overridden TO_BLOCK_OVERRIDE_${chainId} isn't greater than 0
   * @param chainIdIndices All expected chain ID's that could be supported by this config.
   */
  validate(chainIds: number[], logger: winston.Logger): void {
    // Warn about any missing MAX_BLOCK_LOOK_BACK config.
    const lookbackKeys = Object.keys(this.maxBlockLookBack).map(Number);
    if (lookbackKeys.length > 0) {
      const missing = chainIds.find((chainId) => !lookbackKeys.includes(chainId));
      if (missing) {
        const message = `Missing MAX_BLOCK_LOOK_BACK configuration for chainId ${missing}`;
        logger.warn({ at: "RelayerConfig::validate", message });
        this.maxBlockLookBack[missing] = 5000; // Revert to a safe default.
      }
    }

    // BLOCK_RANGE_END_BLOCK_BUFFER is important for the dataworker, so assert on it.
    const bufferKeys = Object.keys(this.blockRangeEndBlockBuffer).map(Number);
    if (bufferKeys.length > 0) {
      const missing = chainIds.find((chainId) => !bufferKeys.includes(chainId));
      assert(!missing, `Missing BLOCK_RANGE_END_BLOCK_BUFFER configuration for chainId ${missing}`);
    }

    for (const chainId of chainIds) {
      // Load any toBlock overrides.
      const toBlock = Number(process.env[`TO_BLOCK_OVERRIDE_${chainId}`]) || undefined;
      if (isDefined(toBlock)) {
        assert(toBlock > 0, `TO_BLOCK_OVERRIDE_${chainId} must be greater than 0`);
        this.toBlockOverride[chainId] = toBlock;
      }
    }
  }
}
