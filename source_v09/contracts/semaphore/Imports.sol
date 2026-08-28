// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Forces Hardhat to compile the canonical Semaphore v4 stack so the local
// deployment can run the real protocol (M2): Groth16 verifier + Poseidon
// hashed LeanIMT groups. On public networks the canonical deployment is used
// instead (SEMAPHORE_ADDRESS).
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
