// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Based on the "simpleIOT" contract from Mastering Blockchain (4th ed.), ch. 22.
// The book's version only checked a number argument, so anyone could open the
// door for free. Here the renter has to actually pay RENT_PRICE in ether.
contract SimpleIoT {
    uint256 public constant RENT_PRICE = 0.01 ether;
    address public immutable owner;

    event RoomRented(address indexed renter, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    function rent() public payable {
        require(msg.value == RENT_PRICE, "wrong amount");
        emit RoomRented(msg.sender, msg.value);
    }

    // Lets the room owner collect the rent paid into the contract.
    function withdraw() public {
        require(msg.sender == owner, "only owner");
        payable(owner).transfer(address(this).balance);
    }
}
