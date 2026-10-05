// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 H2O.ai, Inc.
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MarinaLicense: licence tokens for Marina artifacts (worlds, memory packs)
/// @notice A minimal, chain-agnostic ERC-1155 licence registry. One deployment per
///         publisher, on whichever EVM chain the publisher chooses. Nothing here is
///         specific to any chain, and nothing here is a currency: a balance >= 1 of a
///         licence id means "this address is licensed for this artifact tier".
///
/// Design notes
/// - Token id = uint256(keccak256(bytes(artifactId) ++ 0x00 ++ bytes(tier))).
///   Marina computes the same id off-chain (`licenseTokenId` in `src/chain/evm.ts`)
///   and verifies with a read-only `balanceOf`.
/// - PAYMENTS ARE NOT HERE. The issue hook is `issue()`, callable by any account
///   holding ISSUER_ROLE: the publisher, an external checkout service, or a separate
///   marketplace contract that took payment in an existing asset on this same chain.
///   This contract never receives, holds or moves funds (no payable functions).
/// - Licence terms visible to buyers are fixed when a licence is defined:
///   `transferable` (can holders resell or give it away?) and `revocable` (may the
///   publisher burn it, e.g. after a refund?). Neither can change later.
/// - Provenance: `anchorArtifact` records the sha256 of an artifact version's
///   canonical manifest once; it can never be overwritten.
contract MarinaLicense is ERC1155, AccessControl {
    /// Defines licences and anchors artifacts.
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    /// Issues licences (the payment hook: checkout service or marketplace contract).
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    struct License {
        bool exists;
        bool transferable;
        bool revocable;
    }

    /// Licence id => terms.
    mapping(uint256 id => License) public licenses;
    /// anchorKey(artifactId, version) => sha256 of the canonical manifest.
    mapping(bytes32 key => bytes32 digest) public anchors;

    event LicenseDefined(
        uint256 indexed id, string artifactId, string tier, bool transferable, bool revocable
    );
    event LicenseIssued(uint256 indexed id, address indexed to, uint256 amount, bytes32 orderRef);
    event LicenseRevoked(uint256 indexed id, address indexed from, uint256 amount, bytes32 reason);
    event ArtifactAnchored(bytes32 indexed key, string artifactId, string version, bytes32 digest);

    error UnknownLicense(uint256 id);
    error LicenseAlreadyDefined(uint256 id);
    error NotTransferable(uint256 id);
    error NotRevocable(uint256 id);
    error AlreadyAnchored(bytes32 key);
    error InvalidIdentifier();

    /// @param admin Receives DEFAULT_ADMIN_ROLE, PUBLISHER_ROLE and ISSUER_ROLE. Use the
    ///        publisher's own wallet (ideally a multisig); Marina never holds this key.
    /// @param uri_ ERC-1155 metadata URI template (may be empty).
    constructor(address admin, string memory uri_) ERC1155(uri_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PUBLISHER_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
    }

    /// Licence id for an artifact tier. Pure: identical on every chain.
    function licenseId(string calldata artifactId, string calldata tier)
        public
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encodePacked(artifactId, bytes1(0), tier)));
    }

    /// Anchor key for an artifact version. Pure: identical on every chain.
    function anchorKey(string calldata artifactId, string calldata version)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(artifactId, bytes1(0), version));
    }

    /// Define the licence for one paid tier of an artifact. Terms are immutable.
    function defineLicense(
        string calldata artifactId,
        string calldata tier,
        bool transferable,
        bool revocable
    ) external onlyRole(PUBLISHER_ROLE) returns (uint256 id) {
        if (bytes(artifactId).length == 0 || bytes(tier).length == 0) {
            revert InvalidIdentifier();
        }
        id = licenseId(artifactId, tier);
        if (licenses[id].exists) revert LicenseAlreadyDefined(id);
        licenses[id] = License({exists: true, transferable: transferable, revocable: revocable});
        emit LicenseDefined(id, artifactId, tier, transferable, revocable);
    }

    /// Issue a licence. `orderRef` links to the off-chain or marketplace order (opaque).
    function issue(address to, uint256 id, uint256 amount, bytes32 orderRef)
        external
        onlyRole(ISSUER_ROLE)
    {
        if (!licenses[id].exists) revert UnknownLicense(id);
        _mint(to, id, amount, "");
        emit LicenseIssued(id, to, amount, orderRef);
    }

    /// Revoke (burn) a licence, only if it was defined as revocable.
    function revoke(address from, uint256 id, uint256 amount, bytes32 reason)
        external
        onlyRole(PUBLISHER_ROLE)
    {
        if (!licenses[id].exists) revert UnknownLicense(id);
        if (!licenses[id].revocable) revert NotRevocable(id);
        _burn(from, id, amount);
        emit LicenseRevoked(id, from, amount, reason);
    }

    /// Record the manifest digest of an artifact version, once. Provenance only.
    function anchorArtifact(string calldata artifactId, string calldata version, bytes32 digest)
        external
        onlyRole(PUBLISHER_ROLE)
    {
        if (bytes(artifactId).length == 0 || bytes(version).length == 0 || digest == bytes32(0)) {
            revert InvalidIdentifier();
        }
        bytes32 key = anchorKey(artifactId, version);
        if (anchors[key] != bytes32(0)) revert AlreadyAnchored(key);
        anchors[key] = digest;
        emit ArtifactAnchored(key, artifactId, version, digest);
    }

    /// True when `account` holds at least one licence for the tier.
    function hasLicense(address account, string calldata artifactId, string calldata tier)
        external
        view
        returns (bool)
    {
        return balanceOf(account, licenseId(artifactId, tier)) > 0;
    }

    /// Holder-to-holder transfers are allowed only for transferable licences.
    /// Mints (from == 0) and burns (to == 0) are governed by issue() / revoke().
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; ++i) {
                if (!licenses[ids[i]].transferable) revert NotTransferable(ids[i]);
            }
        }
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
