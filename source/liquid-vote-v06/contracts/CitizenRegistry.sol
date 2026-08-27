// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @dev Minimal ERC-5192 (soulbound) interface.
interface IERC5192 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);

    function locked(uint256 tokenId) external view returns (bool);
}

/// @title CitizenRegistry
/// @notice One non-transferable voting-right token per citizen, minted by the
///         government (ISSUER_ROLE). This token is the eligibility trust root:
///         Sybil resistance is exactly as good as the issuance process.
contract CitizenRegistry is ERC721, AccessControl, IERC5192 {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    uint256 private _nextId = 1;
    mapping(address => uint256) public tokenIdOf;

    event CitizenIssued(address indexed citizen, uint256 indexed tokenId);
    event CitizenRevoked(address indexed citizen, uint256 indexed tokenId);

    constructor(address admin) ERC721("Citizen Voting Right", "CIVR") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
    }

    /// @notice Government mints exactly one token per citizen address.
    function issue(address to) external onlyRole(ISSUER_ROLE) returns (uint256 id) {
        require(to != address(0), "zero address");
        require(tokenIdOf[to] == 0, "already a citizen");
        id = _nextId++;
        tokenIdOf[to] = id;
        _mint(to, id);
        emit Locked(id);
        emit CitizenIssued(to, id);
    }

    /// @notice Government revokes eligibility (e.g. loss of citizenship).
    function revoke(address from) external onlyRole(ISSUER_ROLE) {
        uint256 id = tokenIdOf[from];
        require(id != 0, "not a citizen");
        delete tokenIdOf[from];
        _burn(id);
        emit CitizenRevoked(from, id);
    }

    function isCitizen(address account) external view returns (bool) {
        return tokenIdOf[account] != 0;
    }

    /// @dev ERC-5192: every token is permanently locked.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @dev Soulbound enforcement: only mint (from == 0) and burn (to == 0) pass.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        require(from == address(0) || to == address(0), "soulbound: non-transferable");
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return interfaceId == type(IERC5192).interfaceId || super.supportsInterface(interfaceId);
    }
}
