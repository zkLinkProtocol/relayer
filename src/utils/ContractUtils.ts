import { Contract, Signer } from ".";

import * as typechain from "@across-protocol/contracts"; // TODO: refactor once we've fixed export from contract repo

// Return an ethers contract instance for a deployed contract, imported from the Across-protocol contracts repo.
export function getMainSpokepoolContract(contractAddress: string, networkId: number, signer?: Signer): Contract {
  try {
    // If the contractName is SpokePool then we need to modify it to find the correct contract factory artifact.
    const artifact = typechain[`SpokePool__factory`];
    return new Contract(contractAddress, artifact.abi, signer);
  } catch (error) {
    throw new Error(`Could not find address for main spokepool contract on ${networkId}`);
  }
}

export function getParamType(contractName: string, functionName: string, paramName: string): string {
  const artifact = typechain[`${[contractName]}__factory`];
  const fragment = artifact.abi.find((fragment: { name: string }) => fragment.name === functionName);
  return fragment.inputs.find((input: { name: string }) => input.name === paramName) || "";
}
