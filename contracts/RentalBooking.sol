// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Booking contract for the NFC + Web3 rental lock (SPEC.md v0.2, section 6).
// Payment alone does not grant access: the gateway asks hasAccess(), which
// requires a Booked booking for that renter whose stay covers the given time.
contract RentalBooking is ReentrancyGuard {
    uint256 public constant NIGHT = 1 days;
    uint256 public constant MAX_BOOKINGS_PER_ROOM = 100;

    enum Status {
        Booked,
        Cancelled,
        CheckedOut
    }

    struct Room {
        uint256 pricePerNight;
        bool active;
    }

    struct Booking {
        address payer; // pays, and receives the refund on cancellation
        address renter; // the wallet that may open the door
        uint256 roomId;
        uint64 checkIn;
        uint64 checkOut;
        uint256 amount;
        Status status;
        bool rentReleased;
    }

    address public immutable owner;
    uint256 public nextBookingId = 1; // 0 is never a valid booking id

    mapping(uint256 => Room) public rooms;
    mapping(uint256 => Booking) private bookings;
    mapping(uint256 => uint256[]) private roomBookingIds;
    mapping(address => uint256) public pendingWithdrawals;

    event RoomSet(uint256 indexed roomId, uint256 pricePerNight, bool active);
    event Booked(
        uint256 indexed bookingId,
        uint256 indexed roomId,
        address indexed renter,
        address payer,
        uint64 checkIn,
        uint64 checkOut,
        uint256 amount
    );
    event Cancelled(uint256 indexed bookingId, address indexed payer, uint256 refund);
    event CheckedOut(uint256 indexed bookingId, address indexed renter);
    event RentReleased(uint256 indexed bookingId, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    error NotOwner();
    error NotPayer();
    error NotRenter();
    error ZeroRenter();
    error RoomInactive();
    error InvalidDates();
    error WrongPayment(uint256 expected, uint256 sent);
    error Overlap(uint256 existingBookingId);
    error RoomFull();
    error UnknownBooking();
    error NotBooked();
    error TooLateToCancel();
    error NotDuringStay();
    error RentNotDue();
    error RentAlreadyReleased();
    error NothingToWithdraw();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setRoom(uint256 roomId, uint256 pricePerNight, bool active) external onlyOwner {
        rooms[roomId] = Room(pricePerNight, active);
        emit RoomSet(roomId, pricePerNight, active);
    }

    // Front ends pass msg.sender as renter when the payer is also the guest.
    function book(uint256 roomId, uint64 checkInTime, uint64 checkOutTime, address renter)
        external
        payable
        returns (uint256 bookingId)
    {
        if (renter == address(0)) revert ZeroRenter();
        Room memory room = rooms[roomId];
        if (!room.active || room.pricePerNight == 0) revert RoomInactive();
        if (checkInTime <= block.timestamp || checkOutTime <= checkInTime || (checkOutTime - checkInTime) % NIGHT != 0) {
            revert InvalidDates();
        }
        uint256 expected = ((checkOutTime - checkInTime) / NIGHT) * room.pricePerNight;
        if (msg.value != expected) revert WrongPayment(expected, msg.value);

        uint256[] storage ids = roomBookingIds[roomId];
        if (ids.length >= MAX_BOOKINGS_PER_ROOM) revert RoomFull();
        // Occupancy: every booking that is not cancelled holds its dates,
        // including ones checked out early (SPEC 6.2).
        for (uint256 i = 0; i < ids.length; i++) {
            Booking storage other = bookings[ids[i]];
            if (other.status != Status.Cancelled && checkInTime < other.checkOut && other.checkIn < checkOutTime) {
                revert Overlap(ids[i]);
            }
        }

        bookingId = nextBookingId++;
        bookings[bookingId] = Booking(msg.sender, renter, roomId, checkInTime, checkOutTime, msg.value, Status.Booked, false);
        ids.push(bookingId);
        emit Booked(bookingId, roomId, renter, msg.sender, checkInTime, checkOutTime, msg.value);
    }

    function cancel(uint256 bookingId) external {
        Booking storage b = _existing(bookingId);
        if (msg.sender != b.payer) revert NotPayer();
        if (b.status != Status.Booked) revert NotBooked();
        if (block.timestamp >= b.checkIn) revert TooLateToCancel();
        b.status = Status.Cancelled;
        pendingWithdrawals[b.payer] += b.amount;
        emit Cancelled(bookingId, b.payer, b.amount);
    }

    // Only the renter can end a stay early; the owner cannot (SPEC 6.4).
    function checkOut(uint256 bookingId) external {
        Booking storage b = _existing(bookingId);
        if (msg.sender != b.renter) revert NotRenter();
        if (b.status != Status.Booked) revert NotBooked();
        if (block.timestamp < b.checkIn || block.timestamp >= b.checkOut) revert NotDuringStay();
        b.status = Status.CheckedOut;
        emit CheckedOut(bookingId, b.renter);
    }

    // Anyone may trigger this once the stay has started; the rent goes to the owner.
    function releaseRent(uint256 bookingId) external {
        Booking storage b = _existing(bookingId);
        if (b.status == Status.Cancelled) revert NotBooked();
        if (block.timestamp < b.checkIn) revert RentNotDue();
        if (b.rentReleased) revert RentAlreadyReleased();
        b.rentReleased = true;
        pendingWithdrawals[owner] += b.amount;
        emit RentReleased(bookingId, b.amount);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // Gateway check (SPEC 6.2 "access"): Booked, renter matches, time inside [checkIn, checkOut).
    function hasAccess(uint256 roomId, address wallet, uint256 time) external view returns (bool) {
        uint256[] storage ids = roomBookingIds[roomId];
        for (uint256 i = 0; i < ids.length; i++) {
            Booking storage b = bookings[ids[i]];
            if (b.status == Status.Booked && b.renter == wallet && b.checkIn <= time && time < b.checkOut) {
                return true;
            }
        }
        return false;
    }

    function getBooking(uint256 bookingId) external view returns (Booking memory) {
        return _existing(bookingId);
    }

    function getRoomBookingIds(uint256 roomId) external view returns (uint256[] memory) {
        return roomBookingIds[roomId];
    }

    function _existing(uint256 bookingId) private view returns (Booking storage b) {
        b = bookings[bookingId];
        if (b.renter == address(0)) revert UnknownBooking();
    }
}
