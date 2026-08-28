// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface ICitizenRegistry {
    function isCitizen(address account) external view returns (bool);
}

/// @title DelegationRegistry
/// @notice Standing per-topic delegations with timestamp checkpoints
///         (ERC20Votes pattern, ERC-6372 timestamp clock). Voting papers pin a
///         snapshot timestamp (their delegationEnd) and query state at exactly
///         that timepoint, so delegation changes after the snapshot apply from
///         the next paper onwards.
/// @dev    Inherits ERC2771Context: delegation changes ride the gasless
///         meta-transaction path. Every function resolves the voter through
///         _msgSender(), never msg.sender.
contract DelegationRegistry is ERC2771Context {
    using Checkpoints for Checkpoints.Trace208;

    uint8 public constant NUM_TOPICS = 8;

    ICitizenRegistry public immutable citizens;

    // voter => topic => checkpointed delegate (uint208(uint160(address)))
    mapping(address => mapping(uint8 => Checkpoints.Trace208)) private _delegates;
    // delegate => topic => checkpointed count of inbound delegations
    mapping(address => mapping(uint8 => Checkpoints.Trace208)) private _inbound;

    event DelegateChanged(address indexed voter, uint8 indexed topicId, address indexed toDelegate, address fromDelegate);

    constructor(address trustedForwarder, address citizenRegistry) ERC2771Context(trustedForwarder) {
        citizens = ICitizenRegistry(citizenRegistry);
    }

    /// @notice Delegate the caller's voting power for one topic (one hop).
    function setDelegate(uint8 topicId, address delegatee) external {
        address voter = _msgSender();
        require(topicId < NUM_TOPICS, "bad topic");
        require(citizens.isCitizen(voter), "not a citizen");
        require(citizens.isCitizen(delegatee), "delegate not a citizen");
        require(delegatee != voter, "self delegation");
        _setDelegate(voter, topicId, delegatee);
    }

    /// @notice Remove the caller's delegation for one topic.
    function clearDelegate(uint8 topicId) external {
        require(topicId < NUM_TOPICS, "bad topic");
        _setDelegate(_msgSender(), topicId, address(0));
    }

    function _setDelegate(address voter, uint8 topicId, address newDelegate) internal {
        address old = address(uint160(_delegates[voter][topicId].latest()));
        require(old != newDelegate, "unchanged");
        uint48 t = SafeCast.toUint48(block.timestamp);

        _delegates[voter][topicId].push(t, uint208(uint160(newDelegate)));
        if (old != address(0)) {
            uint208 c = _inbound[old][topicId].latest();
            _inbound[old][topicId].push(t, c - 1);
        }
        if (newDelegate != address(0)) {
            uint208 c = _inbound[newDelegate][topicId].latest();
            _inbound[newDelegate][topicId].push(t, c + 1);
        }
        emit DelegateChanged(voter, topicId, newDelegate, old);
    }

    // ---------------------------------------------------------------- views

    function delegateOf(address voter, uint8 topicId) external view returns (address) {
        return address(uint160(_delegates[voter][topicId].latest()));
    }

    function inboundWeight(address delegatee, uint8 topicId) external view returns (uint256) {
        return _inbound[delegatee][topicId].latest();
    }

    /// @notice Delegate of `voter` for `topicId` at `timepoint` (a past timestamp).
    function getPastDelegate(address voter, uint8 topicId, uint48 timepoint) external view returns (address) {
        require(timepoint < block.timestamp, "future lookup");
        return address(uint160(_delegates[voter][topicId].upperLookup(timepoint)));
    }

    /// @notice Number of inbound delegations of `delegatee` for `topicId` at `timepoint`.
    function getPastInboundWeight(address delegatee, uint8 topicId, uint48 timepoint) external view returns (uint256) {
        require(timepoint < block.timestamp, "future lookup");
        return _inbound[delegatee][topicId].upperLookup(timepoint);
    }
}
