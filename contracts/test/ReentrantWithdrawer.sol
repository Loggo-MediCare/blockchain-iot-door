// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRentalBooking {
    function book(uint256 roomId, uint64 checkIn, uint64 checkOut, address renter) external payable returns (uint256);
    function cancel(uint256 bookingId) external;
    function withdraw() external;
}

// Test-only attacker: books, cancels, then tries to withdraw its refund twice
// by calling withdraw() again from inside receive(). The nested call is wrapped
// in try/catch so the outer withdrawal can still finish, and the reason the
// nested call failed is recorded for the test to inspect.
contract ReentrantWithdrawer {
    IRentalBooking public immutable target;
    uint256 public reentryAttempts;
    uint256 public timesPaid;
    bytes public lastReentryError;

    constructor(address target_) {
        target = IRentalBooking(target_);
    }

    function bookAndCancel(uint256 roomId, uint64 checkIn, uint64 checkOut) external payable {
        uint256 id = target.book{value: msg.value}(roomId, checkIn, checkOut, address(this));
        target.cancel(id);
    }

    function attack() external {
        target.withdraw();
    }

    receive() external payable {
        timesPaid++;
        reentryAttempts++;
        try target.withdraw() {
            // Reaching this line would mean the re-entry was paid out.
        } catch (bytes memory reason) {
            lastReentryError = reason;
        }
    }
}
