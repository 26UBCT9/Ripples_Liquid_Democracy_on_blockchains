// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @title MockSemaphore
/// @notice Test double for the canonical Semaphore v4 contract. It accepts any
///         proof but enforces nullifier uniqueness per group, which is the
///         property VoteController's logic depends on. Real Groth16
///         verification is exercised against the canonical deployment on
///         Sepolia (see README) and in the M2 frontend proving flow.
contract MockSemaphore {
    uint256 public groupCounter;
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed;
    mapping(uint256 => uint256) public memberCount;

    event GroupCreated(uint256 indexed groupId);
    event MemberAdded(uint256 indexed groupId, uint256 identityCommitment);

    function createGroup() external returns (uint256 groupId) {
        groupId = groupCounter++;
        emit GroupCreated(groupId);
    }

    function addMember(uint256 groupId, uint256 identityCommitment) external {
        require(groupId < groupCounter, "no group");
        memberCount[groupId] += 1;
        emit MemberAdded(groupId, identityCommitment);
    }

    function validateProof(uint256 groupId, ISemaphore.SemaphoreProof calldata proof) external {
        require(groupId < groupCounter, "no group");
        require(!nullifierUsed[groupId][proof.nullifier], "nullifier already used");
        nullifierUsed[groupId][proof.nullifier] = true;
    }
}
