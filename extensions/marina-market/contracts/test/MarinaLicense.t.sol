// SPDX-License-Identifier: Apache-2.0
// Copyright 2025-2026 H2O.ai, Inc.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {MarinaLicense} from "../src/MarinaLicense.sol";

contract MarinaLicenseTest is Test {
    MarinaLicense internal lic;
    address internal publisher = makeAddr("publisher");
    address internal checkout = makeAddr("checkout");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");

    string internal constant ARTIFACT =
        "marina-world:sha256:0000000000000000000000000000000000000000000000000000000000000001/lab";

    function setUp() public {
        lic = new MarinaLicense(publisher, "");
        vm.startPrank(publisher);
        lic.grantRole(lic.ISSUER_ROLE(), checkout);
        vm.stopPrank();
    }

    function _define(string memory tier, bool transferable, bool revocable)
        internal
        returns (uint256 id)
    {
        vm.prank(publisher);
        id = lic.defineLicense(ARTIFACT, tier, transferable, revocable);
    }

    /// The off-chain id derivation in src/chain/evm.ts must match this exactly.
    function test_licenseIdIsKeccakOfArtifactNulTier() public view {
        uint256 expected = uint256(keccak256(abi.encodePacked(ARTIFACT, bytes1(0), "standard")));
        assertEq(lic.licenseId(ARTIFACT, "standard"), expected);
        assertTrue(lic.licenseId(ARTIFACT, "standard") != lic.licenseId(ARTIFACT, "full"));
    }

    function test_defineIssueAndCheck() public {
        uint256 id = _define("standard", false, true);
        assertFalse(lic.hasLicense(buyer, ARTIFACT, "standard"));
        vm.prank(checkout);
        lic.issue(buyer, id, 1, bytes32("order-1"));
        assertEq(lic.balanceOf(buyer, id), 1);
        assertTrue(lic.hasLicense(buyer, ARTIFACT, "standard"));
        assertFalse(lic.hasLicense(buyer, ARTIFACT, "full"));
    }

    function test_onlyPublisherDefines() public {
        bytes32 role = lic.PUBLISHER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
            )
        );
        lic.defineLicense(ARTIFACT, "standard", false, false);
    }

    function test_onlyIssuerIssues() public {
        uint256 id = _define("standard", false, false);
        vm.prank(stranger);
        vm.expectRevert();
        lic.issue(stranger, id, 1, bytes32(0));
    }

    function test_cannotIssueUndefinedLicense() public {
        uint256 id = lic.licenseId(ARTIFACT, "never-defined");
        vm.prank(checkout);
        vm.expectRevert(abi.encodeWithSelector(MarinaLicense.UnknownLicense.selector, id));
        lic.issue(buyer, id, 1, bytes32(0));
    }

    function test_termsAreImmutable() public {
        uint256 id = _define("standard", false, false);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MarinaLicense.LicenseAlreadyDefined.selector, id));
        lic.defineLicense(ARTIFACT, "standard", true, true);
    }

    function test_nonTransferableLicenceCannotMove() public {
        uint256 id = _define("standard", false, false);
        vm.prank(checkout);
        lic.issue(buyer, id, 1, bytes32(0));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(MarinaLicense.NotTransferable.selector, id));
        lic.safeTransferFrom(buyer, stranger, id, 1, "");
    }

    function test_transferableLicenceMoves() public {
        uint256 id = _define("full", true, false);
        vm.prank(checkout);
        lic.issue(buyer, id, 1, bytes32(0));
        vm.prank(buyer);
        lic.safeTransferFrom(buyer, stranger, id, 1, "");
        assertEq(lic.balanceOf(stranger, id), 1);
        assertEq(lic.balanceOf(buyer, id), 0);
    }

    function test_revokeOnlyWhenRevocable() public {
        uint256 fixedId = _define("standard", false, false);
        uint256 refundable = _define("full", false, true);
        vm.startPrank(checkout);
        lic.issue(buyer, fixedId, 1, bytes32(0));
        lic.issue(buyer, refundable, 1, bytes32(0));
        vm.stopPrank();
        vm.startPrank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MarinaLicense.NotRevocable.selector, fixedId));
        lic.revoke(buyer, fixedId, 1, bytes32("refund"));
        lic.revoke(buyer, refundable, 1, bytes32("refund"));
        vm.stopPrank();
        assertEq(lic.balanceOf(buyer, fixedId), 1);
        assertEq(lic.balanceOf(buyer, refundable), 0);
    }

    function test_anchorIsWriteOnce() public {
        bytes32 digest = sha256("manifest");
        vm.prank(publisher);
        lic.anchorArtifact(ARTIFACT, "1.0.0", digest);
        bytes32 key = lic.anchorKey(ARTIFACT, "1.0.0");
        assertEq(lic.anchors(key), digest);
        bytes32 other = sha256("other"); // precompile call: keep it outside the expectRevert window
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MarinaLicense.AlreadyAnchored.selector, key));
        lic.anchorArtifact(ARTIFACT, "1.0.0", other);
    }

    function test_anchorRejectsEmpty() public {
        vm.prank(publisher);
        vm.expectRevert(MarinaLicense.InvalidIdentifier.selector);
        lic.anchorArtifact(ARTIFACT, "1.0.0", bytes32(0));
    }

    function test_holdsNoFunds() public {
        // No payable function exists: a plain value transfer must fail.
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        (bool ok,) = address(lic).call{value: 1 wei}("");
        assertFalse(ok);
        assertEq(address(lic).balance, 0);
    }

    function test_supportsErc1155AndAccessControl() public view {
        assertTrue(lic.supportsInterface(0xd9b67a26)); // ERC-1155
        assertTrue(lic.supportsInterface(type(IAccessControl).interfaceId));
    }

    function testFuzz_idsAreDistinctPerTier(string calldata a, string calldata b) public view {
        vm.assume(keccak256(bytes(a)) != keccak256(bytes(b)));
        vm.assume(bytes(a).length > 0 && bytes(b).length > 0);
        // NUL is the separator; ids never contain it (Marina refuses NUL in ids).
        for (uint256 i = 0; i < bytes(a).length; ++i) {
            vm.assume(bytes(a)[i] != 0);
        }
        for (uint256 i = 0; i < bytes(b).length; ++i) {
            vm.assume(bytes(b)[i] != 0);
        }
        assertTrue(lic.licenseId(ARTIFACT, a) != lic.licenseId(ARTIFACT, b));
    }
}
