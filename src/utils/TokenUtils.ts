import { constants, utils } from "@across-protocol/sdk";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumberish, utils as ethersUtils } from "ethers";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { L1Token } from "../interfaces";
const { ZERO_ADDRESS } = constants;
const tokens = {
  810181: {
    "0xA7ffF134e7C164e8E43C15099940e1e4fB0F83A9": {
      symbol: "WBTC",
      decimals: 18
    },
    "0x6cB06A7BeDb127163EfAB8d268f42a9915316A1F": {
      symbol: "USDC",
      decimals: 18
    }
  },
  421614: {
    "0x8d7b54AAc168585bdf8d7c7c34DD903CdAe388E8": {
      symbol: "WBTC",
      decimals: 18
    },
    "0xc6118f9FAFc657EBd36D167A50B46a1A9dA2D057": {
      symbol: "USDC",
      decimals: 18
    }
  }
};

export const { fetchTokenInfo } = utils;

export function getL2TokenAddresses(l1TokenAddress: string): { [chainId: number]: string } {
  return Object.values(TOKEN_SYMBOLS_MAP).find((details) => {
    return details.addresses[CHAIN_IDs.MAINNET] === l1TokenAddress;
  })?.addresses;
}

export function getEthAddressForChain(chainId: number): string {
  return CONTRACT_ADDRESSES[chainId]?.eth?.address ?? ZERO_ADDRESS;
}

export function getTokenInfo(l2TokenAddress: string, chainId: number): L1Token {
  // @dev This might give false positives if tokens on different networks have the same address. I'm not sure how
  // to get around this...
  // const tokenObject = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) => addresses[chainId] === l2TokenAddress);
  // if (!tokenObject) {
  //   throw new Error(
  //     `TokenUtils#getTokenInfo: Unable to resolve token in TOKEN_SYMBOLS_MAP for ${l2TokenAddress} on chain ${chainId}`
  //   );
  // }
  return {
    address: l2TokenAddress,
    // symbol: tokenObject.symbol,
    symbol: tokens[chainId][l2TokenAddress].symbol,
    // decimals: tokenObject.decimals,
    decimals: tokens[chainId][l2TokenAddress].decimals,
  };
}

export function getL1TokenInfo(l2TokenAddress: string, chainId: number): L1Token {
  const tokenObject = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) => addresses[chainId] === l2TokenAddress);
  const l1TokenAddress = tokenObject?.addresses[CHAIN_IDs.MAINNET];
  if (!l1TokenAddress) {
    throw new Error(
      `TokenUtils#getL1TokenInfo: Unable to resolve l1 token address in TOKEN_SYMBOLS_MAP for L2 token ${l2TokenAddress} on chain ${chainId}`
    );
  }
  return {
    address: l1TokenAddress,
    symbol: tokenObject.symbol,
    decimals: tokenObject.decimals,
  };
}

/**
 * Format the given amount of tokens to the correct number of decimals for the given token symbol.
 * @param symbol The token symbol to format the amount for.
 * @param amount The amount to format.
 * @returns The formatted amount as a decimal-inclusive string.
 */
export function formatUnitsForToken(symbol: string, amount: BigNumberish): string {
  const decimals = (TOKEN_SYMBOLS_MAP[symbol]?.decimals as number) ?? 18;
  return ethersUtils.formatUnits(amount, decimals);
}
