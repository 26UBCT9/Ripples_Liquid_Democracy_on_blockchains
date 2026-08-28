// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/// @title Forwarder
/// @notice Thin deployable wrapper around OpenZeppelin's ERC2771Forwarder so
///         the artifact (ABI) is available to the frontend and relayer.
contract Forwarder is ERC2771Forwarder {
    constructor(string memory name) ERC2771Forwarder(name) {}
}
